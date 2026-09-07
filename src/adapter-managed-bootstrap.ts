import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { GjcRuntimeLocations } from "./contracts";
import {
	createManagedLifecycleEvidence,
	type ManagedLifecycleEvidence,
	managedLifecycleEvidenceHash,
	transitionManagedLifecycleEvidence,
} from "./gjc/managed-lifecycle-evidence";
import { ManagedOperationDeadline } from "./gjc/managed-operation-deadline";
import {
	type ManagedSdkAttachment,
	type ManagedSdkHistoricalSelection,
	ManagedSdkRuntime,
	type ManagedSdkRuntimeDeps,
	type TenantSessionKey,
} from "./gjc/managed-sdk-runtime";
import { AuthorityMutationLock } from "./gjc/session-authority-file";
import type { HistoricalSessionBinding } from "./gjc/session-authority-types";
import type {
	SessionAuthorityV3Operation,
	SessionAuthorityV3Reassignment,
	SessionAuthorityV3Tombstone,
} from "./gjc/session-authority-v3";
import {
	type SessionAuthorityV3ActivationResult,
	type SessionAuthorityV3BootstrapContext,
	startSessionAuthorityV3Activation,
} from "./gjc/session-authority-v3-activation";
import { V3FileBackedSessionMappingStore } from "./gjc/session-v3-file-backed-mapping-store";
import type { ManagedPreparedTurnAuthority } from "./gjc/turn-runner";
import type { RegisteredProject } from "./projects/registry";
import type { RuntimeSingletonLock } from "./runtime-singleton-lock";

export interface ManagedBootstrapAuthority {
	readonly project: RegisteredProject;
	readonly canonicalWorkspace: string;
	readonly leaseId: string;
	readonly epoch: string;
	assertFence(): Promise<void> | void;
	/** Non-yielding final check of the same owned lease, including expiry/revocation. */
	assertCurrent(): void;
}

/** Resolves existing owned authority; it must not create a workspace or lease. */
export interface ManagedBootstrapAuthorityResolver {
	resolve(principalId: string, projectId: string): Promise<ManagedBootstrapAuthority | undefined>;
}

export interface ManagedBootstrapCandidate {
	readonly source: HistoricalSessionBinding;
	readonly principalId: string;
	readonly chatId: string;
	readonly projectId: string;
	readonly retainedIntent?: SessionAuthorityV3Operation;
}

/** Owns acquisitions before admit starts, including outcomes arriving after timeout. */
export interface ManagedBootstrapAdmission {
	admit(input: {
		readonly manifestDigest: string;
		readonly candidates: readonly ManagedBootstrapCandidate[];
		readonly signal: AbortSignal;
		remaining(): number;
		assertCurrent(): Promise<void>;
	}): Promise<void>;
	/** Closes admission and accounts for every attempted acquisition without replacing its identity. */
	release(): Promise<void>;
}

export interface AdapterManagedBootstrapInput {
	readonly locations: Pick<GjcRuntimeLocations, "agentDir"> & Readonly<{ stateRoot: string }>;
	readonly configuredOwnerUserId: string;
	readonly sourcePath: string;
	readonly runtimeLock: RuntimeSingletonLock;
	readonly authority: ManagedBootstrapAuthorityResolver;
	readonly admission?: ManagedBootstrapAdmission;
	readonly timeoutMs?: number;
	/** Transport test seam; the coordinator always supplies the production purpose fences. */
	readonly createRuntime?: (agentDir: string, deps: ManagedSdkRuntimeDeps) => ManagedSdkRuntime;
}

export type AdapterSessionAuthorityV3Activation =
	| Readonly<{ status: "blocked"; activation: SessionAuthorityV3ActivationResult }>
	| Readonly<{
			status: "activated";
			activation: SessionAuthorityV3ActivationResult;
			store: V3FileBackedSessionMappingStore;
	  }>;

interface BootstrapTarget {
	readonly source: HistoricalSessionBinding;
	readonly prepared: ManagedPreparedTurnAuthority;
	readonly operationId: string;
}

