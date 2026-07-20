import { createOperationId } from "./metadata";
import {
	copyOperation,
	assertSameEnqueueIdentity,
	toTimestamp,
	type EnqueueProjectionOperationInput,
	type OutboxStore,
	type ProjectionOperation,
} from "./outbox-types";

export { FileBackedOutboxStore, nodeOutboxFileSystem } from "./file-outbox";
export { buildProjectionPayloadHash } from "./outbox-json";
export type {
	EnqueueProjectionOperationInput,
	OutboxFileSystem,
	OutboxStore,
	ProjectionOperation,
	ProjectionOperationKind,
	ProjectionOperationState,
} from "./outbox-types";

export class InMemoryOutboxStore implements OutboxStore {
	private readonly operations = new Map<string, ProjectionOperation>();

	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation {
		const operationId = input.operationId ?? createOperationId(`projection-${input.kind}`, input.now);
		const existing = this.operations.get(operationId);
		if (existing !== undefined) {
			assertSameEnqueueIdentity(existing, input);
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