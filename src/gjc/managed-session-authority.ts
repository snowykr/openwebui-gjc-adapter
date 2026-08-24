import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { NormalizedModelSelection } from "../contracts";
import {
	assertManagedLifecycleTransition,
	isManagedLifecycleState,
	type ManagedLifecycleState,
} from "./managed-lifecycle-state";
import { isEvent, isNormalizedModelSelection } from "./session-authority-operation-validation";
import type { GjcTurnEvent } from "./turn-runner";

export const MANAGED_SESSION_AUTHORITY_EPOCH = "gjc-public-sdk-v015-managed/1" as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const RECORD_KEYS = [
	"authorityEpoch",
	"principalId",
	"projectId",
	"canonicalWorkspace",
	"chatId",
	"sessionId",
	"generation",
	"operationHash",
	"requestHash",
	"payloadHash",
	"sessionFile",
	"projectSessionRoot",
	"operationId",
	"assistantText",
	"events",
	"modelSelection",
	"session",
	"projection",
	"lifecycle",
] as const;
const SESSION_KEYS = ["sessionId", "observedAt"] as const;
const PROJECTION_KEYS = ["rawFrameCursor", "eventCursor", "activeLeaf"] as const;
const LIFECYCLE_KEYS = ["state", "recordedAt"] as const;
const MIGRATION_DIGEST_KEYS = ["sourceDigest", "backupDigest", "walDigest", "targetManifestDigest"] as const;
const MIGRATION_ITEM_KEYS = ["identity", "status", "reason", "intent"] as const;
const MIGRATION_CHECKPOINT_KEYS = [
	"authorityEpoch",
	"digests",
	"records",
	"canonicalReplaced",
	"activeMarkerReady",
] as const;

export interface ManagedSessionAuthorityTenant {
	readonly principalId: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly sessionId: string;
}

/** Credential-free evidence only; no attachment, endpoint, descriptor, tmux/process data, or opaque attachment is retained. */
export interface ManagedSessionAuthorityRecord extends ManagedSessionAuthorityTenant {
	readonly authorityEpoch: typeof MANAGED_SESSION_AUTHORITY_EPOCH;
	readonly generation: number;
	readonly operationHash: string;
	readonly requestHash: string;
	readonly payloadHash: string;
	/** Canonical transcript path, once discovered. It is bounded by the workspace default or registered root evidence. */
	readonly sessionFile?: string;
	/** Canonical registered project root when it differs from canonicalWorkspace/.gjc/sessions. */
	readonly projectSessionRoot?: string;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly session: Readonly<{
		readonly sessionId: string;
		readonly observedAt: string;
	}>;
	readonly projection: Readonly<{
		readonly rawFrameCursor: number;
		readonly eventCursor: number;
		readonly activeLeaf?: string;
	}>;
	readonly lifecycle: Readonly<{
		readonly state: ManagedLifecycleState;
		readonly recordedAt: string;
	}>;
}

export type ManagedSessionAuthorityMigrationStatus =
	| "intent_prepared"
	| "migration_blocked"
	| "quarantined"
	| "active_generation_proven"
	| "retired";

export interface ManagedSessionAuthorityMigrationDigests {
	readonly sourceDigest: string;
	readonly backupDigest: string;
	readonly walDigest: string;
	readonly targetManifestDigest: string;
}

export interface ManagedSessionAuthorityMigrationRecord {
	readonly identity: string;
	readonly status: ManagedSessionAuthorityMigrationStatus;
	readonly reason?: string;
	/** Generation-free replay/mapping evidence copied from v2; never read from a session JSONL. */
	readonly intent?: ManagedSessionAuthorityMigrationIntent;
}

export interface ManagedSessionAuthorityMigrationIntent extends ManagedSessionAuthorityTenant {
	readonly sessionFile: string;
	readonly projectSessionRoot?: string;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly activeLeaf?: string;
}

/** A serializable, inactive migration checkpoint. The flags remain false until a later atomic activator owns them. */
export interface ManagedSessionAuthorityMigrationCheckpoint {
	readonly authorityEpoch: typeof MANAGED_SESSION_AUTHORITY_EPOCH;
	readonly digests: ManagedSessionAuthorityMigrationDigests;
	readonly records: readonly ManagedSessionAuthorityMigrationRecord[];
	readonly canonicalReplaced: boolean;
	readonly activeMarkerReady: boolean;
}

