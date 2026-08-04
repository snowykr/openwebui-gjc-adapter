import type { SessionOperation, SessionOperationResult } from "./session-authority";
import type { SessionMapping, SessionMappingStore } from "./session-mapping-store";
import { replayCloseOperation } from "./session-operation-codec";
import { scopedSessionMappingStore } from "./session-turn-router";
import type { GjcCloseReceipt, GjcLifecycleTransaction } from "./turn-runner";

export type SessionCloseResult =
	| { readonly status: "closed" }
	| { readonly status: "unavailable"; readonly message: string }
	| { readonly status: "uncertain"; readonly message: string };

export interface SessionCloseIngress {
	readonly ingressId: string;
	readonly ingressHash: string;
	readonly legacyIngress?: SessionCloseIngress;
}

export interface RouteGjcSessionCloseInput extends SessionCloseIngress {
	readonly mapping: SessionMapping;
	readonly mappings: SessionMappingStore;
	readonly lifecycle: GjcLifecycleTransaction;
	readonly close: (receipt: GjcCloseReceipt) => Promise<SessionCloseResult>;
	readonly afterPublish?: (mapping: SessionMapping) => void;
}

export async function routeGjcSessionClose(input: RouteGjcSessionCloseInput): Promise<SessionCloseResult> {
	const scopedMappings =
		typeof input.mapping.principalId === "string" && input.mapping.principalId.trim().length > 0
			? scopedSessionMappingStore(input.mappings, input.mapping.principalId, input.mapping.chatId)
			: input.mappings;
	const scopedInput = scopedMappings === input.mappings ? input : { ...input, mappings: scopedMappings };
	const prior =
		scopedInput.mappings.operation(scopedInput.mapping.chatId, scopedInput.ingressId) ??
		(scopedInput.legacyIngress === undefined
			? undefined
			: scopedInput.mappings.operation(scopedInput.mapping.chatId, scopedInput.legacyIngress.ingressId));
	if (prior !== undefined) {
		const replayInput =
			scopedInput.legacyIngress !== undefined && prior.id === scopedInput.legacyIngress.ingressId
				? { ...scopedInput, ...scopedInput.legacyIngress }
				: scopedInput;
		return replayPriorClose(replayInput, prior);
	}
	scopedInput.mappings.beginOperation(scopedInput.mapping.chatId, {
		id: scopedInput.ingressId,
		kind: "close",
		ingressId: scopedInput.ingressId,
		detail: scopedInput.ingressHash,
	});
	try {
		const proof = scopedInput.mapping.attachment;
		if (!hasOwnedPaneAttachment(proof)) {
			scopedInput.mappings.transitionOperation(
				scopedInput.mapping.chatId,
				scopedInput.ingressId,
				"conflict",
				scopedInput.ingressHash,
			);
			return {
				status: "uncertain",
				message: "GJC close requires a complete owned-pane attachment before acknowledgement.",
			};
		}
		let receipt: GjcCloseReceipt;
		try {
			receipt = scopedInput.lifecycle.assertClosePreflight(proof);
		} catch (error) {
			const message = error instanceof Error ? error.message : "GJC close receipt could not be established.";
			scopedInput.mappings.transitionOperation(
				scopedInput.mapping.chatId,
				scopedInput.ingressId,
				"conflict",
				scopedInput.ingressHash,
			);
			return { status: "uncertain", message };
		}
		const result = await scopedInput.close(receipt);
		if (result.status !== "closed") {
			scopedInput.mappings.transitionOperation(
				scopedInput.mapping.chatId,
				scopedInput.ingressId,
				"conflict",
				scopedInput.ingressHash,
			);
			return result;
		}
		await scopedInput.lifecycle.publishClosed(receipt, () => {
			const mapping = scopedInput.mappings.completeOperationWithMapping(
				scopedInput.mapping.chatId,
				scopedInput.ingressId,
				scopedInput.ingressHash,
				scopedInput.mapping,
				"close",
			);
			scopedInput.afterPublish?.(mapping);
			return mapping;
		});
		return result;
	} catch (error) {
		scopedInput.mappings.transitionOperation(
			scopedInput.mapping.chatId,
			scopedInput.ingressId,
			"uncertain",
			scopedInput.ingressHash,
		);
		throw error;
	}
}

