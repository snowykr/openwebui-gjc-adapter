import { createHash } from "node:crypto";
import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityReassignment,
	SessionAuthorityRecord,
	SessionAuthorityTombstone,
	SessionOperation,
	SessionOperationResult,
} from "./session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	type ManagedTurnAuthorityV3,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	SESSION_AUTHORITY_V3_VERSION,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Mapping,
	type SessionAuthorityV3Operation,
	type SessionAuthorityV3ProvisionalOperation,
	type SessionAuthorityV3Reassignment,
	type SessionAuthorityV3Result,
	type SessionAuthorityV3Tombstone,
} from "./session-authority-v3";
import type { ManagedTurnAuthority } from "./turn-runner";

const LEGACY_FIELDS = new Set([
	"attachment",
	"descriptor",
	"descriptorPath",
	"descriptorStat",
	"payloadDigest",
	"expectedSessionId",
	"expectedCwd",
	"tmuxSocket",
	"tmuxPane",
	"tmuxPanePid",
	"tmuxOwnershipTag",
	"ownedAt",
	"sessionFile",
	"activeLeaf",
	"recoveryAttachment",
]);

export interface SessionAuthorityV2Document {
	readonly mappings: readonly SessionAuthorityRecord[];
	readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
}

/** An authority is accepted only for this complete, durable session identity. */
export interface ManagedTurnAuthorityBinding {
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly managedAuthority: ManagedTurnAuthority;
}

export interface SessionAuthorityV3MigrationBlocked {
	readonly status: "blocked";
	readonly reasons: readonly string[];
}

export interface SessionAuthorityV3MigrationReady {
	readonly status: "ready";
	readonly document: SessionAuthorityV3Document;
}

export type SessionAuthorityV3MigrationReport = SessionAuthorityV3MigrationBlocked | SessionAuthorityV3MigrationReady;

/** Immutable source evidence. The WAL is retained as evidence and is never replayed or modified here. */
export interface SessionAuthorityV2Snapshot {
	readonly originalBaseBytes: Uint8Array;
	readonly originalBaseDigest: string;
	readonly originalWalBytes: Uint8Array;
	readonly originalWalDigest: string;
}

export interface StageSessionAuthorityV3MigrationRequest {
	readonly snapshot: SessionAuthorityV2Snapshot;
	readonly decodedDocument: SessionAuthorityV2Document;
	readonly bindings: readonly ManagedTurnAuthorityBinding[];
}

export interface StagedSessionAuthorityV3Migration {
	readonly status: "staged";
	readonly originalBaseBytes: Uint8Array;
	readonly originalBaseDigest: string;
	readonly originalWalBytes: Uint8Array;
	readonly originalWalDigest: string;
	readonly v3Bytes: Uint8Array;
	readonly v3Digest: string;
	readonly document: SessionAuthorityV3Document;
}

export type StageSessionAuthorityV3MigrationReport =
	| SessionAuthorityV3MigrationBlocked
	| StagedSessionAuthorityV3Migration;

/**
 * Pure conversion of a decoded V2 graph. Every V3 authority is supplied by the
 * caller; no endpoint, attachment, or terminal-derived identity is consulted.
 */
export function migrateSessionAuthorityV2ToV3(
	document: SessionAuthorityV2Document,
	bindings: readonly ManagedTurnAuthorityBinding[],
): SessionAuthorityV3MigrationReport {
	const authorityByIdentity = bindingIndex(bindings);
	if (authorityByIdentity.status === "blocked") return authorityByIdentity;
	const source = structuredClone(document) as SessionAuthorityV2Document;
	const reasons: string[] = [];
	const authorityFor = (identity: Identity, context: string): ManagedTurnAuthorityV3 | undefined => {
		const authority = authorityByIdentity.authorities.get(identityKey(identity));
		if (authority === undefined) {
			reasons.push(`${context} has no exact managed authority binding for ${identityKey(identity)}.`);
			return undefined;
		}
		return authority;
	};

	const authorityResolver = Object.assign(authorityFor, { successor: authorityByIdentity.successor });
	const mappings = source.mappings.map((mapping, index) =>
		migrateMapping(mapping, `mapping ${index}`, authorityResolver, reasons),
	);
	const provisionalOperations = (source.provisionalOperations ?? []).map((operation, index) =>
		migrateProvisional(operation, `provisional operation ${index}`, authorityResolver, reasons),
	);
	if (reasons.length > 0 || mappings.some(isUndefined) || provisionalOperations.some(isUndefined))
		return blocked(reasons);
	const result: SessionAuthorityV3Document = {
		kind: SESSION_AUTHORITY_V3_KIND,
		version: SESSION_AUTHORITY_V3_VERSION,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		mappings: mappings as SessionAuthorityV3Mapping[],
		provisionalOperations: provisionalOperations as SessionAuthorityV3ProvisionalOperation[],
	};
	if (!isSessionAuthorityV3Document(result))
		return blocked(["The V2 graph cannot be represented as a valid SessionAuthorityV3Document."]);
	return { status: "ready", document: result };
}