/** Narrow, already-read legacy evidence. This module neither reads nor writes user artifacts. */
export interface LegacyManagedSessionAuthorityEvidence {
	readonly sourceDigest: string;
	readonly backupDigest: string;
	readonly walDigest: string;
	readonly targetManifestDigest: string;
	readonly records: readonly Readonly<{
		readonly principalId?: string;
		readonly projectId?: string;
		readonly canonicalWorkspace?: string;
		readonly chatId?: string;
		readonly sessionId?: string;
		readonly sessionFile?: string;
		readonly projectSessionRoot?: string;
		readonly operationId?: string;
		readonly assistantText?: string;
		readonly events?: readonly GjcTurnEvent[];
		readonly modelSelection?: NormalizedModelSelection;
		readonly rawFrameCursor?: number;
		readonly eventCursor?: number;
		readonly activeLeaf?: string;
		readonly status?: "quarantined" | "active_generation_proven" | "retired";
	}>[];
}

export class ManagedSessionAuthorityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManagedSessionAuthorityError";
	}
}

export function isManagedSessionAuthorityRecord(value: unknown): value is ManagedSessionAuthorityRecord {
	if (!hasOnlyKeys(value, RECORD_KEYS) || value.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH) return false;
	if (
		!isTenant(value) ||
		!isPositiveGeneration(value.generation) ||
		!hashes(value.operationHash, value.requestHash, value.payloadHash)
	)
		return false;
	if (
		!isCanonicalAbsolutePath(value.canonicalWorkspace) ||
		(value.sessionFile !== undefined &&
			!isCanonicalSessionPath(value.canonicalWorkspace, value.sessionFile, value.projectSessionRoot)) ||
		(value.sessionFile === undefined && value.projectSessionRoot !== undefined) ||
		!isNonEmptyString(value.operationId) ||
		(value.assistantText !== undefined && typeof value.assistantText !== "string") ||
		(value.events !== undefined && (!Array.isArray(value.events) || !value.events.every(isCredentialFreeEvent))) ||
		(value.modelSelection !== undefined && !isNormalizedModelSelection(value.modelSelection))
	)
		return false;
	if (
		!hasOnlyKeys(value.session, SESSION_KEYS) ||
		value.session.sessionId !== value.sessionId ||
		!isCanonicalTimestamp(value.session.observedAt)
	)
		return false;
	if (
		!hasOnlyKeys(value.projection, PROJECTION_KEYS) ||
		!isNonnegativeSafeInteger(value.projection.rawFrameCursor) ||
		!isNonnegativeSafeInteger(value.projection.eventCursor) ||
		(value.projection.activeLeaf !== undefined && !isNonEmptyString(value.projection.activeLeaf))
	)
		return false;
	return (
		hasOnlyKeys(value.lifecycle, LIFECYCLE_KEYS) &&
		isManagedLifecycleState(value.lifecycle.state) &&
		isCanonicalTimestamp(value.lifecycle.recordedAt)
	);
}

export function parseManagedSessionAuthorityRecord(value: unknown): ManagedSessionAuthorityRecord {
	if (!isManagedSessionAuthorityRecord(value))
		throw new ManagedSessionAuthorityError("Invalid managed session authority record.");
	return copyManagedSessionAuthorityRecord(value);
}

export function encodeManagedSessionAuthorityRecord(record: ManagedSessionAuthorityRecord): string {
	return JSON.stringify(canonicalRecord(parseManagedSessionAuthorityRecord(record)));
}

export function decodeManagedSessionAuthorityRecord(value: unknown): ManagedSessionAuthorityRecord {
	let parsed: unknown;
	try {
		parsed = typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		throw new ManagedSessionAuthorityError("Malformed managed session authority record.");
	}
	return parseManagedSessionAuthorityRecord(parsed);
}

export function copyManagedSessionAuthorityRecord(
	record: ManagedSessionAuthorityRecord,
): ManagedSessionAuthorityRecord {
	const parsed = isManagedSessionAuthorityRecord(record) ? record : parseManagedSessionAuthorityRecord(record);
	return {
		...parsed,
		...(parsed.events === undefined ? {} : { events: copyEvents(parsed.events) }),
		...(parsed.modelSelection === undefined ? {} : { modelSelection: { ...parsed.modelSelection } }),
		session: { ...parsed.session },
		projection: { ...parsed.projection },
		lifecycle: { ...parsed.lifecycle },
	};
}

