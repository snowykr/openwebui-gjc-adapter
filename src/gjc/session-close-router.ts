import type { SessionOperation, SessionOperationResult } from "./session-authority";
import type { SessionMapping, SessionMappingStore } from "./session-mapping-store";
import { replayCloseOperation } from "./session-operation-codec";
import type { GjcCloseReceipt, GjcLifecycleTransaction } from "./turn-runner";

export type SessionCloseResult =
	| { readonly status: "closed" }
	| { readonly status: "unavailable"; readonly message: string }
	| { readonly status: "uncertain"; readonly message: string };

export interface SessionCloseIngress {
	readonly ingressId: string;
	readonly ingressHash: string;
}

export interface RouteGjcSessionCloseInput extends SessionCloseIngress {
	readonly mapping: SessionMapping;
	readonly mappings: SessionMappingStore;
	readonly lifecycle: GjcLifecycleTransaction;
	readonly close: (receipt: GjcCloseReceipt) => Promise<SessionCloseResult>;
	readonly afterPublish?: (mapping: SessionMapping) => void;
}

export async function routeGjcSessionClose(input: RouteGjcSessionCloseInput): Promise<SessionCloseResult> {
	const prior = input.mappings.operation(input.mapping.chatId, input.ingressId);
	if (prior !== undefined) return replayPriorClose(input, prior);
	input.mappings.beginOperation(input.mapping.chatId, {
		id: input.ingressId,
		kind: "close",
		ingressId: input.ingressId,
		detail: input.ingressHash,
	});
	try {
		const proof = input.mapping.attachment;
		if (!hasOwnedPaneAttachment(proof)) {
			input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "conflict", input.ingressHash);
			return {
				status: "uncertain",
				message: "GJC close requires a complete owned-pane attachment before acknowledgement.",
			};
		}
		let receipt: GjcCloseReceipt;
		try {
			receipt = input.lifecycle.assertClosePreflight(proof);
		} catch (error) {
			const message = error instanceof Error ? error.message : "GJC close receipt could not be established.";
			input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "conflict", input.ingressHash);
			return { status: "uncertain", message };
		}
		const result = await input.close(receipt);
		if (result.status !== "closed") {
			input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "conflict", input.ingressHash);
			return result;
		}
		await input.lifecycle.publishClosed(receipt, () => {
			const mapping = input.mappings.completeOperationWithMapping(
				input.mapping.chatId,
				input.ingressId,
				input.ingressHash,
				input.mapping,
				"close",
			);
			input.afterPublish?.(mapping);
			return mapping;
		});
		return result;
	} catch (error) {
		input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, "uncertain", input.ingressHash);
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
	const currentIndex = operationIndex(persistedOperations, currentOperation);
	const closeIndex = operationIndex(persistedOperations, closeOperation);
	if (currentIndex !== undefined && closeIndex !== undefined) return closeIndex > currentIndex;
	const mappingActivityAt = operationActivityAt(currentOperation);
	const closeActivityAt = operationActivityAt(closeOperation);
	return mappingActivityAt !== undefined && closeActivityAt !== undefined && closeActivityAt > mappingActivityAt;
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
