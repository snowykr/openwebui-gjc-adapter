import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildLineageHash, createOperationId } from "./metadata";

export type ProjectionOperationKind = "folder" | "chat" | "chat_message" | "event" | "session_mapping";

export type ProjectionOperationState = "pending" | "applying" | "applied" | "failed" | "reconcile";

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

type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

export function buildProjectionPayloadHash(value: CanonicalJsonValue): string {
	return buildLineageHash([canonicalJson(value)]);
}

export class InMemoryOutboxStore implements OutboxStore {
	private readonly operations = new Map<string, ProjectionOperation>();

	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation {
		const operationId = input.operationId ?? createOperationId(`projection-${input.kind}`, input.now);
		const existing = this.operations.get(operationId);
		if (existing !== undefined) {
			return copyOperation(existing);
		}

		const timestamp = toTimestamp(input.now);
		const operation: ProjectionOperation = {
			operationId,
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
		this.operations.set(operationId, operation);
		return copyOperation(operation);
	}

	markApplying(operationId: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "applying";
		operation.attempts += 1;
		operation.updatedAt = toTimestamp(now);
		operation.lastError = undefined;
		return copyOperation(operation);
	}

	markApplied(operationId: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "applied";
		operation.updatedAt = toTimestamp(now);
		operation.lastError = undefined;
		return copyOperation(operation);
	}

	markFailed(operationId: string, error: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "failed";
		operation.updatedAt = toTimestamp(now);
		operation.lastError = error;
		return copyOperation(operation);
	}

	markReconcile(operationId: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "reconcile";
		operation.updatedAt = toTimestamp(now);
		return copyOperation(operation);
	}

	listPending(): ProjectionOperation[] {
		return Array.from(this.operations.values())
			.filter(operation => operation.state === "pending" || operation.state === "reconcile")
			.map(copyOperation);
	}

	listApplying(): ProjectionOperation[] {
		return Array.from(this.operations.values())
			.filter(operation => operation.state === "applying")
			.map(copyOperation);
	}

	get(operationId: string): ProjectionOperation | undefined {
		const operation = this.operations.get(operationId);
		return operation === undefined ? undefined : copyOperation(operation);
	}

	private requireOperation(operationId: string): ProjectionOperation {
		const operation = this.operations.get(operationId);
		if (operation === undefined) {
			throw new Error(`Unknown projection operation: ${operationId}`);
		}
		return operation;
	}
}

export class FileBackedOutboxStore implements OutboxStore {
	private readonly operations = new Map<string, ProjectionOperation>();

	constructor(private readonly filePath: string) {
		this.load();
	}

	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation {
		const operationId = input.operationId ?? createOperationId(`projection-${input.kind}`, input.now);
		const existing = this.operations.get(operationId);
		if (existing !== undefined) {
			return copyOperation(existing);
		}

		const timestamp = toTimestamp(input.now);
		const operation: ProjectionOperation = {
			operationId,
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
		this.operations.set(operationId, operation);
		this.persist();
		return copyOperation(operation);
	}

	markApplying(operationId: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "applying";
		operation.attempts += 1;
		operation.updatedAt = toTimestamp(now);
		operation.lastError = undefined;
		this.persist();
		return copyOperation(operation);
	}

	markApplied(operationId: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "applied";
		operation.updatedAt = toTimestamp(now);
		operation.lastError = undefined;
		this.persist();
		return copyOperation(operation);
	}

	markFailed(operationId: string, error: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "failed";
		operation.updatedAt = toTimestamp(now);
		operation.lastError = error;
		this.persist();
		return copyOperation(operation);
	}

	markReconcile(operationId: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		operation.state = "reconcile";
		operation.updatedAt = toTimestamp(now);
		this.persist();
		return copyOperation(operation);
	}

	listPending(): ProjectionOperation[] {
		return Array.from(this.operations.values())
			.filter(operation => operation.state === "pending" || operation.state === "reconcile")
			.map(copyOperation);
	}

	listApplying(): ProjectionOperation[] {
		return Array.from(this.operations.values())
			.filter(operation => operation.state === "applying")
			.map(copyOperation);
	}

	get(operationId: string): ProjectionOperation | undefined {
		const operation = this.operations.get(operationId);
		return operation === undefined ? undefined : copyOperation(operation);
	}

	private requireOperation(operationId: string): ProjectionOperation {
		const operation = this.operations.get(operationId);
		if (operation === undefined) {
			throw new Error(`Unknown projection operation: ${operationId}`);
		}
		return operation;
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
			readonly operations?: readonly ProjectionOperation[];
		};
		for (const operation of parsed.operations ?? []) {
			this.operations.set(operation.operationId, copyOperation(operation));
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify({ operations: Array.from(this.operations.values()) }, null, 2));
	}
}

function toTimestamp(now?: Date): string {
	return (now ?? new Date()).toISOString();
}

function copyOperation(operation: ProjectionOperation): ProjectionOperation {
	return { ...operation };
}

function canonicalJson(value: CanonicalJsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Projection payload hash requires finite numbers");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(entry => canonicalJson(entry)).join(",")}]`;
	}
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
