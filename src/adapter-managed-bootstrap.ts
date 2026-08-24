import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { type ActiveManagedV3Runtime, startActiveManagedRuntime } from "./adapter-managed-v3-runtime";
import type { GjcRuntimeLocations } from "./contracts";
import type {
	ManagedAuthorityLifecycleOutcome,
	ManagedAuthorityPreparedRebindIntent,
} from "./gjc/managed-authority-activation";
import {
	type ManagedBootstrapOptions,
	ManagedBootstrapService,
	type ManagedBootstrapStartResult,
} from "./gjc/managed-bootstrap";
import type { ManagedSdkRuntime, TenantSessionKey } from "./gjc/managed-sdk-runtime";
import type { LegacyManagedSessionAuthorityEvidence } from "./gjc/managed-session-authority";
import type {
	ProvisionalSessionOperation,
	SessionAuthorityRecord,
	SessionAuthorityTombstone,
} from "./gjc/session-authority";
import {
	activateSessionAuthorityV3,
	type SessionAuthorityV3ActivationResult,
} from "./gjc/session-authority-v3-activation";
import type { ManagedTurnAuthorityBinding } from "./gjc/session-authority-v3-migration";
import { validateSessionFile } from "./gjc/session-file";
import type { SessionMapping, SessionMappingStore } from "./gjc/session-router";
import { V3FileBackedSessionMappingStore } from "./gjc/session-v3-file-backed-mapping-store";
import type { ManagedTurnAuthority } from "./gjc/turn-runner";
import type { RegisteredProject } from "./projects/registry";
import type { RuntimeSingletonLock } from "./runtime-singleton-lock";

export interface ManagedBootstrapAuthority {
	readonly project: RegisteredProject;
	readonly canonicalWorkspace: string;
	readonly leaseId: string;
	readonly epoch: string;
	assertFence(): Promise<void> | void;
}

/** Resolves current project, workspace, and exclusive lease authority; it must not create a workspace or lease. */
export interface ManagedBootstrapAuthorityResolver {
	resolve(principalId: string, projectId: string): Promise<ManagedBootstrapAuthority | undefined>;
}

export interface AdapterManagedBootstrapInput {
	readonly locations: Pick<GjcRuntimeLocations, "agentDir"> & Readonly<{ stateRoot: string }>;
	readonly configuredOwnerUserId: string;
	readonly mappings: Pick<SessionMappingStore, "mappingRecordsIterable">;
	readonly sourcePath: string;
	readonly runtimeLock: RuntimeSingletonLock;
	readonly authority: ManagedBootstrapAuthorityResolver;
	/** Validates request-scoped lease identities after the migration bootstrap lease is no longer current. */
	readonly liveTenantFence?: (key: TenantSessionKey) => boolean | Promise<boolean>;
	readonly runtime: ManagedSdkRuntime;
	readonly lifecycle: Pick<ManagedSdkRuntime, "resumeLifecycleSession">;
}

export interface AdapterManagedBootstrap {
	readonly options: ManagedBootstrapOptions;
	readonly service: ManagedBootstrapService;
	start(): Promise<ManagedBootstrapStartResult>;
}

export type AdapterSessionAuthorityV3Activation =
	| Readonly<{ status: "blocked"; activation: SessionAuthorityV3ActivationResult }>
	| Readonly<{
			status: "activated";
			activation: SessionAuthorityV3ActivationResult;
			store: V3FileBackedSessionMappingStore;
			managed: ActiveManagedV3Runtime;
	  }>;

/**
 * Converts an already-open V2 authority directly to canonical V3. This path
 * only reads durable authority metadata through its mapping store; it never
 * opens a mapped session file, transcript, or workspace artifact.
 */
