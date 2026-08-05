import type { OutboxStore, ProjectionOperation } from "./outbox";
import { ProjectionObsoleteError } from "./outbox-types";

export type ProjectionOperationApplier = (operation: ProjectionOperation) => void | Promise<void>;

export interface ReconcilePendingOperationsResult {
	applied: ProjectionOperation[];
	failed: ProjectionOperation[];
}

export async function reconcilePendingOperations(
	store: OutboxStore,
	applier: ProjectionOperationApplier,
): Promise<ReconcilePendingOperationsResult> {
	const applied: ProjectionOperation[] = [];
	const failed: ProjectionOperation[] = [];

	recoverApplyingOperations(store);
	for (const pendingOperation of store.listPending()) {
		const applyingOperation = store.markApplying(pendingOperation);
		try {
			await applier(applyingOperation);
			applied.push(store.markApplied(applyingOperation));
		} catch (error) {
			if (error instanceof ProjectionObsoleteError) {
				// The projection target (project, chat, or mapping authority) no
				// longer exists; settle the row so it is not retried forever.
				applied.push(store.markApplied(applyingOperation));
				continue;
			}
			const failedOperation = store.markFailed(applyingOperation, getErrorMessage(error));
			failed.push(failedOperation);
			store.markReconcile(failedOperation);
		}
	}

	return { applied, failed };
}

export function recoverApplyingOperations(store: OutboxStore): ProjectionOperation[] {
	const applyingOperations = store.listApplying?.() ?? [];
	return applyingOperations.map(operation => store.markReconcile(operation));
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