/**
 * Snapshot-first staging: verifies immutable source evidence, copies it before
 * conversion, and returns bytes for a caller-owned private destination only.
 */
export function stageSessionAuthorityV3Migration(
	request: StageSessionAuthorityV3MigrationRequest,
): StageSessionAuthorityV3MigrationReport {
	const base = new Uint8Array(request.snapshot.originalBaseBytes);
	const wal = new Uint8Array(request.snapshot.originalWalBytes);
	if (sha256(base) !== request.snapshot.originalBaseDigest)
		return blocked(["Original V2 base bytes do not match their supplied digest."]);
	if (sha256(wal) !== request.snapshot.originalWalDigest)
		return blocked(["Original V2 WAL bytes do not match their supplied digest."]);
	const migrated = migrateSessionAuthorityV2ToV3(
		structuredClone(request.decodedDocument),
		request.bindings.map(binding => ({ ...binding, managedAuthority: { ...binding.managedAuthority } })),
	);
	if (migrated.status === "blocked") return migrated;
	const v3Bytes = new TextEncoder().encode(encodeSessionAuthorityV3Document(migrated.document));
	return {
		status: "staged",
		originalBaseBytes: base,
		originalBaseDigest: request.snapshot.originalBaseDigest,
		originalWalBytes: wal,
		originalWalDigest: request.snapshot.originalWalDigest,
		v3Bytes,
		v3Digest: sha256(v3Bytes),
		document: migrated.document,
	};
}

type Identity = Readonly<{ chatId: string; projectId: string; sessionId: string }>;
type AuthorityFor = (identity: Identity, context: string) => ManagedTurnAuthorityV3 | undefined;

function migrateMapping(
	mapping: SessionAuthorityRecord,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): SessionAuthorityV3Mapping | undefined {
	const identity = mappingIdentity(mapping, context, reasons);
	if (identity === undefined) return undefined;
	const managedAuthority = authorityFor(identity, context);
	const journal = mapping.journal.map((operation, index) =>
		migrateOperation(operation, `${context} journal ${index}`, authorityFor, reasons),
	);
	const reassignment =
		mapping.reassignment === undefined
			? undefined
			: migrateReassignment(mapping.reassignment, `${context} reassignment`, authorityFor, reasons);
	if (
		managedAuthority === undefined ||
		journal.some(isUndefined) ||
		(mapping.reassignment !== undefined && reassignment === undefined)
	)
		return undefined;
	return strip({
		version: SESSION_AUTHORITY_V3_VERSION,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		chatId: mapping.chatId,
		projectId: mapping.projectId,
		sessionId: mapping.sessionId,
		createdAt: mapping.createdAt,
		header: { ...mapping.header },
		rawFrameCursor: mapping.rawFrameCursor,
		eventCursor: mapping.eventCursor,
		operationId: mapping.operationId,
		assistantText: mapping.assistantText,
		events: mapping.events,
		modelSelection: mapping.modelSelection,
		observations: mapping.observations,
		managedAuthority,
		journal,
		reassignment,
	}) as SessionAuthorityV3Mapping;
}

function migrateProvisional(
	operation: ProvisionalSessionOperation,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): SessionAuthorityV3ProvisionalOperation | undefined {
	if (operation.sessionId === undefined) {
		reasons.push(`${context} has no session identity.`);
		return undefined;
	}
	const identity = checkedIdentity(
		{ chatId: operation.chatId, projectId: operation.projectId, sessionId: operation.sessionId },
		context,
		reasons,
	);
	const managedAuthority = identity === undefined ? undefined : authorityFor(identity, context);
	const converted = migrateOperation(operation, context, authorityFor, reasons);
	if (converted === undefined || managedAuthority === undefined || identity === undefined) return undefined;
	return strip({ ...converted, ...identity, managedAuthority }) as SessionAuthorityV3ProvisionalOperation;
}