export async function activateAdapterSessionAuthorityV3(
	input: AdapterManagedBootstrapInput,
): Promise<AdapterSessionAuthorityV3Activation> {
	assertAbsolute(input.locations.agentDir, "agentDir");
	assertAbsolute(input.locations.stateRoot, "stateRoot");
	assertAbsolute(input.sourcePath, "sourcePath");

	// An absent source is the one permitted source mutation before activation:
	// install the canonical empty V2 document, then snapshot it in the V3 activator.
	await readOrCreateLegacySource(input.sourcePath);
	const authorities = new Map<string, ManagedBootstrapAuthority>();
	const bindings = await v3Bindings(input, authorities);
	if (bindings === undefined)
		return {
			status: "blocked",
			activation: {
				status: "blocked",
				canonicalPath: resolve(input.sourcePath),
				markerPath: `${resolve(input.sourcePath)}.v3-active.json`,
				reasons: ["A complete managed authority could not be derived for the V2 authority graph."],
			},
		};
	const activation = activateSessionAuthorityV3({
		canonicalPath: input.sourcePath,
		stagingRoot: input.locations.stateRoot,
		bindings,
	});
	if (activation.status === "blocked") return { status: "blocked", activation };
	const store = new V3FileBackedSessionMappingStore(input.sourcePath);
	const managed = await startActiveManagedRuntime({
		mappings: store,
		runtime: input.runtime,
		liveTenantFence: async key => await tenantFence(input, authorities, key),
	});
	return { status: "activated", activation, store, managed };
}

/**
 * Production-only composition for the v2 -> public-SDK authority activation.
 * It deliberately synthesizes evidence from mapping metadata and filesystem
 * bytes only; session JSONL files, artifacts, and transcripts are never read.
 */
export function createAdapterManagedBootstrap(input: AdapterManagedBootstrapInput): AdapterManagedBootstrap {
	assertAbsolute(input.locations.agentDir, "agentDir");
	assertAbsolute(input.locations.stateRoot, "stateRoot");
	assertAbsolute(input.sourcePath, "sourcePath");

	const authorityByStableKey = new Map<string, ManagedBootstrapAuthority>();
	const preparedByIdentity = new Map<string, Readonly<{ intent: ManagedAuthorityPreparedRebindIntent }>>();
	const options: ManagedBootstrapOptions = {
		agentDir: input.locations.agentDir,
		stateRoot: input.locations.stateRoot,
		sourcePath: input.sourcePath,
		runtimeLock: input.runtimeLock,
		legacyEvidence: async () => {
			preparedByIdentity.clear();
			authorityByStableKey.clear();
			const evidence = await legacyEvidence(input, authorityByStableKey);
			for (const mapping of input.mappings.mappingRecordsIterable()) {
				const prepared = await prepare(input, mapping, authorityByStableKey);
				if (prepared !== undefined) preparedByIdentity.set(identityFor(prepared.intent), prepared);
			}
			return evidence;
		},
		bindings: async checkpoint =>
			checkpoint.records
				.filter(record => record.status === "intent_prepared")
				.flatMap(record => {
					const prepared = preparedByIdentity.get(record.identity);
					return prepared === undefined ? [] : [{ intent: prepared.intent }];
				}),
		lifecycle: {
			resume: async intent => await resume(input.lifecycle, intent),
			recover: async intent => await resume(input.lifecycle, intent),
		},
		tenantFence: async key => await tenantFence(input, authorityByStableKey, key),
		preparedIntentFence: async intent => await preparedFence(input, authorityByStableKey, intent),
		createRuntime: () => input.runtime,
	};
	const service = new ManagedBootstrapService(options);
	return { options, service, start: () => service.start() };
}