/** Stable identity excludes replaceable observation and lifecycle evidence. */
export function managedSessionAuthorityIdentity(record: ManagedSessionAuthorityRecord): string {
	const valid = parseManagedSessionAuthorityRecord(record);
	return sha256(
		JSON.stringify({
			authorityEpoch: valid.authorityEpoch,
			principalId: valid.principalId,
			projectId: valid.projectId,
			canonicalWorkspace: valid.canonicalWorkspace,
			chatId: valid.chatId,
			sessionId: valid.sessionId,
			generation: valid.generation,
			operationHash: valid.operationHash,
			requestHash: valid.requestHash,
			payloadHash: valid.payloadHash,
			...(valid.sessionFile === undefined ? {} : { sessionFile: valid.sessionFile }),
			...(valid.projectSessionRoot === undefined ? {} : { projectSessionRoot: valid.projectSessionRoot }),
			operationId: valid.operationId,
		}),
	);
}

export function managedSessionAuthorityHash(record: ManagedSessionAuthorityRecord): string {
	return sha256(encodeManagedSessionAuthorityRecord(record));
}

export function transitionManagedSessionAuthorityRecord(
	record: ManagedSessionAuthorityRecord,
	next: ManagedLifecycleState,
	recordedAt: string,
): ManagedSessionAuthorityRecord {
	const valid = parseManagedSessionAuthorityRecord(record);
	if (!isCanonicalTimestamp(recordedAt)) throw new ManagedSessionAuthorityError("Invalid lifecycle timestamp.");
	assertManagedLifecycleTransition(valid.lifecycle.state, next);
	return { ...valid, lifecycle: { state: next, recordedAt } };
}

/** Lifecycle evidence APIs intentionally encode the proof needed for each edge. */
export function acknowledgeManagedSessionAuthorityRecord(
	record: ManagedSessionAuthorityRecord,
	recordedAt: string,
): ManagedSessionAuthorityRecord {
	return transitionManagedSessionAuthorityRecord(record, "acknowledged_unproven", recordedAt);
}

export function proveManagedSessionAuthorityGeneration(
	record: ManagedSessionAuthorityRecord,
	endpointGeneration: number,
	recordedAt: string,
): ManagedSessionAuthorityRecord {
	const valid = parseManagedSessionAuthorityRecord(record);
	if (!isPositiveGeneration(endpointGeneration) || endpointGeneration !== valid.generation)
		throw new ManagedSessionAuthorityError(
			"The returned positive endpoint generation must exactly prove the record.",
		);
	return transitionManagedSessionAuthorityRecord(valid, "active_generation_proven", recordedAt);
}

export function retireManagedSessionAuthorityRecord(
	record: ManagedSessionAuthorityRecord,
	generationStatus: Readonly<{ generation: number; retired: true }>,
	recordedAt: string,
): ManagedSessionAuthorityRecord {
	const valid = parseManagedSessionAuthorityRecord(record);
	if (!isPositiveGeneration(generationStatus.generation) || generationStatus.generation !== valid.generation)
		throw new ManagedSessionAuthorityError("Positive exact generation status is required to retire authority.");
	return transitionManagedSessionAuthorityRecord(valid, "retired", recordedAt);
}

export function isManagedSessionAuthorityMigrationCheckpoint(
	value: unknown,
): value is ManagedSessionAuthorityMigrationCheckpoint {
	if (!hasOnlyKeys(value, MIGRATION_CHECKPOINT_KEYS) || value.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH)
		return false;
	if (!hasOnlyKeys(value.digests, MIGRATION_DIGEST_KEYS) || !hashes(...Object.values(value.digests))) return false;
	if (!Array.isArray(value.records) || !value.records.every(isMigrationRecord)) return false;
	if (typeof value.canonicalReplaced !== "boolean" || typeof value.activeMarkerReady !== "boolean") return false;
	return new Set(value.records.map(record => record.identity)).size === value.records.length;
}

export function parseManagedSessionAuthorityMigrationCheckpoint(
	value: unknown,
): ManagedSessionAuthorityMigrationCheckpoint {
	if (!isManagedSessionAuthorityMigrationCheckpoint(value))
		throw new ManagedSessionAuthorityError("Invalid managed session authority migration checkpoint.");
	return copyManagedSessionAuthorityMigrationCheckpoint(value);
}