export interface AdapterManagedBootstrapAttempt {
	/** Bounded operation outcome; rejection alone is not proof of cleanup. */
	readonly result: Promise<AdapterSessionAuthorityV3Activation>;
	/** Resolves only after stop and owned resource cleanup; failure retains exclusion locks. */
	readonly settled: Promise<void>;
}

/** The caller retains runtime ownership until settled succeeds, even when result times out. */
export function startAdapterSessionAuthorityV3Activation(
	input: AdapterManagedBootstrapInput,
): AdapterManagedBootstrapAttempt {
	const authority = input.authority;
	const admission = input.admission;
	input = Object.freeze({
		...input,
		locations: Object.freeze({ ...input.locations }),
		authority: Object.freeze({ resolve: authority.resolve.bind(authority) }),
		...(admission === undefined
			? {}
			: {
					admission: Object.freeze({
						admit: admission.admit.bind(admission),
						release: admission.release.bind(admission),
					}),
				}),
		...(input.createRuntime === undefined ? {} : { createRuntime: input.createRuntime.bind(input) }),
	});
	for (const path of [input.locations.agentDir, input.locations.stateRoot, input.sourcePath])
		if (!isAbsolute(path) || resolve(path) !== path)
			throw new TypeError("Bootstrap paths must be canonical absolute paths.");
	const deadline = new ManagedOperationDeadline(input.timeoutMs, "adapter authority bootstrap");
	const completion = Promise.withResolvers<void>();
	const result = activate(input, deadline, completion.resolve, completion.reject);
	void result.catch(() => undefined);
	void completion.promise.catch(() => undefined);
	return Object.freeze({ result, settled: completion.promise });
}