async function legacyEvidence(
	input: AdapterManagedBootstrapInput,
	authorities: Map<string, ManagedBootstrapAuthority>,
): Promise<LegacyManagedSessionAuthorityEvidence> {
	const source = await readOrCreateLegacySource(input.sourcePath);
	const wal = await readOptional(`${input.sourcePath}.wal`);
	const records: Array<LegacyManagedSessionAuthorityEvidence["records"][number]> = [];
	for (const mapping of input.mappings.mappingRecordsIterable()) {
		const prepared = await prepare(input, mapping, authorities);
		if (prepared === undefined) {
			records.push({ sessionId: mapping.sessionId });
			continue;
		}
		records.push({
			principalId: prepared.intent.principalId,
			projectId: prepared.intent.projectId,
			canonicalWorkspace: prepared.intent.canonicalWorkspace,
			chatId: prepared.intent.chatId,
			sessionId: prepared.intent.sessionId,
		});
	}
	const manifestBytes = Buffer.from(JSON.stringify(records));
	return {
		sourceDigest: digest(source),
		// Activation makes its own byte-for-byte source backup.
		backupDigest: digest(source),
		walDigest: digest(wal),
		targetManifestDigest: digest(manifestBytes),
		records,
	};
}

/** Internal authority access is deliberately read-only and remains behind the
 * SessionMappingStore boundary. It is needed because `SessionMapping` omits
 * V2 journal, reassignment, provisional, and tombstone graph nodes. */
interface V2AuthorityGraphStore {
	readonly authority?: Readonly<{
		recordsIterable(): Iterable<SessionAuthorityRecord>;
		provisionalEntries(): readonly ProvisionalSessionOperation[];
	}>;
}

async function v3Bindings(
	input: AdapterManagedBootstrapInput,
	authorities: Map<string, ManagedBootstrapAuthority>,
): Promise<readonly ManagedTurnAuthorityBinding[] | undefined> {
	const graph = (input.mappings as unknown as V2AuthorityGraphStore).authority;
	const visible = [...input.mappings.mappingRecordsIterable()];
	if (graph === undefined) return visible.length === 0 ? [] : undefined;
	const candidates = new Map<string, SessionMapping>();
	const required = new Set<string>();
	const successorSessions = new Set<string>();
	for (const record of graph.recordsIterable()) {
		collectRecord(record, visible, input.configuredOwnerUserId, candidates, required, successorSessions);
	}
	for (const provisional of graph.provisionalEntries()) {
		if (provisional.sessionId === undefined) return undefined;
		const provisionalMapping: SessionMapping = {
			...(provisional.managedAuthority === undefined
				? {}
				: {
						principalId: provisional.managedAuthority.principalId,
						managedAuthority: provisional.managedAuthority,
					}),
			chatId: provisional.chatId,
			projectId: provisional.projectId,
			sessionId: provisional.sessionId,
			...(provisional.sessionFile === undefined ? {} : { sessionFile: provisional.sessionFile }),
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: provisional.id,
			...(provisional.attachment === undefined ? {} : { attachment: provisional.attachment }),
		};
		collectCandidate(provisionalMapping, visible, input.configuredOwnerUserId, candidates);
		collectOperationIdentities(provisional, required, successorSessions);
		required.add(identityKey(provisionalMapping));
	}
	const bindings: ManagedTurnAuthorityBinding[] = [];
	for (const [identity, mapping] of candidates) {
		const prepared = await prepare(input, mapping, authorities);
		if (prepared === undefined || !(await preparedFence(input, authorities, prepared.intent))) return undefined;
		const resumed = await resumeExternal(input.runtime, prepared.intent);
		if (resumed === undefined) return undefined;
		const managedAuthority: ManagedTurnAuthority = Object.freeze({
			principalId: prepared.intent.principalId,
			projectId: prepared.intent.projectId,
			canonicalWorkspace: prepared.intent.canonicalWorkspace,
			chatId: prepared.intent.chatId,
			sessionId: resumed.sessionId,
			generation: resumed.generation,
			leaseId: prepared.intent.leaseId,
			epoch: prepared.intent.epoch,
			requestKey: prepared.intent.stableKey,
		});
		bindings.push({
			chatId: mapping.chatId,
			projectId: mapping.projectId,
			sessionId: mapping.sessionId,
			managedAuthority,
		});
		if (identity !== identityKey(mapping)) return undefined;
	}
	const bound = new Set(bindings.map(binding => identityKey(binding)));
	const successorCounts = new Map<string, number>();
	for (const binding of bindings)
		successorCounts.set(binding.sessionId, (successorCounts.get(binding.sessionId) ?? 0) + 1);
	return [...required].every(identity => bound.has(identity)) &&
		[...successorSessions].every(sessionId => successorCounts.get(sessionId) === 1)
		? bindings
		: undefined;
}

