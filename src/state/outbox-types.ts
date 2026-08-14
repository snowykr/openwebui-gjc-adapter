export type ProjectionOperationKind = "folder" | "chat" | "chat_message" | "event" | "session_mapping";

export type ProjectionOperationState = "pending" | "applying" | "applied" | "failed" | "reconcile";
export const OUTBOX_DOCUMENT_VERSION = 1;

export interface ProjectionOperation {
	operationId: string;
	principalId?: string;
	ownerUserId: string;
	projectId: string;
	chatId: string;
	kind: ProjectionOperationKind;
	state: ProjectionOperationState;
	payloadHash: string;
	attempts: number;
	createdAt: string;
	updatedAt: string;
	lastError?: string;
}

export interface EnqueueProjectionOperationInput {
	operationId?: string;
	principalId?: string;
	ownerUserId: string;
	projectId: string;
	chatId: string;
	kind: ProjectionOperationKind;
	payloadHash: string;
	now?: Date;
}
export type ProjectionOperationReference = string | Pick<ProjectionOperation, "principalId" | "chatId" | "operationId">;

export function canonicalProjectionOperationKey(
	principalId: string | undefined,
	chatId: string,
	operationId: string,
): string {
	return JSON.stringify([principalId ?? null, chatId, operationId]);
}
export function assertSameEnqueueIdentity(existing: ProjectionOperation, input: EnqueueProjectionOperationInput): void {
	for (const field of ["ownerUserId", "projectId", "chatId", "kind", "payloadHash"] as const) {
		if (existing[field] !== input[field])
			throw new Error(`Projection operation ID conflict: ${existing.operationId}`);
	}
	if (existing.principalId !== normalizeProjectionPrincipalId(input.principalId))
		throw new Error(`Projection operation ID conflict: ${existing.operationId}`);
}

/** A projection row whose target (project, chat, mapping) no longer exists; settled as obsolete, never retried. */
export class ProjectionObsoleteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectionObsoleteError";
	}
}

export type SameKeyEnqueueDisposition = "idempotent" | "supersede" | "conflict";

/**
 * Decides how a same-key re-enqueue is handled. An identical immutable payload
 * replays idempotently. A different payload for the same logical operation is a
 * conflict only while the row is mid-application (applying): the reconciler is
 * actively writing the old content, so swapping it under the writer is unsafe.
 * Every other state supersedes with the current payload because the operation's
 * projection content legitimately evolved (for example a new adapter version
 * changed how the payload is projected) and the mapping store is the
 * authoritative source of what must be projected.
 */
export function sameKeyEnqueueDisposition(
	existing: ProjectionOperation,
	input: EnqueueProjectionOperationInput,
): SameKeyEnqueueDisposition {
	const identityMatches =
		existing.ownerUserId === input.ownerUserId &&
		existing.projectId === input.projectId &&
		existing.chatId === input.chatId &&
		existing.kind === input.kind &&
		existing.principalId === normalizeProjectionPrincipalId(input.principalId);
	if (!identityMatches) return "conflict";
	if (existing.payloadHash === input.payloadHash) return "idempotent";
	return existing.state === "applying" ? "conflict" : "supersede";
}