export function encodeManagedSessionAuthorityMigrationCheckpoint(
	checkpoint: ManagedSessionAuthorityMigrationCheckpoint,
): string {
	return JSON.stringify(parseManagedSessionAuthorityMigrationCheckpoint(checkpoint));
}

export function decodeManagedSessionAuthorityMigrationCheckpoint(
	value: unknown,
): ManagedSessionAuthorityMigrationCheckpoint {
	let parsed: unknown;
	try {
		parsed = typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		throw new ManagedSessionAuthorityError("Malformed managed session authority migration checkpoint.");
	}
	return parseManagedSessionAuthorityMigrationCheckpoint(parsed);
}

export function copyManagedSessionAuthorityMigrationCheckpoint(
	checkpoint: ManagedSessionAuthorityMigrationCheckpoint,
): ManagedSessionAuthorityMigrationCheckpoint {
	const valid = isManagedSessionAuthorityMigrationCheckpoint(checkpoint)
		? checkpoint
		: parseManagedSessionAuthorityMigrationCheckpoint(checkpoint);
	return {
		...valid,
		digests: { ...valid.digests },
		records: valid.records.map(record => ({
			...record,
			...(record.intent === undefined ? {} : { intent: copyMigrationIntent(record.intent) }),
		})),
	};
}

/**
 * Produces an inactive, deterministic checkpoint from supplied evidence. Missing or ambiguous tenant identity is blocked,
 * rather than guessed. A matching prior checkpoint is copied unchanged, making repeated planning idempotent.
 */
export function planManagedSessionAuthorityMigration(
	evidence: LegacyManagedSessionAuthorityEvidence,
	prior?: ManagedSessionAuthorityMigrationCheckpoint,
): ManagedSessionAuthorityMigrationCheckpoint {
	const digests = parseMigrationDigests(evidence);
	if (!evidence.records.every(isLegacyEvidenceRecord))
		throw new ManagedSessionAuthorityError("Invalid legacy managed authority record evidence.");
	const identities = evidence.records.map(legacyIdentity);
	const duplicateIdentities = new Set(
		identities.flatMap((identity, index) =>
			identity !== undefined && identities.indexOf(identity) !== index ? [identity] : [],
		),
	);
	const records = evidence.records.map((record, index): ManagedSessionAuthorityMigrationRecord => {
		const identity = identities[index];
		if (identity === undefined || duplicateIdentities.has(identity))
			return {
				identity: `legacy:${index}`,
				status: "migration_blocked",
				reason: "missing or ambiguous tenant identity",
			};
		// Legacy evidence has no public lifecycle result. In particular its old
		// "active" label cannot manufacture an endpoint generation proof.
		if (record.status === "retired")
			return {
				identity,
				status: "migration_blocked",
				reason: "legacy retired label lacks positive exact-generation evidence",
			};
		const intent = legacyMigrationIntent(record);
		return {
			identity,
			status: record.status === "quarantined" ? "quarantined" : "intent_prepared",
			...(intent === undefined ? {} : { intent }),
		};
	});
	const planned: ManagedSessionAuthorityMigrationCheckpoint = {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		digests,
		records,
		canonicalReplaced: false,
		activeMarkerReady: false,
	};
	if (prior !== undefined) {
		const checked = parseManagedSessionAuthorityMigrationCheckpoint(prior);
		if (
			encodeManagedSessionAuthorityMigrationCheckpoint(checked) ===
			encodeManagedSessionAuthorityMigrationCheckpoint(planned)
		)
			return checked;
	}
	return planned;
}

function canonicalRecord(record: ManagedSessionAuthorityRecord): ManagedSessionAuthorityRecord {
	return {
		authorityEpoch: record.authorityEpoch,
		principalId: record.principalId,
		projectId: record.projectId,
		canonicalWorkspace: record.canonicalWorkspace,
		chatId: record.chatId,
		sessionId: record.sessionId,
		generation: record.generation,
		operationHash: record.operationHash,
		requestHash: record.requestHash,
		payloadHash: record.payloadHash,
		...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
		...(record.projectSessionRoot === undefined ? {} : { projectSessionRoot: record.projectSessionRoot }),
		operationId: record.operationId,
		...(record.assistantText === undefined ? {} : { assistantText: record.assistantText }),
		...(record.events === undefined ? {} : { events: copyEvents(record.events) }),
		...(record.modelSelection === undefined ? {} : { modelSelection: { ...record.modelSelection } }),
		session: { sessionId: record.session.sessionId, observedAt: record.session.observedAt },
		projection: {
			rawFrameCursor: record.projection.rawFrameCursor,
			eventCursor: record.projection.eventCursor,
			...(record.projection.activeLeaf === undefined ? {} : { activeLeaf: record.projection.activeLeaf }),
		},
		lifecycle: { state: record.lifecycle.state, recordedAt: record.lifecycle.recordedAt },
	};
}