function migrateOperation(
	operation: SessionOperation,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): SessionAuthorityV3Operation | undefined {
	const result =
		operation.result === undefined
			? undefined
			: migrateResult(operation.result, `${context} result`, authorityFor, reasons);
	const acknowledgedSuccessor =
		operation.acknowledgedSuccessor === undefined
			? undefined
			: migrateSuccessor(operation.acknowledgedSuccessor, `${context} successor`, authorityFor, reasons);
	if (
		(operation.result !== undefined && result === undefined) ||
		(operation.acknowledgedSuccessor !== undefined && acknowledgedSuccessor === undefined)
	)
		return undefined;
	return strip({
		id: operation.id,
		kind: operation.kind,
		state: operation.state,
		ingressId: operation.ingressId,
		startedAt: operation.startedAt,
		completedAt: operation.completedAt,
		detail: operation.detail,
		result,
		acknowledgedSuccessor,
	}) as SessionAuthorityV3Operation;
}

function migrateResult(
	result: SessionOperationResult,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): SessionAuthorityV3Result | undefined {
	const identity = mappingIdentity(result.mapping, context, reasons);
	const managedAuthority = identity === undefined ? undefined : authorityFor(identity, context);
	if (managedAuthority === undefined) return undefined;
	return strip({
		kind: result.kind,
		assistantText: result.assistantText,
		managedAuthority,
		events: result.events,
		mapping: {
			chatId: result.mapping.chatId,
			projectId: result.mapping.projectId,
			sessionId: result.mapping.sessionId,
			rawFrameCursor: result.mapping.rawFrameCursor,
			eventCursor: result.mapping.eventCursor,
			operationId: result.mapping.operationId,
			modelSelection: result.mapping.modelSelection,
		},
		correlation: result.correlation,
		gate: result.gate,
	}) as SessionAuthorityV3Result;
}

function migrateSuccessor(
	successor: AcknowledgedSuccessor,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
) {
	// V2 successor metadata has no project/chat identity. It is deliberately not
	// guessed: the supplied binding must identify it by the successor session.
	const matching = authorityForSuccessor(successor.sessionId, context, authorityFor, reasons);
	return matching === undefined ? undefined : { sessionId: successor.sessionId, managedAuthority: matching };
}

function authorityForSuccessor(
	sessionId: string,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): ManagedTurnAuthorityV3 | undefined {
	// authorityFor intentionally has no enumeration capability. Successors are
	// resolved from the binding index captured below through this scoped helper.
	const resolver = authorityFor as AuthorityFor & { successor?: (id: string) => ManagedTurnAuthorityV3 | undefined };
	const authority = resolver.successor?.(sessionId);
	if (authority === undefined)
		reasons.push(`${context} has no unambiguous managed authority binding for successor session ${sessionId}.`);
	return authority;
}

function migrateReassignment(
	reassignment: SessionAuthorityReassignment,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): SessionAuthorityV3Reassignment | undefined {
	const sourceTombstone =
		reassignment.sourceTombstone === undefined
			? undefined
			: migrateTombstone(reassignment.sourceTombstone, `${context} source tombstone`, authorityFor, reasons);
	const priorTombstone =
		reassignment.priorTombstone === undefined
			? undefined
			: migrateTombstone(reassignment.priorTombstone, `${context} prior tombstone`, authorityFor, reasons);
	if (
		(reassignment.sourceTombstone !== undefined && sourceTombstone === undefined) ||
		(reassignment.priorTombstone !== undefined && priorTombstone === undefined)
	)
		return undefined;
	return strip({ ...reassignment, sourceTombstone, priorTombstone }) as SessionAuthorityV3Reassignment;
}