export function createPendingProjectionOperation(
	input: EnqueueProjectionOperationInput,
	operationId: string,
	principalId: string | undefined,
	timestamp: string,
): ProjectionOperation {
	return {
		operationId,
		...(principalId === undefined ? {} : { principalId }),
		ownerUserId: input.ownerUserId,
		projectId: input.projectId,
		chatId: input.chatId,
		kind: input.kind,
		state: "pending",
		payloadHash: input.payloadHash,
		attempts: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}
export interface OutboxStore {
	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation;
	markApplying(reference: ProjectionOperationReference, now?: Date): ProjectionOperation;
	markApplied(reference: ProjectionOperationReference, now?: Date): ProjectionOperation;
	markFailed(reference: ProjectionOperationReference, error: string, now?: Date): ProjectionOperation;
	markReconcile(reference: ProjectionOperationReference, now?: Date): ProjectionOperation;
	listPending(): ProjectionOperation[];
	listApplying?(): ProjectionOperation[];
	get(reference: ProjectionOperationReference): ProjectionOperation | undefined;
}

export interface OutboxFileSystem {
	exists(path: string): boolean;
	lstat(path: string): { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean };
	mkdir(path: string, options: { recursive: true }): void;
	open(path: string, flags: string, mode?: number): number;
	readFile(path: string, encoding: "utf8"): string;
	writeFile(fileDescriptor: number, data: string): void;
	fsync(fileDescriptor: number): void;
	close(fileDescriptor: number): void;
	rename(from: string, to: string): void;
	rm(path: string, options: { force: true }): void;
}
export interface PersistedOutboxDocument {
	version: typeof OUTBOX_DOCUMENT_VERSION;
	operations: ProjectionOperation[];
}

export function parsePersistedOutboxDocument(serialized: string): PersistedOutboxDocument {
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch (error) {
		throw new Error(`Invalid outbox document JSON: ${getErrorMessage(error)}`);
	}
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["version", "operations"]) ||
		value.version !== OUTBOX_DOCUMENT_VERSION ||
		!Array.isArray(value.operations)
	) {
		throw new Error("Invalid outbox document");
	}
	const operationKeys = new Set<string>();
	const operations = value.operations.map((operation, index) => {
		const parsed = parseOperation(operation, index);
		const key = canonicalProjectionOperationKey(parsed.principalId, parsed.chatId, parsed.operationId);
		if (operationKeys.has(key)) throw new Error(`Duplicate outbox operation identity: ${parsed.operationId}`);
		operationKeys.add(key);
		return parsed;
	});
	return { version: OUTBOX_DOCUMENT_VERSION, operations };
}

function parseOperation(value: unknown, index: number): ProjectionOperation {
	const keys = [
		"operationId",
		"ownerUserId",
		"projectId",
		"chatId",
		"kind",
		"state",
		"payloadHash",
		"attempts",
		"createdAt",
		"updatedAt",
	];
	const optionalKeys = ["principalId", "lastError"] as const;
	if (!isRecord(value) || !hasOnlyKeys(value, [...keys, ...optionalKeys]) || keys.some(key => !(key in value))) {
		throw new Error(`Invalid outbox operation at index ${index}`);
	}
	const hasLastError = "lastError" in value;
	const lastError = value.lastError;
	const hasPrincipalId = "principalId" in value;
	const principalId = hasPrincipalId ? value.principalId : undefined;
	if (
		!isNonEmptyString(value.operationId) ||
		!isNonEmptyString(value.ownerUserId) ||
		!isNonEmptyString(value.projectId) ||
		!isNonEmptyString(value.chatId) ||
		!isNonEmptyString(value.payloadHash) ||
		!isProjectionKind(value.kind) ||
		!isProjectionState(value.state) ||
		typeof value.attempts !== "number" ||
		!Number.isSafeInteger(value.attempts) ||
		value.attempts < 0 ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt)
	)
		throw new Error(`Invalid outbox operation at index ${index}`);
	let parsedLastError: string | undefined;
	if (hasPrincipalId && !isNonEmptyPrincipalId(principalId))
		throw new Error(`Invalid outbox operation at index ${index}`);
	let parsedPrincipalId: string | undefined;
	if (hasPrincipalId) parsedPrincipalId = normalizeProjectionPrincipalId(principalId as string);
	if (hasLastError) {
		if (typeof lastError !== "string") throw new Error(`Invalid outbox operation at index ${index}`);
		parsedLastError = lastError;
	}
	const operation: ProjectionOperation = {
		operationId: value.operationId,
		...(parsedPrincipalId === undefined ? {} : { principalId: parsedPrincipalId }),
		ownerUserId: value.ownerUserId,
		projectId: value.projectId,
		chatId: value.chatId,
		kind: value.kind,
		state: value.state,
		payloadHash: value.payloadHash,
		attempts: value.attempts,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
	if (parsedLastError !== undefined) operation.lastError = parsedLastError;
	return operation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every(key => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonEmptyPrincipalId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function normalizeProjectionPrincipalId(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!isNonEmptyPrincipalId(value)) throw new Error("Projection operation principal ID must be a non-empty string.");
	return value.trim();
}
function isProjectionKind(value: unknown): value is ProjectionOperationKind {
	return (
		value === "folder" ||
		value === "chat" ||
		value === "chat_message" ||
		value === "event" ||
		value === "session_mapping"
	);
}

function isProjectionState(value: unknown): value is ProjectionOperationState {
	return (
		value === "pending" || value === "applying" || value === "applied" || value === "failed" || value === "reconcile"
	);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function copyOperation(operation: ProjectionOperation): ProjectionOperation {
	return { ...operation };
}

export function toTimestamp(now?: Date): string {
	return (now ?? new Date()).toISOString();
}
