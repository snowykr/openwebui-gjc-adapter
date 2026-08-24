import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
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
import { validateSessionFile } from "./gjc/session-file";
import type { SessionMapping, SessionMappingStore } from "./gjc/session-router";
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