function collectRecord(
	record: SessionAuthorityRecord,
	visible: readonly SessionMapping[],
	owner: string,
	candidates: Map<string, SessionMapping>,
	required: Set<string>,
	successorSessions: Set<string>,
): void {
	collectCandidate(record, visible, owner, candidates);
	required.add(identityKey(record));
	collectOperationIdentities(record, required, successorSessions);
	const reassignment = record.reassignment;
	if (reassignment?.sourceTombstone !== undefined)
		collectTombstone(reassignment.sourceTombstone, visible, owner, candidates, required, successorSessions);
	if (reassignment?.priorTombstone !== undefined)
		collectTombstone(reassignment.priorTombstone, visible, owner, candidates, required, successorSessions);
}

function collectTombstone(
	tombstone: SessionAuthorityTombstone,
	visible: readonly SessionMapping[],
	owner: string,
	candidates: Map<string, SessionMapping>,
	required: Set<string>,
	successorSessions: Set<string>,
): void {
	collectCandidate(tombstone, visible, owner, candidates);
	required.add(identityKey(tombstone));
	collectOperationIdentities(tombstone, required, successorSessions);
	if (tombstone.prior !== undefined)
		collectTombstone(tombstone.prior, visible, owner, candidates, required, successorSessions);
}

function collectOperationIdentities(
	value: Pick<SessionAuthorityRecord, "journal"> | ProvisionalSessionOperation,
	required: Set<string>,
	successorSessions: Set<string>,
): void {
	const operations = "journal" in value ? value.journal : [value];
	for (const operation of operations) {
		if (operation.result !== undefined) required.add(identityKey(operation.result.mapping));
		if (operation.acknowledgedSuccessor !== undefined)
			successorSessions.add(operation.acknowledgedSuccessor.sessionId);
	}
}

function collectCandidate(
	value: Pick<
		SessionMapping,
		| "chatId"
		| "projectId"
		| "sessionId"
		| "sessionFile"
		| "operationId"
		| "rawFrameCursor"
		| "eventCursor"
		| "attachment"
		| "activeLeaf"
	>,
	visible: readonly SessionMapping[],
	owner: string,
	candidates: Map<string, SessionMapping>,
): void {
	const matching = visible.find(
		mapping =>
			mapping.projectId === value.projectId &&
			mapping.sessionId === value.sessionId &&
			(mapping.chatId === value.chatId || JSON.stringify([mapping.principalId, mapping.chatId]) === value.chatId),
	);
	const principalId = matching?.principalId ?? (matching?.chatId === value.chatId ? owner : undefined);
	if (principalId === undefined) return;
	const mapping: SessionMapping = { ...value, principalId };
	const key = identityKey(mapping);
	const current = candidates.get(key);
	if (current === undefined) candidates.set(key, mapping);
	else if (current.sessionFile !== mapping.sessionFile || current.attachment !== mapping.attachment)
		candidates.delete(key);
}

async function resumeExternal(
	runtime: ManagedSdkRuntime,
	intent: ManagedAuthorityPreparedRebindIntent,
): Promise<Readonly<{ sessionId: string; generation: number }> | undefined> {
	try {
		const response = await runtime.resumeExternalLifecycleSession({
			actor: { namespace: "openwebui-gjc-adapter", id: intent.principalId },
			capability: "session.resume",
			requestKey: intent.stableKey,
			target: { sessionIdOrPrefix: intent.sessionId, path: intent.canonicalWorkspace },
		} as never);
		const external = response as unknown as { kind?: unknown; outcome?: { ok?: unknown; result?: unknown } };
		const outcome = external.kind === "result" ? external.outcome : response;
		const result = outcome as { ok?: unknown; result?: { sessionId?: unknown; endpointGeneration?: unknown } };
		if (
			result.ok !== true ||
			result.result?.sessionId !== intent.sessionId ||
			!positive(result.result.endpointGeneration)
		)
			return undefined;
		return { sessionId: intent.sessionId, generation: result.result.endpointGeneration };
	} catch {
		return undefined;
	}
}