async function activate(
	input: AdapterManagedBootstrapInput,
	deadline: ManagedOperationDeadline,
	settled: () => void,
	cleanupFailed: (error: unknown) => void,
): Promise<AdapterSessionAuthorityV3Activation> {
	const producers = new Set<Promise<unknown>>();
	let closing = false;
	const step = <T>(action: () => Promise<T>): Promise<T> => {
		deadline.remaining();
		if (closing) throw new Error("Bootstrap work is closed.");
		const work = action();
		producers.add(work);
		void work.then(
			() => producers.delete(work),
			() => producers.delete(work),
		);
		return deadline.wait(work);
	};
	let runtime: ManagedSdkRuntime | undefined;
	let store: V3FileBackedSessionMappingStore | undefined;
	let context: SessionAuthorityV3BootstrapContext | undefined;
	let lock: AuthorityMutationLock | undefined;
	const admissionController = new AbortController();
	let admissionWork: Promise<void> | undefined;
	let activationWork: ReturnType<typeof startSessionAuthorityV3Activation> | undefined;
	const targets = new Map<string, BootstrapTarget>();
	const invoking = new Set<string>();
	const consumed = new Set<string>();
	const proven = new Map<string, { prepared: ManagedPreparedTurnAuthority; attachment: ManagedSdkAttachment }>();
	const commitAuthorities = new Map<string, ManagedBootstrapAuthority>();
	const failures: unknown[] = [];
	let result: AdapterSessionAuthorityV3Activation | undefined;

	const currentAuthority = async (prepared: ManagedPreparedTurnAuthority): Promise<boolean> => {
		const authority = await step(() => input.authority.resolve(prepared.principalId, prepared.projectId));
		if (
			authority === undefined ||
			authority.project.id !== prepared.projectId ||
			authority.project.cwd !== prepared.canonicalWorkspace ||
			authority.canonicalWorkspace !== prepared.canonicalWorkspace ||
			authority.leaseId !== prepared.leaseId ||
			authority.epoch !== prepared.epoch ||
			typeof authority.assertCurrent !== "function"
		)
			return false;
		await step(async () => await authority.assertFence());
		commitAuthorities.set(prepared.requestKey, authority);
		return true;
	};
	const operationFor = (id: string): SessionAuthorityV3Operation | undefined => {
		const target = targets.get(id);
		if (target === undefined || context === undefined) return undefined;
		let found: SessionAuthorityV3Operation | undefined;
		for (const record of context.stage.read().mappings)
			for (const operation of record.journal) {
				if (
					operation.id !== id ||
					!isDeepStrictEqual(operation.lifecycle?.historicalSource?.historicalBinding, target.source)
				)
					continue;
				if (found !== undefined) return undefined;
				found = operation;
			}
		return found;
	};
	const preparedFence = async (evidence: ManagedLifecycleEvidence): Promise<boolean> => {
		const source = evidence.historicalSource;
		if (context === undefined || source === undefined || source.manifestDigest !== context.manifestDigest)
			return false;
		const target = [...targets.values()].find(item => isDeepStrictEqual(item.source, source.historicalBinding));
		if (target === undefined || !isDeepStrictEqual(target.prepared, evidence.preparedAuthority)) return false;
		await step(() => context!.assertCurrent());
		return currentAuthority(evidence.preparedAuthority);
	};
	const createRuntime = () => {
		const deps: ManagedSdkRuntimeDeps = {
			drainTimeoutMs: deadline.remaining(),
			historicalSelectionFence: async selection => {
				if (context === undefined || selection.manifestDigest !== context.manifestDigest) return false;
				const target = [...targets.values()].find(item =>
					isDeepStrictEqual(item.source, selection.historicalBinding),
				);
				if (target === undefined || !isDeepStrictEqual(target.prepared, selection.preparedAuthority)) return false;
				await step(() => context!.assertCurrent());
				return currentAuthority(target.prepared);
			},
			historicalResumeFence: async (id, evidence) => {
				if (
					!invoking.has(id) ||
					consumed.has(id) ||
					!isDeepStrictEqual(operationFor(id)?.lifecycle, evidence) ||
					!(await preparedFence(evidence))
				)
					return false;
				if (!invoking.has(id) || consumed.has(id) || !isDeepStrictEqual(operationFor(id)?.lifecycle, evidence))
					return false;
				consumed.add(id);
				return true;
			},
			tenantFence: async (key, access) => {
				if (access.kind !== "adoption-proof" || context === undefined) return false;
				const evidence = operationFor(access.operationId)?.lifecycle;
				return (
					evidence?.state === "acknowledged_unproven" &&
					evidence.requestKey === access.requestKey &&
					evidence.payloadHash === access.payloadHash &&
					sameTenant(evidence.acknowledged, key) &&
					(await preparedFence(evidence))
				);
			},
		};
		return (
			input.createRuntime ?? ((agentDir, dependencies) => new ManagedSdkRuntime({ agentDir, deps: dependencies }))
		)(input.locations.agentDir, deps);
	};

	try {
		await step(() => input.runtimeLock.assertOwnsPath(input.sourcePath));
		lock = AuthorityMutationLock.acquire(input.sourcePath, deadline.remaining());
		await step(() =>
			ensureLegacySource(input.sourcePath, () => {
				deadline.remaining();
				if (closing) throw new Error("Bootstrap work is closed.");
				lock!.assertHeld(input.sourcePath);
			}),
		);
		const activation = await step(() => {
			activationWork = startSessionAuthorityV3Activation({
				canonicalPath: input.sourcePath,
				runtimeLock: input.runtimeLock,
				mutationLock: lock!,
				stagingRoot: input.locations.stateRoot,
				timeoutMs: deadline.remaining(),
				bootstrapTenantFence: preparedFence,
				beforeBootstrapCommit: async () => {
					if (proven.size !== targets.size)
						throw new Error("Bootstrap commit requires this attempt's complete public proofs.");
					if (runtime !== undefined) await step(() => runtime!.reconcile(deadline.remaining()));
					for (const proof of proven.values()) {
						if (!(await currentAuthority(proof.prepared)))
							throw new Error("Bootstrap generation or lease changed before canonical commit.");
					}
					return () => {
						deadline.remaining();
						for (const proof of proven.values()) {
							commitAuthorities.get(proof.prepared.requestKey)!.assertCurrent();
							if (!proof.attachment.isCurrent())
								throw new Error("Bootstrap attachment changed at canonical replacement.");
						}
					};
				},
				bootstrap: async current => {
					context = current;
					const graph = current.stage.read();
					if (graph.provisionalOperations.some(operation => operation.state !== "complete")) return;
					const sessionIds = new Set<string>();
					const destinations = new Set<string>();
					const candidates: ManagedBootstrapCandidate[] = [];
					// Check the entire graph before admission can acquire any resource.
					for (const mapping of graph.mappings) {
						if (mapping.historicalBinding === undefined) {
							// An earlier process's numeric generation cannot prove its original
							// incarnation after restart (#5356). No new resume key or cached replay.
							throw new Error("Retained managed bootstrap proof requires original-incarnation recovery.");
						}
						const source = mapping.historicalBinding;
						const scope = historicalScope(source, input.configuredOwnerUserId);
						if (
							scope === undefined ||
							hasUnresolvedReassignment(mapping.reassignment) ||
							mapping.observations?.__gjcSessionMappingRetirement !== undefined
						)
							return;
						const destination = JSON.stringify([scope.principalId, scope.chatId]);
						if (
							destinations.has(destination) ||
							graph.mappings.some(item => item !== mapping && item.chatId === destination) ||
							(destination !== mapping.chatId &&
								graph.provisionalOperations.some(item => item.chatId === destination))
						)
							return;
						destinations.add(destination);
						if (sessionIds.has(mapping.sessionId)) return;
						sessionIds.add(mapping.sessionId);
						const previous = mapping.journal.find(
							operation => operation.lifecycle?.historicalSource !== undefined,
						);
						if (previous !== undefined && previous.lifecycle?.state !== "intent_prepared") return;
						candidates.push({
							source,
							...scope,
							projectId: mapping.projectId,
							...(previous === undefined ? {} : { retainedIntent: previous }),
						});
					}
					if (candidates.length > 0 && input.admission !== undefined) {
						deadline.remaining();
						admissionWork = Promise.resolve().then(() => {
							deadline.remaining();
							return input.admission!.admit({
								manifestDigest: current.manifestDigest,
								candidates: structuredClone(candidates),
								signal: admissionController.signal,
								remaining: () => deadline.remaining(),
								assertCurrent: current.assertCurrent,
							});
						});
						await deadline.wait(admissionWork);
					}
					for (const candidate of candidates) {
						const { source, projectId, retainedIntent: previous } = candidate;
						const scope = { principalId: candidate.principalId, chatId: candidate.chatId };
						const authority = await step(() => input.authority.resolve(scope.principalId, projectId));
						if (
							authority === undefined ||
							authority.project.id !== projectId ||
							!exactScopeString(authority.leaseId) ||
							!exactScopeString(authority.epoch) ||
							typeof authority.assertCurrent !== "function" ||
							!isAbsolute(authority.canonicalWorkspace) ||
							resolve(authority.canonicalWorkspace) !== authority.canonicalWorkspace ||
							authority.project.cwd !== authority.canonicalWorkspace ||
							(source.canonicalWorkspace !== undefined &&
								source.canonicalWorkspace !== authority.canonicalWorkspace)
						)
							return;
						await step(async () => await authority.assertFence());
						const identity = hash(
							JSON.stringify([
								current.manifestDigest,
								source.provenance,
								scope,
								projectId,
								authority.canonicalWorkspace,
								source.sessionId,
							]),
						);
						const prepared: ManagedPreparedTurnAuthority = previous?.lifecycle?.preparedAuthority ?? {
							...scope,
							projectId,
							canonicalWorkspace: authority.canonicalWorkspace,
							leaseId: authority.leaseId,
							epoch: authority.epoch,
							requestKey: `migration:resume:${identity}`,
						};
						// Receipt identity is immutable; a new lease cannot rewrite an old attempt.
						if (
							prepared.principalId !== scope.principalId ||
							prepared.chatId !== scope.chatId ||
							!(await currentAuthority(prepared))
						)
							return;
						targets.set(previous?.id ?? `migration:resume:${identity}`, {
							source,
							prepared,
							operationId: previous?.id ?? `migration:resume:${identity}`,
						});
					}
					runtime = createRuntime();
					await step(() => runtime!.start());
					for (const target of targets.values()) {
						let evidence = operationFor(target.operationId)?.lifecycle;
						if (evidence === undefined) {
							const selection: ManagedSdkHistoricalSelection = {
								manifestDigest: current.manifestDigest,
								historicalBinding: target.source,
								preparedAuthority: target.prepared,
							};
							const savedSession = await step(() =>
								runtime!.selectHistoricalSession(selection, deadline.remaining()),
							);
							const { dev, ino, size, mtimeMs, mtimeNs, sha256 } = savedSession.identity;
							evidence = createManagedLifecycleEvidence({
								operation: "session.resume",
								preparedAuthority: target.prepared,
								historicalSource: {
									kind: "bootstrap-history",
									manifestDigest: current.manifestDigest,
									historicalBinding: target.source,
									savedSession,
								},
								payloadHash: hash(JSON.stringify([target.operationId, target.source, savedSession])),
								target: {
									sessionId: savedSession.id,
									cwd: target.prepared.canonicalWorkspace,
									sessionPath: savedSession.path,
									sessionIdentity: { dev, ino, size, mtimeMs, mtimeNs, sha256 },
								},
							});
							await step(() => current.stage.begin(target.operationId, evidence!));
						}
						const dispatched = transitionManagedLifecycleEvidence(evidence, "invoking");
						const invocation = await step(() =>
							current.stage.advance(target.operationId, managedLifecycleEvidenceHash(evidence!), dispatched),
						);
						const scope = runtime!.createProducerScope();
						const receipt = current.stage.retainInvocation(invocation);
						let ack: ManagedLifecycleEvidence | undefined;
						invoking.add(target.operationId);
						try {
							await step(() =>
								scope.run(() =>
									runtime!.resumeHistoricalSession(
										target.operationId,
										dispatched,
										outcome => {
											const valid =
												outcome.ok === true &&
												outcome.operation === "session.resume" &&
												outcome.result.sessionId ===
													dispatched.historicalSource!.historicalBinding.sessionId &&
												Number.isSafeInteger(outcome.result.endpointGeneration) &&
												outcome.result.endpointGeneration! > 0;
											const observed = receipt.observe(
												valid
													? {
															sessionId: outcome.result.sessionId,
															generation: outcome.result.endpointGeneration!,
														}
													: undefined,
											);
											if (valid) ack = observed;
										},
										deadline.remaining(),
									),
								),
							);
							if (ack?.acknowledged === undefined)
								throw new Error(
									"Historical resume did not acknowledge the exact session and positive generation.",
								);
							const acknowledgedEvidence = ack;
							const acknowledged = ack.acknowledged;
							const key = tenant(acknowledged);
							const attachment = await step(() =>
								runtime!.proveLifecycleTenant(
									key,
									{
										operationId: target.operationId,
										requestKey: acknowledgedEvidence.requestKey,
										payloadHash: acknowledgedEvidence.payloadHash,
									},
									deadline.remaining(),
								),
							);
							if (
								!attachment.isCurrent() ||
								attachment.generation !== acknowledged.generation ||
								!(await preparedFence(ack))
							)
								throw new Error("Historical bootstrap lost its exact adoption proof.");
							const active = transitionManagedLifecycleEvidence(ack, "active_generation_proven", {
								proven: {
									kind: "managed-generation",
									sessionId: acknowledged.sessionId,
									generation: acknowledged.generation,
									leaseId: acknowledged.leaseId,
									epoch: acknowledged.epoch,
								},
							});
							await step(() =>
								current.stage.advance(
									target.operationId,
									managedLifecycleEvidenceHash(acknowledgedEvidence),
									active,
								),
							);
							await step(() =>
								current.stage.promote(target.operationId, managedLifecycleEvidenceHash(active), active),
							);
							proven.set(target.operationId, { prepared: target.prepared, attachment });
						} finally {
							invoking.delete(target.operationId);
							// Passive finalization stays below all result races and retains the stage until raw work ends.
							try {
								await scope.seal();
							} finally {
								receipt.finish();
							}
						}
					}
				},
			});
			return activationWork.result;
		});
		context = undefined;
		if (activation.status === "blocked") result = { status: "blocked", activation };
		else {
			store = new V3FileBackedSessionMappingStore(input.sourcePath, lock);
			result = { status: "activated", activation, store };
		}
	} catch (error) {
		failures.push(error);
	} finally {
		closing = true;
		context = undefined;
		admissionController.abort();
		// Retain raw work, not just its deadline race, before releasing either owner.
		const shutdown = Promise.resolve().then(() => runtime?.dispose());
		const cleanup = (async () => {
			await Promise.all([shutdown, admissionWork?.catch(() => undefined), activationWork?.settled]);
			while (producers.size > 0) await Promise.allSettled([...producers]);
			if (runtime !== undefined && runtime.state !== "stopped")
				throw new Error("Bootstrap shutdown is unproven; mutation ownership remains held.");
			if (admissionWork !== undefined) await input.admission!.release();
			lock?.release();
		})();
		void cleanup.then(settled, cleanupFailed);
		try {
			await deadline.wait(cleanup);
		} catch (error) {
			if (!failures.includes(error)) failures.push(error);
		}
		if (result?.status !== "activated" || failures.length > 0) {
			try {
				store?.close();
			} catch (error) {
				failures.push(error);
			}
		}
		if (runtime !== undefined && runtime.state !== "stopped") {
			failures.push(new Error("Bootstrap shutdown is unproven; mutation ownership remains held."));
		}
		deadline.close();
	}
	if (failures.length > 0) throw new AggregateError(failures, "Managed historical bootstrap failed.");
	if (result === undefined) throw new Error("Managed historical bootstrap produced no result.");
	return result;
}

