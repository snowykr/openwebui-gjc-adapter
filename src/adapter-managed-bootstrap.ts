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
import type { SessionAuthorityV3Operation } from "./gjc/session-authority-v3";
import {
	activateSessionAuthorityV3,
	type SessionAuthorityV3ActivationResult,
	type SessionAuthorityV3BootstrapContext,
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

export interface AdapterManagedBootstrapInput {
	readonly locations: Pick<GjcRuntimeLocations, "agentDir"> & Readonly<{ stateRoot: string }>;
	readonly configuredOwnerUserId: string;
	readonly sourcePath: string;
	readonly runtimeLock: RuntimeSingletonLock;
	readonly authority: ManagedBootstrapAuthorityResolver;
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

/** Restricted activation owns its Router, stage capabilities and one-time invocation admission. */
export async function activateAdapterSessionAuthorityV3(
	input: AdapterManagedBootstrapInput,
): Promise<AdapterSessionAuthorityV3Activation> {
	for (const path of [input.locations.agentDir, input.locations.stateRoot, input.sourcePath])
		if (!isAbsolute(path) || resolve(path) !== path)
			throw new TypeError("Bootstrap paths must be canonical absolute paths.");
	const deadline = new ManagedOperationDeadline(input.timeoutMs, "adapter authority bootstrap");
	const step = <T>(action: () => Promise<T>): Promise<T> => {
		deadline.remaining();
		return deadline.wait(action());
	};
	let runtime: ManagedSdkRuntime | undefined;
	let store: V3FileBackedSessionMappingStore | undefined;
	let context: SessionAuthorityV3BootstrapContext | undefined;
	let lock: AuthorityMutationLock | undefined;
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
		return target === undefined
			? undefined
			: context?.stage
					.read()
					.mappings.find(record => record.chatId === target.source.chatId)
					?.journal.find(operation => operation.id === id);
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
		lock = AuthorityMutationLock.acquire(input.sourcePath);
		await step(() => ensureLegacySource(input.sourcePath));
		const activation = await step(() =>
			activateSessionAuthorityV3({
				canonicalPath: input.sourcePath,
				runtimeLock: input.runtimeLock,
				mutationLock: lock!,
				stagingRoot: input.locations.stateRoot,
				timeoutMs: deadline.remaining(),
				bootstrapTenantFence: preparedFence,
				beforeBootstrapCommit: async () => {
					if (proven.size !== targets.size)
						throw new Error("Bootstrap commit requires this attempt's complete public proofs.");
					if (runtime !== undefined) await step(() => runtime!.reconcile());
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
					if (
						graph.provisionalOperations.some(
							operation => operation.historicalBinding !== undefined && operation.state !== "complete",
						)
					)
						return;
					const sessionIds = new Set<string>();
					// Complete all local source/owner checks before constructing the public runtime.
					for (const mapping of graph.mappings) {
						if (mapping.historicalBinding === undefined) {
							// An earlier process's numeric generation cannot prove its original
							// incarnation after restart (#5356). No new resume key or cached replay.
							throw new Error("Retained managed bootstrap proof requires original-incarnation recovery.");
						}
						const source = mapping.historicalBinding;
						const scope = historicalScope(source);
						if (
							scope === undefined ||
							mapping.reassignment !== undefined ||
							mapping.observations?.__gjcSessionMappingRetirement !== undefined
						)
							return;
						if (sessionIds.has(mapping.sessionId)) return;
						sessionIds.add(mapping.sessionId);
						const previous = mapping.journal.find(
							operation => operation.lifecycle?.historicalSource !== undefined,
						);
						if (previous !== undefined && previous.lifecycle?.state !== "intent_prepared") return;
						const authority = await step(() => input.authority.resolve(scope.principalId, mapping.projectId));
						if (
							authority === undefined ||
							authority.project.id !== mapping.projectId ||
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
								mapping.projectId,
								authority.canonicalWorkspace,
								source.sessionId,
							]),
						);
						const prepared: ManagedPreparedTurnAuthority = previous?.lifecycle?.preparedAuthority ?? {
							...scope,
							projectId: mapping.projectId,
							canonicalWorkspace: authority.canonicalWorkspace,
							leaseId: authority.leaseId,
							epoch: authority.epoch,
							requestKey: `migration:resume:${identity}`,
						};
						// Receipt identity is immutable; a new lease cannot rewrite an old attempt.
						if (!(await currentAuthority(prepared))) return;
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
						await step(() =>
							current.stage.advance(target.operationId, managedLifecycleEvidenceHash(evidence!), dispatched),
						);
						invoking.add(target.operationId);
						try {
							const outcome = await step(() =>
								runtime!.resumeHistoricalSession(target.operationId, dispatched, deadline.remaining()),
							);
							if (
								!outcome.ok ||
								outcome.operation !== "session.resume" ||
								outcome.result.sessionId !== target.source.sessionId ||
								!Number.isSafeInteger(outcome.result.endpointGeneration) ||
								outcome.result.endpointGeneration! <= 0
							)
								throw new Error(
									"Historical resume did not acknowledge the exact session and positive generation.",
								);
							const acknowledged = {
								...target.prepared,
								sessionId: outcome.result.sessionId,
								generation: outcome.result.endpointGeneration!,
							};
							const ack = transitionManagedLifecycleEvidence(dispatched, "acknowledged_unproven", {
								acknowledged,
							});
							// No resolve, registration, proof, or fresh external fence precedes this write.
							await step(() =>
								current.stage.advance(target.operationId, managedLifecycleEvidenceHash(dispatched), ack),
							);
							const key = tenant(acknowledged);
							const attachment = await step(() =>
								runtime!.proveLifecycleTenant(key, {
									operationId: target.operationId,
									requestKey: ack.requestKey,
									payloadHash: ack.payloadHash,
								}),
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
								current.stage.advance(target.operationId, managedLifecycleEvidenceHash(ack), active),
							);
							await step(() =>
								current.stage.promote(target.operationId, managedLifecycleEvidenceHash(active), active),
							);
							proven.set(target.operationId, { prepared: target.prepared, attachment });
						} catch (error) {
							const retained = operationFor(target.operationId)?.lifecycle;
							if (retained?.state === "invoking" || retained?.state === "acknowledged_unproven") {
								try {
									const uncertain = transitionManagedLifecycleEvidence(retained, "uncertain");
									await step(() =>
										current.stage.advance(
											target.operationId,
											managedLifecycleEvidenceHash(retained),
											uncertain,
										),
									);
								} catch (persistenceError) {
									throw new AggregateError(
										[error, persistenceError],
										"Bootstrap failure and uncertainty persistence failed.",
									);
								}
							}
							throw error;
						} finally {
							invoking.delete(target.operationId);
						}
					}
				},
			}),
		);
		context = undefined;
		if (activation.status === "blocked") result = { status: "blocked", activation };
		else {
			store = new V3FileBackedSessionMappingStore(input.sourcePath, lock);
			store.setLegacyAdminPrincipalId(input.configuredOwnerUserId);
			result = { status: "activated", activation, store };
		}
	} catch (error) {
		failures.push(error);
	} finally {
		context = undefined;
		// No bootstrap attachment or purpose grant crosses the serving boundary.
		let shutdown: Promise<void> | undefined;
		try {
			shutdown = runtime?.dispose();
			if (shutdown !== undefined) await deadline.wait(shutdown);
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
			// An expired wait is not a shutdown receipt. Keep the owned mutation
			// lease in place rather than allowing another attempt to overlap it.
			failures.push(new Error("Bootstrap shutdown is unproven; mutation ownership remains held."));
			const heldLock = lock;
			if (shutdown !== undefined)
				void shutdown.then(
					() => {
						if (runtime?.state === "stopped") {
							try {
								heldLock?.release();
							} catch (error) {
								console.error("Bootstrap shutdown completed but mutation ownership release failed:", error);
							}
						}
					},
					() => {
						/* Failure is retained by the caller; no unproven lock release. */
					},
				);
		} else {
			try {
				lock?.release();
			} catch (error) {
				failures.push(error);
			}
		}
		deadline.close();
	}
	if (failures.length > 0) throw new AggregateError(failures, "Managed historical bootstrap failed.");
	if (result === undefined) throw new Error("Managed historical bootstrap produced no result.");
	return result;
}

function historicalScope(source: HistoricalSessionBinding): { principalId: string; chatId: string } | undefined {
	if (source.sessionId === undefined) return undefined;
	try {
		const key: unknown = JSON.parse(source.chatId);
		if (
			Array.isArray(key) &&
			key.length === 2 &&
			key.every(value => typeof value === "string" && value.length > 0) &&
			JSON.stringify(key) === source.chatId &&
			source.principalId === key[0]
		)
			return { principalId: key[0], chatId: key[1] };
	} catch {
		/* An unscoped source must first receive an explicit tenant-scoped history binding. */
	}
	// Do not silently re-key a historical graph or infer ownership from session paths.
	return undefined;
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
async function ensureLegacySource(path: string): Promise<void> {
	try {
		await lstat(path);
		return;
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, '{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n', {
		flag: "wx",
		mode: 0o600,
	});
}
