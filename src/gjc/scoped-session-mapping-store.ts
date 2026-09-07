import type { SessionMapping, SessionMappingScope, SessionMappingStore } from "./session-mapping-store";

const scopedStoreCache = new WeakMap<object, Map<string, SessionMappingStore>>();

export function scopedSessionMappingStore(
	mappings: SessionMappingStore,
	principalId: string,
	chatId: string,
): SessionMappingStore {
	const key = JSON.stringify([principalId, chatId]);
	let byScope = scopedStoreCache.get(mappings);
	if (byScope === undefined) {
		byScope = new Map();
		scopedStoreCache.set(mappings, byScope);
	}
	const cached = byScope.get(key);
	if (cached !== undefined) return cached;
	const scope: SessionMappingScope = { principalId, chatId };
	const requireChat = (actual: string): void => {
		if (actual !== chatId)
			throw new Error(`Scoped session mapping chat ID ${actual} does not match scope ${chatId}.`);
	};
	const withPrincipal = (mapping: SessionMapping): SessionMapping =>
		mapping.principalId === undefined ? { ...mapping, principalId } : mapping;
	const methods = {
		get: (actual: string) => {
			requireChat(actual);
			return mappings.getScoped(scope);
		},
		set: (mapping: SessionMapping) => mappings.setScoped(scope, withPrincipal(mapping)),
		upsert: (mapping: SessionMapping) => mappings.upsertScoped(scope, withPrincipal(mapping)),
		beginProjectReassignment: (
			actual: string,
			currentProjectId: string,
			nextProjectId: string,
			target?: Parameters<SessionMappingStore["beginProjectReassignmentScoped"]>[3],
		) => {
			requireChat(actual);
			mappings.beginProjectReassignmentScoped(scope, currentProjectId, nextProjectId, target);
		},
		rollbackProjectReassignment: (actual: string, currentProjectId: string) => {
			requireChat(actual);
			mappings.rollbackProjectReassignmentScoped(scope, currentProjectId);
		},
		reassignProjectAuthority: (actual: string, currentProjectId: string, nextProjectId: string) => {
			requireChat(actual);
			mappings.reassignProjectAuthorityScoped(scope, currentProjectId, nextProjectId);
		},
		entries: () => mappings.entriesScoped(scope),
		operation: (actual: string, operationId: string) => {
			requireChat(actual);
			return mappings.operationScoped(scope, operationId);
		},
		operations: (actual: string) => {
			requireChat(actual);
			return mappings.operationsScoped(scope);
		},
		operationAuthority: (actual: string, operationId: string) => {
			requireChat(actual);
			return mappings.operationAuthorityScoped(scope, operationId);
		},
		assertOperationProject: (actual: string, projectId: string, operationId: string) => {
			requireChat(actual);
			mappings.assertOperationProjectScoped(scope, projectId, operationId);
		},
		beginOperation: (actual: string, operation: Parameters<SessionMappingStore["beginOperation"]>[1]) => {
			requireChat(actual);
			mappings.beginOperationScoped(scope, operation);
		},
		recordLifecycleEvidence: (
			actual: string,
			operationId: string,
			payloadHash: string,
			evidence: Parameters<SessionMappingStore["recordLifecycleEvidence"]>[3],
		) => {
			requireChat(actual);
			mappings.recordLifecycleEvidenceScoped(scope, operationId, payloadHash, evidence);
		},
		recordAcknowledgedSuccessor: (
			actual: string,
			operationId: string,
			operationHash: string,
			successor: Parameters<SessionMappingStore["recordAcknowledgedSuccessor"]>[3],
		) => {
			requireChat(actual);
			return mappings.recordAcknowledgedSuccessorScoped(scope, operationId, operationHash, successor);
		},
		recordLateCreateAcknowledgement: (
			actual: string,
			admitted: Parameters<SessionMappingStore["recordLateCreateAcknowledgement"]>[1],
			observation: Parameters<SessionMappingStore["recordLateCreateAcknowledgement"]>[2],
		) => {
			requireChat(actual);
			mappings.recordLateCreateAcknowledgementScoped(scope, admitted, observation);
		},
		recordLateLifecycleAcknowledgement: (
			actual: string,
			admitted: Parameters<SessionMappingStore["recordLateLifecycleAcknowledgement"]>[1],
			observation: Parameters<SessionMappingStore["recordLateLifecycleAcknowledgement"]>[2],
		) => {
			requireChat(actual);
			mappings.recordLateLifecycleAcknowledgementScoped(scope, admitted, observation);
		},
		discardPendingOperation: (
			actual: string,
			operation: Parameters<SessionMappingStore["discardPendingOperation"]>[1],
		) => {
			requireChat(actual);
			mappings.discardPendingOperationScoped(scope, operation);
		},
		discardPendingProvisionalOperation: (
			actual: string,
			operation: Parameters<SessionMappingStore["discardPendingProvisionalOperation"]>[1],
		) => {
			requireChat(actual);
			mappings.discardPendingProvisionalOperationScoped(scope, operation);
		},
		transitionOperation: (
			actual: string,
			operationId: string,
			state: Parameters<SessionMappingStore["transitionOperation"]>[2],
			detail?: string,
			result?: Parameters<SessionMappingStore["transitionOperation"]>[4],
		) => {
			requireChat(actual);
			mappings.transitionOperationScoped(scope, operationId, state, detail, result);
		},
		completeOperationWithMapping: (
			actual: string,
			operationId: string,
			detail: string,
			mapping: SessionMapping,
			kind: Parameters<SessionMappingStore["completeOperationWithMapping"]>[4],
			gate?: Parameters<SessionMappingStore["completeOperationWithMapping"]>[5],
		) => {
			requireChat(actual);
			return mappings.completeOperationWithMappingScoped(
				scope,
				operationId,
				detail,
				withPrincipal(mapping),
				kind,
				gate,
			);
		},
		provisionalOperation: (actual: string, ingressId: string) => {
			requireChat(actual);
			return mappings.provisionalOperationScoped(scope, ingressId);
		},
		reserveProvisionalOperation: (operation: Parameters<SessionMappingStore["reserveProvisionalOperation"]>[0]) =>
			mappings.reserveProvisionalOperationScoped(scope, operation),
		publishProvisionalOperation: (
			operation: Parameters<SessionMappingStore["publishProvisionalOperation"]>[0],
			mapping: SessionMapping,
		) => mappings.publishProvisionalOperationScoped(scope, operation, withPrincipal(mapping)),
		attachProvisionalOperation: (
			actual: string,
			ingressId: string,
			attachment: Parameters<SessionMappingStore["attachProvisionalOperation"]>[2],
		) => {
			requireChat(actual);
			mappings.attachProvisionalOperationScoped(scope, ingressId, attachment);
		},
		transitionProvisionalOperation: (
			actual: string,
			ingressId: string,
			state: Parameters<SessionMappingStore["transitionProvisionalOperation"]>[2],
			detail?: string,
		) => {
			requireChat(actual);
			mappings.transitionProvisionalOperationScoped(scope, ingressId, state, detail);
		},
	};
	const scoped = new Proxy(mappings, {
		get(target, property, receiver) {
			const method = methods[property as keyof typeof methods];
			return method === undefined ? Reflect.get(target, property, receiver) : method;
		},
	});
	byScope.set(key, scoped);
	return scoped;
}