function parseMigrationDigests(
	evidence: LegacyManagedSessionAuthorityEvidence,
): ManagedSessionAuthorityMigrationDigests {
	if (
		!hasOnlyKeys(evidence, ["sourceDigest", "backupDigest", "walDigest", "targetManifestDigest", "records"]) ||
		!Array.isArray(evidence.records)
	)
		throw new ManagedSessionAuthorityError("Invalid legacy managed authority evidence.");
	const digests = {
		sourceDigest: evidence.sourceDigest,
		backupDigest: evidence.backupDigest,
		walDigest: evidence.walDigest,
		targetManifestDigest: evidence.targetManifestDigest,
	};
	if (!hashes(...Object.values(digests))) throw new ManagedSessionAuthorityError("Invalid legacy migration digest.");
	return digests;
}

function isMigrationRecord(value: unknown): value is ManagedSessionAuthorityMigrationRecord {
	return (
		hasOnlyKeys(value, MIGRATION_ITEM_KEYS) &&
		isNonEmptyString(value.identity) &&
		["intent_prepared", "migration_blocked", "quarantined", "active_generation_proven", "retired"].includes(
			value.status as string,
		) &&
		(value.reason === undefined || isNonEmptyString(value.reason)) &&
		(value.intent === undefined || isMigrationIntent(value.intent))
	);
}

function legacyIdentity(record: LegacyManagedSessionAuthorityEvidence["records"][number]): string | undefined {
	const parts = [record.principalId, record.projectId, record.canonicalWorkspace, record.chatId, record.sessionId];
	return parts.every(isNonEmptyString) ? JSON.stringify(parts) : undefined;
}

function isLegacyEvidenceRecord(value: unknown): value is LegacyManagedSessionAuthorityEvidence["records"][number] {
	return (
		hasOnlyKeys(value, [
			"principalId",
			"projectId",
			"canonicalWorkspace",
			"chatId",
			"sessionId",
			"sessionFile",
			"projectSessionRoot",
			"operationId",
			"assistantText",
			"events",
			"modelSelection",
			"rawFrameCursor",
			"eventCursor",
			"activeLeaf",
			"status",
		]) &&
		(value.principalId === undefined || typeof value.principalId === "string") &&
		(value.projectId === undefined || typeof value.projectId === "string") &&
		(value.canonicalWorkspace === undefined || typeof value.canonicalWorkspace === "string") &&
		(value.chatId === undefined || typeof value.chatId === "string") &&
		(value.sessionId === undefined || typeof value.sessionId === "string") &&
		(value.sessionFile === undefined || typeof value.sessionFile === "string") &&
		(value.projectSessionRoot === undefined || typeof value.projectSessionRoot === "string") &&
		(value.operationId === undefined || typeof value.operationId === "string") &&
		(value.assistantText === undefined || typeof value.assistantText === "string") &&
		(value.events === undefined || (Array.isArray(value.events) && value.events.every(isCredentialFreeEvent))) &&
		(value.modelSelection === undefined || isNormalizedModelSelection(value.modelSelection)) &&
		(value.rawFrameCursor === undefined || isNonnegativeSafeInteger(value.rawFrameCursor)) &&
		(value.eventCursor === undefined || isNonnegativeSafeInteger(value.eventCursor)) &&
		(value.activeLeaf === undefined || isNonEmptyString(value.activeLeaf)) &&
		(value.status === undefined ||
			["quarantined", "active_generation_proven", "retired"].includes(value.status as string))
	);
}