function replayPriorClose(input: RouteGjcSessionCloseInput, prior: SessionOperation): SessionCloseResult {
	if (prior.kind !== "close" || prior.detail !== input.ingressHash)
		throw new Error(`GJC close ${input.ingressId} conflicts with a different ingress payload.`);
	if (prior.state === "complete") {
		const currentMapping = input.mappings.get(input.mapping.chatId) ?? input.mapping;
		const currentOperation = input.mappings.operation(input.mapping.chatId, currentMapping.operationId);
		const persistedOperations = input.mappings.operations(input.mapping.chatId);
		input.afterPublish?.(input.mapping);
		return replayCloseOperation(
			input.ingressId,
			prior.result,
			currentMapping.operationId,
			legacyCloseMappingCompatible(prior.result, currentMapping, prior, currentOperation, persistedOperations),
		);
	}
	if (prior.state === "pending") throw new Error(`GJC close ${input.ingressId} is pending and cannot be replayed.`);
	throw new Error(`GJC close ${input.ingressId} requires reconciliation.`);
}

function legacyCloseMappingCompatible(
	result: SessionOperationResult | undefined,
	mapping: SessionMapping,
	closeOperation: SessionOperation,
	currentOperation: SessionOperation | undefined,
	persistedOperations: readonly SessionOperation[],
): boolean {
	const resultMapping = result?.mapping;
	if (
		result?.correlation?.mappingOperationId !== undefined ||
		resultMapping === undefined ||
		resultMapping.chatId !== mapping.chatId ||
		resultMapping.projectId !== mapping.projectId ||
		resultMapping.sessionId !== mapping.sessionId ||
		resultMapping.sessionFile !== mapping.sessionFile ||
		JSON.stringify(resultMapping.attachment) !== JSON.stringify(mapping.attachment)
	)
		return false;
	return operationFollowsMapping(closeOperation, currentOperation, persistedOperations);
}
function operationFollowsMapping(
	operation: SessionOperation,
	currentOperation: SessionOperation | undefined,
	persistedOperations: readonly SessionOperation[],
): boolean {
	const mappingActivityAt = operationActivityAt(currentOperation);
	const operationAt = operationActivityAt(operation);
	if (mappingActivityAt === undefined || operationAt === undefined) return false;
	if (operationAt !== mappingActivityAt) return operationAt > mappingActivityAt;
	const currentIndex = operationIndex(persistedOperations, currentOperation);
	const operationIndexAt = operationIndex(persistedOperations, operation);
	return currentIndex !== undefined && operationIndexAt !== undefined && operationIndexAt > currentIndex;
}

function operationIndex(
	operations: readonly SessionOperation[],
	target: SessionOperation | undefined,
): number | undefined {
	if (target === undefined) return undefined;
	const index = operations.findIndex(
		operation =>
			operation.id === target.id || (operation.ingressId !== undefined && operation.ingressId === target.ingressId),
	);
	return index < 0 ? undefined : index;
}

function operationActivityAt(
	operation: Pick<SessionOperation, "startedAt" | "completedAt"> | undefined,
): number | undefined {
	if (operation === undefined) return undefined;
	const completedAt = parseTimestamp(operation.completedAt);
	if (completedAt !== undefined) return completedAt;
	return parseTimestamp(operation.startedAt);
}

function parseTimestamp(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function hasOwnedPaneAttachment(
	proof: SessionMapping["attachment"],
): proof is NonNullable<SessionMapping["attachment"]> &
	Required<
		Pick<NonNullable<SessionMapping["attachment"]>, "tmuxSocket" | "tmuxPane" | "tmuxPanePid" | "tmuxOwnershipTag">
	> {
	return (
		proof?.tmuxSocket !== undefined &&
		proof.tmuxPane !== undefined &&
		proof.tmuxPanePid !== undefined &&
		proof.tmuxOwnershipTag !== undefined
	);
}