function identityKey(value: Pick<SessionMapping, "chatId" | "projectId" | "sessionId">): string {
	return JSON.stringify([value.chatId, value.projectId, value.sessionId]);
}

async function readOrCreateLegacySource(sourcePath: string): Promise<Buffer> {
	try {
		return await readFile(sourcePath);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		const source = Buffer.from('{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n');
		await mkdir(dirname(sourcePath), { recursive: true });
		await writeFile(sourcePath, source, { flag: "wx", mode: 0o600 }).catch(async writeError => {
			if (!(writeError instanceof Error) || !("code" in writeError) || writeError.code !== "EEXIST")
				throw writeError;
		});
		return await readFile(sourcePath);
	}
}

async function prepare(
	input: AdapterManagedBootstrapInput,
	mapping: SessionMapping,
	authorities: Map<string, ManagedBootstrapAuthority>,
): Promise<Readonly<{ intent: ManagedAuthorityPreparedRebindIntent }> | undefined> {
	const principalId = mapping.principalId?.trim() || input.configuredOwnerUserId;
	if (!nonEmpty(principalId) || !identityFields(mapping)) return undefined;
	const authority = await input.authority.resolve(principalId, mapping.projectId);
	if (authority === undefined || authority.project.id !== mapping.projectId) return undefined;
	const canonicalWorkspace = resolve(authority.canonicalWorkspace);
	if (!isAbsolute(canonicalWorkspace) || canonicalWorkspace !== resolve(authority.project.cwd)) return undefined;
	const attachment = mapping.attachment;
	if (
		attachment === undefined ||
		attachment.expectedSessionId !== mapping.sessionId ||
		resolve(attachment.expectedCwd) !== canonicalWorkspace ||
		mapping.sessionFile === undefined
	)
		return undefined;
	try {
		validateSessionFile(authority.project, mapping.sessionFile);
	} catch {
		return undefined;
	}
	const stableKey = hash(
		JSON.stringify([
			principalId,
			mapping.projectId,
			canonicalWorkspace,
			mapping.chatId,
			mapping.sessionId,
			mapping.operationId,
		]),
	);
	const operationHash = hash(
		JSON.stringify([mapping.operationId, mapping.chatId, mapping.projectId, mapping.sessionId]),
	);
	const intent: ManagedAuthorityPreparedRebindIntent = Object.freeze({
		principalId,
		projectId: mapping.projectId,
		canonicalWorkspace,
		chatId: mapping.chatId,
		sessionId: mapping.sessionId,
		actorDigest: hash(JSON.stringify([principalId, mapping.projectId])),
		actorRef: `${principalId}:${mapping.projectId}`,
		stableKey,
		operationHash,
		requestHash: hash(JSON.stringify([stableKey, "resume"])),
		payloadHash: hash(JSON.stringify([mapping.sessionFile, attachment.payloadDigest])),
		leaseId: authority.leaseId,
		epoch: authority.epoch,
		preparedAt: new Date(0).toISOString(),
		observedAt: new Date(0).toISOString(),
		rawFrameCursor: mapping.rawFrameCursor,
		eventCursor: mapping.eventCursor,
		...(mapping.activeLeaf === undefined ? {} : { activeLeaf: mapping.activeLeaf }),
	});
	authorities.set(stableKey, authority);
	return { intent };
}

