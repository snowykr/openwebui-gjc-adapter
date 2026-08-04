import { createOperationId } from "./metadata";
import {
	assertSameEnqueueIdentity,
	canonicalProjectionOperationKey,
	copyOperation,
	type EnqueueProjectionOperationInput,
	normalizeProjectionPrincipalId,
	type OutboxStore,
	type ProjectionOperation,
	type ProjectionOperationReference,
	toTimestamp,
} from "./outbox-types";

export { FileBackedOutboxStore, nodeOutboxFileSystem } from "./file-outbox";
export { buildProjectionPayloadHash } from "./outbox-json";
export type {
	EnqueueProjectionOperationInput,
	OutboxFileSystem,
	OutboxStore,
	ProjectionOperation,
	ProjectionOperationKind,
	ProjectionOperationReference,
	ProjectionOperationState,
} from "./outbox-types";
export { canonicalProjectionOperationKey, normalizeProjectionPrincipalId } from "./outbox-types";

export class InMemoryOutboxStore implements OutboxStore {
	private readonly operations = new Map<string, ProjectionOperation>();

	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation {
		const operationId = input.operationId ?? createOperationId(`projection-${input.kind}`, input.now);
		const principalId = normalizeProjectionPrincipalId(input.principalId);
		const key = canonicalProjectionOperationKey(principalId, input.chatId, operationId);
		const normalizedInput =
			principalId === input.principalId
				? input
				: { ...input, ...(principalId === undefined ? {} : { principalId }) };
		const existing = this.operations.get(key);
		if (existing !== undefined) {
			assertSameEnqueueIdentity(existing, normalizedInput);
			return copyOperation(existing);
		}

		const timestamp = toTimestamp(input.now);
		const operation: ProjectionOperation = {
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
		this.operations.set(key, operation);
		return copyOperation(operation);
	}

	markApplying(reference: ProjectionOperationReference, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(reference);
		operation.state = "applying";
		operation.attempts += 1;
		operation.updatedAt = toTimestamp(now);
		operation.lastError = undefined;
		return copyOperation(operation);
	}

	markApplied(reference: ProjectionOperationReference, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(reference);
		operation.state = "applied";
		operation.updatedAt = toTimestamp(now);
		operation.lastError = undefined;
		return copyOperation(operation);
	}

	markFailed(reference: ProjectionOperationReference, error: string, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(reference);
		operation.state = "failed";
		operation.updatedAt = toTimestamp(now);
		operation.lastError = error;
		return copyOperation(operation);
	}

	markReconcile(reference: ProjectionOperationReference, now?: Date): ProjectionOperation {
		const operation = this.requireOperation(reference);
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

	get(reference: ProjectionOperationReference): ProjectionOperation | undefined {
		const key = this.resolveKey(reference);
		if (key === undefined) return undefined;
		const operation = this.operations.get(key);
		return operation === undefined ? undefined : copyOperation(operation);
	}

	private requireOperation(reference: ProjectionOperationReference): ProjectionOperation {
		const key = this.resolveKey(reference);
		const operation = key === undefined ? undefined : this.operations.get(key);
		if (operation === undefined) {
			const operationId = typeof reference === "string" ? reference : reference.operationId;
			throw new Error(`Unknown projection operation: ${operationId}`);
		}
		return operation;
	}

	private resolveKey(reference: ProjectionOperationReference): string | undefined {
		if (typeof reference !== "string") {
			const principalId = normalizeProjectionPrincipalId(reference.principalId);
			return canonicalProjectionOperationKey(principalId, reference.chatId, reference.operationId);
		}
		const matches = Array.from(this.operations.entries()).filter(
			([, operation]) => operation.operationId === reference,
		);
		if (matches.length > 1) throw new Error(`Projection operation ID is ambiguous: ${reference}`);
		return matches[0]?.[0];
	}
}