function legacyMigrationIntent(
	record: LegacyManagedSessionAuthorityEvidence["records"][number],
): ManagedSessionAuthorityMigrationIntent | undefined {
	if (
		!isTenant(record) ||
		!isCanonicalSessionPath(record.canonicalWorkspace, record.sessionFile, record.projectSessionRoot) ||
		!isNonEmptyString(record.operationId) ||
		!isNonnegativeSafeInteger(record.rawFrameCursor) ||
		!isNonnegativeSafeInteger(record.eventCursor)
	)
		return undefined;
	return {
		principalId: record.principalId!,
		projectId: record.projectId!,
		canonicalWorkspace: record.canonicalWorkspace!,
		chatId: record.chatId!,
		sessionId: record.sessionId!,
		sessionFile: record.sessionFile!,
		...(record.projectSessionRoot === undefined ? {} : { projectSessionRoot: record.projectSessionRoot }),
		operationId: record.operationId!,
		...(record.assistantText === undefined ? {} : { assistantText: record.assistantText }),
		...(record.events === undefined ? {} : { events: copyEvents(record.events) }),
		...(record.modelSelection === undefined ? {} : { modelSelection: { ...record.modelSelection } }),
		rawFrameCursor: record.rawFrameCursor,
		eventCursor: record.eventCursor,
		...(record.activeLeaf === undefined ? {} : { activeLeaf: record.activeLeaf }),
	};
}

function isMigrationIntent(value: unknown): value is ManagedSessionAuthorityMigrationIntent {
	if (
		!hasOnlyKeys(value, [
			"principalId",
			"projectId",
			"canonicalWorkspace",
			"chatId",
			"sessionId",
			"sessionFile",
			"projectSessionRoot",
			"operationId",
			"assistantText",
			"events",
			"modelSelection",
			"rawFrameCursor",
			"eventCursor",
			"activeLeaf",
		])
	)
		return false;
	return (
		isTenant(value) &&
		isCanonicalSessionPath(value.canonicalWorkspace, value.sessionFile, value.projectSessionRoot) &&
		isNonEmptyString(value.operationId) &&
		(value.assistantText === undefined || typeof value.assistantText === "string") &&
		(value.events === undefined || (Array.isArray(value.events) && value.events.every(isCredentialFreeEvent))) &&
		(value.modelSelection === undefined || isNormalizedModelSelection(value.modelSelection)) &&
		isNonnegativeSafeInteger(value.rawFrameCursor) &&
		isNonnegativeSafeInteger(value.eventCursor) &&
		(value.activeLeaf === undefined || isNonEmptyString(value.activeLeaf))
	);
}

function copyMigrationIntent(intent: ManagedSessionAuthorityMigrationIntent): ManagedSessionAuthorityMigrationIntent {
	return {
		...intent,
		...(intent.events === undefined ? {} : { events: copyEvents(intent.events) }),
		...(intent.modelSelection === undefined ? {} : { modelSelection: { ...intent.modelSelection } }),
	};
}

function copyEvents(events: readonly GjcTurnEvent[]): GjcTurnEvent[] {
	return events.map(event => ({
		...event,
		...(event.payload === undefined ? {} : { payload: structuredClone(event.payload) }),
	}));
}

function isCredentialFreeEvent(value: unknown): value is GjcTurnEvent {
	return isEvent(value) && !containsForbiddenField(value);
}

function containsForbiddenField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsForbiddenField);
	if (value === null || typeof value !== "object") return false;
	return Object.entries(value).some(
		([key, child]) => /(?:attachment|descriptor|endpoint|token|tmux|pid)/i.test(key) || containsForbiddenField(child),
	);
}

function isCanonicalSessionPath(workspace: unknown, sessionFile: unknown, projectSessionRoot: unknown): boolean {
	if (!isCanonicalAbsolutePath(workspace) || !isCanonicalAbsolutePath(sessionFile)) return false;
	if (projectSessionRoot !== undefined && !isCanonicalAbsolutePath(projectSessionRoot)) return false;
	const root = (projectSessionRoot as string | undefined) ?? resolve(workspace, ".gjc", "sessions");
	const pathFromRoot = relative(root, sessionFile as string);
	return pathFromRoot.length > 0 && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

function isCanonicalAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && isNonEmptyString(value) && isAbsolute(value) && resolve(value) === value;
}

function isTenant(
	value: Readonly<{
		principalId?: unknown;
		projectId?: unknown;
		canonicalWorkspace?: unknown;
		chatId?: unknown;
		sessionId?: unknown;
	}>,
): boolean {
	return [value.principalId, value.projectId, value.canonicalWorkspace, value.chatId, value.sessionId].every(
		isNonEmptyString,
	);
}

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every(key => keys.includes(key))
	);
}

function hashes(...values: unknown[]): boolean {
	return values.every(value => typeof value === "string" && SHA256_HEX.test(value));
}

function isPositiveGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