function hasUnresolvedReassignment(reassignment: SessionAuthorityV3Reassignment | undefined): boolean {
	if (reassignment === undefined) return false;
	if (reassignment.state === "pending" || reassignment.completedAt === undefined) return true;
	for (const root of [reassignment.sourceTombstone, reassignment.priorTombstone]) {
		for (let node: SessionAuthorityV3Tombstone | undefined = root; node !== undefined; node = node.prior) {
			if (node.journal.some(operation => operation.state !== "complete")) return true;
		}
	}
	return false;
}

function historicalScope(
	source: HistoricalSessionBinding,
	configuredOwner: string,
): { principalId: string; chatId: string } | undefined {
	if (source.sessionId === undefined) return undefined;
	try {
		const key: unknown = JSON.parse(source.chatId);
		if (Array.isArray(key)) {
			if (
				key.length !== 2 ||
				!key.every(exactScopeString) ||
				JSON.stringify(key) !== source.chatId ||
				source.principalId !== key[0]
			)
				return undefined;
			return { principalId: key[0], chatId: key[1] };
		}
	} catch {
		// Plain legacy chat IDs are not JSON tuples.
	}
	const principalId = source.principalId ?? configuredOwner;
	return exactScopeString(principalId) && exactScopeString(source.chatId)
		? { principalId, chatId: source.chatId }
		: undefined;
}
function exactScopeString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\p{Cc}]/u.test(value);
}
function tenant(value: ManagedPreparedTurnAuthority & { sessionId: string; generation: number }): TenantSessionKey {
	const { requestKey: _requestKey, ...key } = value;
	return key;
}
function sameTenant(value: unknown, key: TenantSessionKey): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.entries(key).every(([field, expected]) => Reflect.get(value, field) === expected)
	);
}
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
async function ensureLegacySource(path: string, assertCurrent: () => void): Promise<void> {
	try {
		await lstat(path);
		return;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	assertCurrent();
	await mkdir(dirname(path), { recursive: true });
	assertCurrent();
	await writeFile(path, '{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n', {
		flag: "wx",
		mode: 0o600,
	});
}
