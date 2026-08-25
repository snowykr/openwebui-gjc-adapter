import type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "../live/gjc-routing-lifecycle";
import type { TenantSessionKey } from "./managed-sdk-runtime";
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
	readonly managedSdkRuntime?: ManagedSdkRuntimeDependency;
	readonly managedSdkTenantFence?: ManagedSdkTenantFence;
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
	if (isCompleteManagedAuthority(scopedInput.mapping)) return routeManagedSessionClose(scopedInput);
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

async function routeManagedSessionClose(input: RouteGjcSessionCloseInput): Promise<SessionCloseResult> {
	const authority = input.mapping.managedAuthority;
	if (!isCompleteManagedAuthority(input.mapping) || authority === undefined)
		throw new Error("Managed GJC close requires complete managed authority.");
	input.mappings.beginOperation(input.mapping.chatId, {
		id: input.ingressId,
		kind: "close",
		ingressId: input.ingressId,
		detail: input.ingressHash,
	});
	const runtime = input.managedSdkRuntime;
	const tenantFence = input.managedSdkTenantFence;
	if (runtime === undefined || tenantFence === undefined) {
		return managedCloseFailure(input, "Managed GJC close runtime or tenant fence is unavailable.");
	}
	const tenant: TenantSessionKey = {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
	};
	try {
		if (!(await tenantFence(tenant)))
			return managedCloseFailure(input, "Managed tenant authority fence was lost before close.");
		const outcome = await runtime.closeLifecycleSession({
			actor: { id: authority.principalId, namespace: "openwebui-gjc-adapter" },
			capability: "session.close",
			requestKey: input.ingressId,
			target: { sessionId: authority.sessionId, endpointGeneration: authority.generation },
		});
		if (!(await tenantFence(tenant)))
			return managedCloseFailure(
				input,
				"Managed tenant authority fence was lost after close.",
				"uncertain",
				"uncertain",
			);
		await runtime.reconcile();
		const status = await runtime.generationStatus(tenant);
		if (status.status === "retired") {
			const mapping = input.mappings.completeOperationWithMapping(
				input.mapping.chatId,
				input.ingressId,
				input.ingressHash,
				input.mapping,
				"close",
			);
			input.afterPublish?.(mapping);
			return { status: "closed" };
		}
		if (status.status === "current" && !outcome.ok && outcome.certainty === "retryable")
			return managedCloseFailure(
				input,
				"Managed session close was not dispatched; the exact generation remains current.",
				"unavailable",
			);
		return managedCloseFailure(input, `Exact managed generation close is ${status.status}.`);
	} catch (error) {
		return managedCloseFailure(
			input,
			error instanceof Error ? error.message : "Managed generation close is uncertain.",
			"uncertain",
			"uncertain",
		);
	}
}

function managedCloseFailure(
	input: RouteGjcSessionCloseInput,
	message: string,
	status: "uncertain" | "unavailable" = "uncertain",
	operationState: "conflict" | "uncertain" = "conflict",
): SessionCloseResult {
	input.mappings.transitionOperation(input.mapping.chatId, input.ingressId, operationState, input.ingressHash);
	return { status, message };
}

function isCompleteManagedAuthority(
	mapping: SessionMapping,
): mapping is SessionMapping & { readonly managedAuthority: NonNullable<SessionMapping["managedAuthority"]> } {
	const authority = mapping.managedAuthority;
	return (
		authority !== undefined &&
		authority.chatId === mapping.chatId &&
		authority.projectId === mapping.projectId &&
		authority.sessionId === mapping.sessionId &&
		(typeof mapping.principalId !== "string" || authority.principalId === mapping.principalId) &&
		[
			authority.principalId,
			authority.projectId,
			authority.canonicalWorkspace,
			authority.chatId,
			authority.sessionId,
		].every(value => typeof value === "string" && value.length > 0) &&
		Number.isSafeInteger(authority.generation) &&
		authority.generation > 0 &&
		[authority.leaseId, authority.epoch, authority.requestKey].every(
			value => typeof value === "string" && value.length > 0,
		)
	);
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
			isCompleteManagedAuthority(currentMapping)
				? managedCloseMappingCompatible(prior.result, currentMapping, prior, currentOperation, persistedOperations)
				: legacyCloseMappingCompatible(prior.result, currentMapping, prior, currentOperation, persistedOperations),
		);
	}
	if (prior.state === "pending") throw new Error(`GJC close ${input.ingressId} is pending and cannot be replayed.`);
	throw new Error(`GJC close ${input.ingressId} requires reconciliation.`);
}

function managedCloseMappingCompatible(
	result: SessionOperationResult | undefined,
	mapping: SessionMapping,
	closeOperation: SessionOperation,
	currentOperation: SessionOperation | undefined,
	persistedOperations: readonly SessionOperation[],
): boolean {
	const resultMapping = result?.mapping;
	if (
		resultMapping === undefined ||
		resultMapping.chatId !== mapping.chatId ||
		resultMapping.projectId !== mapping.projectId ||
		resultMapping.sessionId !== mapping.sessionId ||
		resultMapping.sessionFile !== mapping.sessionFile ||
		resultMapping.attachment !== undefined ||
		mapping.attachment !== undefined
	)
		return false;
	return operationFollowsMapping(closeOperation, currentOperation, persistedOperations);
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