async function resume(
	lifecycle: Pick<ManagedSdkRuntime, "resumeLifecycleSession">,
	intent: ManagedAuthorityPreparedRebindIntent,
): Promise<ManagedAuthorityLifecycleOutcome> {
	try {
		const result = await lifecycle.resumeLifecycleSession({
			actor: { id: intent.principalId, namespace: intent.projectId },
			capability: "session.resume",
			requestKey: intent.stableKey,
			target: { sessionId: intent.sessionId, cwd: intent.canonicalWorkspace },
		});
		const value = result as unknown as { result?: { sessionId?: unknown; endpointGeneration?: unknown } };
		const sessionId = value.result?.sessionId;
		const endpointGeneration = value.result?.endpointGeneration;
		if (typeof sessionId !== "string" || sessionId !== intent.sessionId || !positive(endpointGeneration))
			return { ok: false, reason: "Public lifecycle resume did not return the exact session generation." };
		return { ok: true, sessionId, endpointGeneration, acknowledgedAt: new Date().toISOString() };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : "Public lifecycle resume failed." };
	}
}

async function preparedFence(
	input: AdapterManagedBootstrapInput,
	authorities: Map<string, ManagedBootstrapAuthority>,
	intent: ManagedAuthorityPreparedRebindIntent,
): Promise<boolean> {
	const authority = authorities.get(intent.stableKey);
	if (authority === undefined || authority.leaseId !== intent.leaseId || authority.epoch !== intent.epoch)
		return false;
	try {
		const current = await input.authority.resolve(intent.principalId, intent.projectId);
		if (
			current === undefined ||
			current.project.id !== intent.projectId ||
			resolve(current.canonicalWorkspace) !== intent.canonicalWorkspace ||
			current.leaseId !== intent.leaseId ||
			current.epoch !== intent.epoch ||
			findOperationId(input, intent) === undefined
		)
			return false;
		await authority.assertFence();
		await current.assertFence();
		return true;
	} catch {
		return false;
	}
}

async function tenantFence(
	input: AdapterManagedBootstrapInput,
	authorities: Map<string, ManagedBootstrapAuthority>,
	key: TenantSessionKey,
): Promise<boolean> {
	const operationId = findOperationId(input, key);
	if (operationId === undefined) return false;
	const stableKey = hash(
		JSON.stringify([key.principalId, key.projectId, key.canonicalWorkspace, key.chatId, key.sessionId, operationId]),
	);
	const authority = authorities.get(stableKey);
	if (authority === undefined || authority.leaseId !== key.leaseId || authority.epoch !== key.epoch)
		return (await input.liveTenantFence?.(key)) ?? false;
	try {
		const current = await input.authority.resolve(key.principalId, key.projectId);
		if (
			current === undefined ||
			current.project.id !== key.projectId ||
			resolve(current.canonicalWorkspace) !== key.canonicalWorkspace ||
			current.leaseId !== key.leaseId ||
			current.epoch !== key.epoch
		)
			return false;
		await authority.assertFence();
		await current.assertFence();
		return true;
	} catch {
		return false;
	}
}

function findOperationId(
	input: AdapterManagedBootstrapInput,
	key: Pick<TenantSessionKey, "principalId" | "projectId" | "chatId" | "sessionId">,
): string | undefined {
	let operationId: string | undefined;
	for (const mapping of input.mappings.mappingRecordsIterable()) {
		if (
			(mapping.principalId?.trim() || input.configuredOwnerUserId) === key.principalId &&
			mapping.projectId === key.projectId &&
			mapping.chatId === key.chatId &&
			mapping.sessionId === key.sessionId
		) {
			if (operationId !== undefined) return undefined;
			operationId = mapping.operationId;
		}
	}
	return operationId;
}

function identityFor(intent: ManagedAuthorityPreparedRebindIntent): string {
	return JSON.stringify([
		intent.principalId,
		intent.projectId,
		intent.canonicalWorkspace,
		intent.chatId,
		intent.sessionId,
	]);
}
function identityFields(mapping: SessionMapping): boolean {
	return [mapping.chatId, mapping.projectId, mapping.sessionId, mapping.operationId].every(nonEmpty);
}
function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
async function readOptional(path: string): Promise<Buffer> {
	try {
		return await readFile(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT")
			return Buffer.alloc(0);
		throw error;
	}
}
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function assertAbsolute(value: string, label: string): void {
	if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute.`);
}