function migrateTombstone(
	tombstone: SessionAuthorityTombstone,
	context: string,
	authorityFor: AuthorityFor,
	reasons: string[],
): SessionAuthorityV3Tombstone | undefined {
	const identity = mappingIdentity(tombstone, context, reasons);
	const managedAuthority = identity === undefined ? undefined : authorityFor(identity, context);
	const journal = tombstone.journal.map((operation, index) =>
		migrateOperation(operation, `${context} journal ${index}`, authorityFor, reasons),
	);
	const prior =
		tombstone.prior === undefined
			? undefined
			: migrateTombstone(tombstone.prior, `${context} prior`, authorityFor, reasons);
	if (
		managedAuthority === undefined ||
		journal.some(isUndefined) ||
		(tombstone.prior !== undefined && prior === undefined)
	)
		return undefined;
	return strip({
		version: SESSION_AUTHORITY_V3_VERSION,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		chatId: tombstone.chatId,
		projectId: tombstone.projectId,
		sessionId: tombstone.sessionId,
		createdAt: tombstone.createdAt,
		header: { ...tombstone.header },
		rawFrameCursor: tombstone.rawFrameCursor,
		eventCursor: tombstone.eventCursor,
		operationId: tombstone.operationId,
		assistantText: tombstone.assistantText,
		events: tombstone.events,
		modelSelection: tombstone.modelSelection,
		observations: tombstone.observations,
		managedAuthority,
		journal,
		retiredAt: tombstone.retiredAt,
		prior,
	}) as SessionAuthorityV3Tombstone;
}

function bindingIndex(bindings: readonly ManagedTurnAuthorityBinding[]):
	| SessionAuthorityV3MigrationBlocked
	| {
			readonly status: "ready";
			readonly authorities: ReadonlyMap<string, ManagedTurnAuthorityV3>;
			readonly successor: (sessionId: string) => ManagedTurnAuthorityV3 | undefined;
	  } {
	const authorities = new Map<string, ManagedTurnAuthorityV3>();
	const bySuccessor = new Map<string, ManagedTurnAuthorityV3[]>();
	const reasons: string[] = [];
	for (const binding of bindings) {
		const identity = checkedIdentity(binding, "managed authority binding", reasons);
		if (identity === undefined || !sameIdentity(binding.managedAuthority, identity)) {
			if (identity !== undefined)
				reasons.push(
					`managed authority binding conflicts with its authority identity for ${identityKey(identity)}.`,
				);
			continue;
		}
		const key = identityKey(identity);
		if (authorities.has(key)) reasons.push(`Duplicate managed authority binding for ${key}.`);
		else authorities.set(key, { ...binding.managedAuthority, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH });
		const values = bySuccessor.get(identity.sessionId) ?? [];
		values.push({ ...binding.managedAuthority, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH });
		bySuccessor.set(identity.sessionId, values);
	}
	if (reasons.length > 0) return blocked(reasons);
	const successor = (sessionId: string) => {
		const matches = bySuccessor.get(sessionId) ?? [];
		return matches.length === 1 ? matches[0] : undefined;
	};
	return { status: "ready", authorities, successor };
}

function mappingIdentity(
	value: Pick<SessionAuthorityRecord, "chatId" | "projectId" | "sessionId">,
	context: string,
	reasons: string[],
): Identity | undefined {
	return checkedIdentity(value, context, reasons);
}

function checkedIdentity(
	value: Readonly<{ chatId: unknown; projectId: unknown; sessionId: unknown }>,
	context: string,
	reasons: string[],
): Identity | undefined {
	const { chatId, projectId, sessionId } = value;
	if (![chatId, projectId, sessionId].every(isNonEmptyString)) {
		reasons.push(`${context} has an incomplete identity.`);
		return undefined;
	}
	return { chatId: chatId as string, projectId: projectId as string, sessionId: sessionId as string };
}

function sameIdentity(value: ManagedTurnAuthority, identity: Identity): boolean {
	return (
		value.chatId === identity.chatId &&
		value.projectId === identity.projectId &&
		value.sessionId === identity.sessionId
	);
}
function identityKey(identity: Identity): string {
	return JSON.stringify([identity.chatId, identity.projectId, identity.sessionId]);
}
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function isUndefined<T>(value: T | undefined): value is undefined {
	return value === undefined;
}
function blocked(reasons: readonly string[]): SessionAuthorityV3MigrationBlocked {
	return { status: "blocked", reasons: [...new Set(reasons)].sort() };
}
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function strip(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(strip);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key, item]) => item !== undefined && !LEGACY_FIELDS.has(key))
			.map(([key, item]) => [key, strip(item)]),
	);
}
