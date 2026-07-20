export type ProjectionOperationKind = "folder" | "chat" | "chat_message" | "event" | "session_mapping";

export type ProjectionOperationState = "pending" | "applying" | "applied" | "failed" | "reconcile";
export const OUTBOX_DOCUMENT_VERSION = 1;

export interface ProjectionOperation {
	operationId: string;
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
	ownerUserId: string;
	projectId: string;
	chatId: string;
	kind: ProjectionOperationKind;
	payloadHash: string;
	now?: Date;
}
export function assertSameEnqueueIdentity(existing: ProjectionOperation, input: EnqueueProjectionOperationInput): void {
	for (const field of ["ownerUserId", "projectId", "chatId", "kind", "payloadHash"] as const) {
		if (existing[field] !== input[field])
			throw new Error(`Projection operation ID conflict: ${existing.operationId}`);
	}
}

export interface OutboxStore {
	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation;
	markApplying(operationId: string, now?: Date): ProjectionOperation;
	markApplied(operationId: string, now?: Date): ProjectionOperation;
	markFailed(operationId: string, error: string, now?: Date): ProjectionOperation;
	markReconcile(operationId: string, now?: Date): ProjectionOperation;
	listPending(): ProjectionOperation[];
	listApplying?(): ProjectionOperation[];
	get(operationId: string): ProjectionOperation | undefined;
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
	const operationIds = new Set<string>();
	const operations = value.operations.map((operation, index) => {
		const parsed = parseOperation(operation, index);
		if (operationIds.has(parsed.operationId)) throw new Error(`Duplicate outbox operation ID: ${parsed.operationId}`);
		operationIds.add(parsed.operationId);
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
	if (!isRecord(value) || !hasOnlyKeys(value, [...keys, "lastError"]) || keys.some(key => !(key in value))) {
		throw new Error(`Invalid outbox operation at index ${index}`);
	}
	const hasLastError = "lastError" in value;
	const lastError = value.lastError;
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
	if (hasLastError) {
		if (typeof lastError !== "string") throw new Error(`Invalid outbox operation at index ${index}`);
		parsedLastError = lastError;
	}
	const operation: ProjectionOperation = {
		operationId: value.operationId,
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
