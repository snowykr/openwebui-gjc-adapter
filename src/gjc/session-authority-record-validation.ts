import { isAbsolute } from "node:path";
import {
	hasManagedHistoricalSourceChat,
	isManagedCatalogProvisional,
	type ManagedHistoricalAssociationOwner,
	managedHistoricalPublicationAssociation,
	managedHistoricalSourceAssociation,
} from "./managed-lifecycle-evidence";
import { operationIdentity } from "./session-authority-operation-identity";
import {
	isAttachmentProof,
	isEvent,
	isNormalizedModelSelection,
	isOperation,
} from "./session-authority-operation-validation";
import type {
	ProvisionalSessionOperation,
	SessionAuthorityRecord,
	SessionAuthorityTombstone,
	SessionOperation,
} from "./session-authority-types";
import { SESSION_AUTHORITY_VERSION } from "./session-authority-types";
import { isHistoricalSessionBinding, SESSION_AUTHORITY_V3_EPOCH } from "./session-authority-v3";
import {
	hasOnlyKeys,
	isJsonValue,
	isNonEmptyString,
	isNonnegativeSafeInteger,
	isRecord,
	isTimestamp,
} from "./session-authority-validation-primitives";
import { operationIdentifiers } from "./session-operation-codec";
import type { ManagedTurnAuthority } from "./turn-runner";

export function isV2Record(value: unknown): value is SessionAuthorityRecord {
	if (
		!hasOnlyKeys(value, [
			"version",
			"chatId",
			"projectId",
			"sessionId",
			"createdAt",
			"header",
			"sessionFile",
			"activeLeaf",
			"rawFrameCursor",
			"eventCursor",
			"operationId",
			"assistantText",
			"events",
			"modelSelection",
			"observations",
			"attachment",
			"managedAuthority",
			"journal",
			"reassignment",
		]) ||
		value.version !== SESSION_AUTHORITY_VERSION
	)
		return false;
	if (
		![value.chatId, value.projectId, value.sessionId, value.createdAt, value.operationId].every(isNonEmptyString) ||
		!isTimestamp(value.createdAt)
	)
		return false;
	if (
		!hasOnlyKeys(value.header, ["chatId", "projectId", "sessionId"]) ||
		value.header.chatId !== value.chatId ||
		value.header.projectId !== value.projectId ||
		value.header.sessionId !== value.sessionId
	)
		return false;
	if (
		!isNonnegativeSafeInteger(value.rawFrameCursor) ||
		!isNonnegativeSafeInteger(value.eventCursor) ||
		!Array.isArray(value.journal)
	)
		return false;
	if (value.sessionFile !== undefined && (!isNonEmptyString(value.sessionFile) || !isAbsolute(value.sessionFile)))
		return false;
	if (value.activeLeaf !== undefined && !isNonEmptyString(value.activeLeaf)) return false;
	if (value.assistantText !== undefined && typeof value.assistantText !== "string") return false;
	if (value.events !== undefined && (!Array.isArray(value.events) || !value.events.every(isEvent))) return false;
	if (value.observations !== undefined && (!isRecord(value.observations) || !isJsonValue(value.observations)))
		return false;
	return (
		(value.modelSelection === undefined || isNormalizedModelSelection(value.modelSelection)) &&
		(value.attachment === undefined ||
			(isAttachmentProof(value.attachment) && value.attachment.expectedSessionId === value.sessionId)) &&
		(value.managedAuthority === undefined ||
			isManagedTurnAuthority(value.managedAuthority, {
				chatId: value.chatId as string,
				projectId: value.projectId as string,
				sessionId: value.sessionId as string,
			})) &&
		value.journal.every(isOperation) &&
		(value.reassignment === undefined ||
			isReassignment(value.reassignment, { chatId: value.chatId as string, projectId: value.projectId as string }))
	);
}

export function isProvisionalOperation(value: unknown): value is ProvisionalSessionOperation {
	if (
		!hasOnlyKeys(value, [
			"id",
			"kind",
			"state",
			"ingressId",
			"startedAt",
			"completedAt",
			"detail",
			"result",
			"chatId",
			"projectId",
			"sessionId",
			"sessionFile",
			"attachment",
			"managedAuthority",
		]) ||
		!isNonEmptyString(value.chatId) ||
		!isNonEmptyString(value.projectId)
	)
		return false;
	if (value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) return false;
	if (value.sessionFile !== undefined && (!isNonEmptyString(value.sessionFile) || !isAbsolute(value.sessionFile)))
		return false;
	if (
		value.attachment !== undefined &&
		(!isAttachmentProof(value.attachment) || value.attachment.expectedSessionId !== value.sessionId)
	)
		return false;
	if (
		value.managedAuthority !== undefined &&
		(!isManagedTurnAuthority(value.managedAuthority, {
			chatId: value.chatId,
			projectId: value.projectId,
			sessionId: value.sessionId,
		}) ||
			value.sessionId === undefined)
	)
		return false;
	const {
		chatId: _chatId,
		projectId: _projectId,
		sessionId: _sessionId,
		sessionFile: _sessionFile,
		attachment: _attachment,
		managedAuthority: _managedAuthority,
		...operation
	} = value;
	return isOperation(operation);
}

export function isAuthorityDocumentRelationallyValid(
	mappings: Iterable<SessionAuthorityRecord>,
	provisionalOperations: Iterable<ProvisionalSessionOperation>,
): boolean {
	const chatIds = new Set<string>();
	const identities = new Map<string, string>();
	const provisionalIdentities = new Set<string>();
	const projectsByChatId = new Map<string, string>();
	const mappingByChatId = new Map<string, SessionAuthorityRecord>();
	for (const mapping of mappings) {
		if (chatIds.has(mapping.chatId)) return false;
		chatIds.add(mapping.chatId);
		projectsByChatId.set(mapping.chatId, mapping.projectId);
		mappingByChatId.set(mapping.chatId, mapping);
		if (!hasUniqueJournalIdentities(mapping) || !hasConsistentOperationResults(mapping, mapping)) return false;
		for (const operation of mapping.journal)
			for (const identifier of operationIdentifiers(operation))
				if (!addIdentity(identities, mapping.chatId, identifier, operationIdentity(operation))) return false;
		for (const root of reassignmentTombstoneRoots(mapping.reassignment)) {
			let tombstone: SessionAuthorityTombstone | undefined = root;
			while (tombstone !== undefined) {
				if (
					tombstone.historicalBinding !== undefined &&
					!isHistoricalSessionBinding(tombstone.historicalBinding, tombstone)
				)
					return false;
				if (
					tombstone.chatId !== mapping.chatId &&
					(tombstone.historicalBinding === undefined ||
						managedHistoricalSourceAssociation(mapping, tombstone.historicalBinding) === undefined)
				)
					return false;
				if (!hasUniqueTombstoneIdentities(tombstone) || !hasConsistentTombstoneResults(tombstone, mapping))
					return false;
				for (const operation of tombstone.journal)
					for (const identifier of operationIdentifiers(operation))
						if (!addIdentity(identities, mapping.chatId, identifier, operationIdentity(operation))) return false;
				tombstone = tombstone.prior;
			}
		}
	}
	const allMappings = [...mappingByChatId.values()];
	if (
		allMappings.some(root =>
			allMappings.some(other => other !== root && hasManagedHistoricalSourceChat(root, other.chatId)),
		)
	)
		return false;
	for (const operation of provisionalOperations) {
		if (!isManagedCatalogProvisional(operation)) return false;
		const direct = mappingByChatId.get(operation.chatId);
		const associated = [...mappingByChatId.values()].filter(
			candidate =>
				candidate.chatId !== operation.chatId &&
				managedHistoricalPublicationAssociation(candidate, operation) !== undefined,
		);
		if (associated.length > 1 || (direct !== undefined && associated.length !== 0)) return false;
		const mapping = direct ?? associated[0];
		if (
			mapping === undefined &&
			[...mappingByChatId.values()].some(candidate => hasManagedHistoricalSourceChat(candidate, operation.chatId))
		)
			return false;
		const namespace = mapping?.chatId ?? operation.chatId;
		const activeProject = projectsByChatId.get(namespace);
		const reassignment = mapping?.reassignment;
		if (activeProject !== undefined && activeProject !== operation.projectId) {
			const matchesReassignmentTarget =
				reassignment !== undefined &&
				(reassignment.state === "pending" || reassignment.state === "rolled_back") &&
				reassignment.targetProjectId === operation.projectId &&
				reassignment.target !== undefined &&
				sameTargetIdentity(operation, reassignment.target);
			const isRetiredSourceEvidence =
				operation.state === "complete" &&
				mapping !== undefined &&
				reassignmentTombstoneChainContainsProject(mapping.reassignment, operation.projectId);
			if (
				(!matchesReassignmentTarget && !isRetiredSourceEvidence) ||
				(matchesReassignmentTarget &&
					reassignment.state === "rolled_back" &&
					operation.state !== "uncertain" &&
					operation.state !== "conflict")
			)
				return false;
		}
		const identity = operationIdentity(operation);
		for (const identifier of operationIdentifiers(operation)) {
			const key = `${namespace}\u0000${identifier}`,
				prior = identities.get(key);
			if (provisionalIdentities.has(key) || (prior !== undefined && prior !== identity)) return false;
			provisionalIdentities.add(key);
			identities.set(key, identity);
		}
		if (operation.cleanup !== undefined)
			for (const identifier of operationIdentifiers(operation.cleanup)) {
				const key = `${namespace}\u0000${identifier}`;
				if (provisionalIdentities.has(key) || identities.has(key)) return false;
				provisionalIdentities.add(key);
				identities.set(key, operationIdentity(operation.cleanup));
			}
	}
	return true;
}

function hasUniqueJournalIdentities(mapping: SessionAuthorityRecord): boolean {
	const identifiers = new Set<string>();
	for (const operation of mapping.journal) {
		for (const identifier of operationIdentifiers(operation)) {
			if (identifiers.has(identifier)) return false;
			identifiers.add(identifier);
		}
	}
	return true;
}

function hasConsistentOperationResults(
	mapping: SessionAuthorityRecord,
	root: ManagedHistoricalAssociationOwner,
): boolean {
	return mapping.journal.every(operation => {
		if (!hasConsistentSuccessor(mapping, operation, root)) return false;
		if (operation.result === undefined) return true;
		const resultMapping = operation.result.mapping;
		if (
			(resultMapping.chatId !== root.chatId &&
				(operation.result.historicalBinding === undefined ||
					managedHistoricalSourceAssociation(root, operation.result.historicalBinding, operation) ===
						undefined)) ||
			resultMapping.projectId !== mapping.projectId ||
			!hasConsistentResultSession(mapping, operation) ||
			resultMapping.operationId !== operation.id
		)
			return false;
		const correlation = operation.result.correlation;
		return (
			correlation === undefined ||
			((correlation.chatId === undefined || correlation.chatId === resultMapping.chatId) &&
				(correlation.projectId === undefined || correlation.projectId === mapping.projectId) &&
				(correlation.operationId === undefined || correlation.operationId === operation.id))
		);
	});
}

function hasConsistentSuccessor(
	owner: ManagedHistoricalAssociationOwner,
	operation: SessionOperation,
	root: ManagedHistoricalAssociationOwner,
): boolean {
	const successor = operation.acknowledgedSuccessor;
	if (successor === undefined || "attachment" in successor) return true;
	if (successor.historicalBinding !== undefined) {
		const history = successor.historicalBinding;
		return (
			isHistoricalSessionBinding(history, {
				chatId: history.chatId,
				projectId: owner.projectId,
				sessionId: successor.sessionId,
			}) &&
			(history.chatId === root.chatId ||
				managedHistoricalSourceAssociation(root, history, operation) !== undefined) &&
			(owner.managedAuthority === undefined ||
				((history.principalId === undefined || history.principalId === owner.managedAuthority.principalId) &&
					(history.canonicalWorkspace === undefined ||
						history.canonicalWorkspace === owner.managedAuthority.canonicalWorkspace)))
		);
	}
	return (
		successor.managedAuthority !== undefined &&
		successor.managedAuthority.chatId === root.chatId &&
		isManagedTurnAuthority(successor.managedAuthority, {
			chatId: owner.chatId,
			projectId: owner.projectId,
			sessionId: successor.sessionId,
		}) &&
		(owner.managedAuthority === undefined ||
			(successor.managedAuthority.principalId === owner.managedAuthority.principalId &&
				successor.managedAuthority.canonicalWorkspace === owner.managedAuthority.canonicalWorkspace))
	);
}

function hasConsistentResultSession(
	owner: Pick<SessionAuthorityRecord, "chatId" | "projectId" | "sessionId" | "managedAuthority">,
	operation: SessionOperation,
): boolean {
	const result = operation.result;
	if (result === undefined) return true;
	if (result.historicalBinding !== undefined) {
		const history = result.historicalBinding;
		return (
			operation.state === "complete" &&
			isHistoricalSessionBinding(history, result.mapping) &&
			(owner.managedAuthority === undefined ||
				((history.principalId === undefined || history.principalId === owner.managedAuthority.principalId) &&
					(history.canonicalWorkspace === undefined ||
						history.canonicalWorkspace === owner.managedAuthority.canonicalWorkspace)))
		);
	}
	const authority = result.managedAuthority;
	if (authority === undefined) return result.mapping.sessionId === owner.sessionId;
	return (
		operation.state === "complete" &&
		owner.managedAuthority !== undefined &&
		authority.principalId === owner.managedAuthority.principalId &&
		authority.canonicalWorkspace === owner.managedAuthority.canonicalWorkspace &&
		isManagedTurnAuthority(authority, result.mapping)
	);
}

function isReassignment(value: unknown, record: Pick<SessionAuthorityRecord, "chatId" | "projectId">): boolean {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"state",
			"sourceProjectId",
			"targetProjectId",
			"startedAt",
			"completedAt",
			"target",
			"sourceTombstone",
			"priorTombstone",
		]) ||
		(value.state !== "pending" && value.state !== "rolled_back" && value.state !== "committed") ||
		!isNonEmptyString(value.sourceProjectId) ||
		!isNonEmptyString(value.targetProjectId) ||
		(value.state === "committed"
			? value.targetProjectId !== record.projectId
			: value.sourceProjectId !== record.projectId) ||
		value.sourceProjectId === value.targetProjectId ||
		!isTimestamp(value.startedAt)
	)
		return false;
	if (value.completedAt !== undefined && !isTimestamp(value.completedAt)) return false;
	if (value.target !== undefined && !isTargetIdentity(value.target)) return false;
	if (value.priorTombstone !== undefined && !isTombstone(value.priorTombstone)) return false;
	if (value.state === "pending" && value.sourceTombstone !== undefined) return false;
	if (value.state === "committed" && !isTombstone(value.sourceTombstone)) return false;
	if (value.sourceTombstone !== undefined) {
		if (
			!isTombstone(value.sourceTombstone) ||
			value.sourceTombstone.chatId !== record.chatId ||
			value.sourceTombstone.projectId !== value.sourceProjectId
		)
			return false;
	}
	return true;
}

function isTargetIdentity(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["id", "ingressId", "kind", "detail"]) &&
		isNonEmptyString(value.id) &&
		(value.ingressId === undefined || isNonEmptyString(value.ingressId)) &&
		typeof value.kind === "string" &&
		["create", "resume", "close", "prompt", "reply", "gate", "branch", "model", "thinking"].includes(value.kind) &&
		(value.detail === undefined || typeof value.detail === "string")
	);
}

function isTombstone(value: unknown): value is SessionAuthorityTombstone {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"version",
			"chatId",
			"projectId",
			"sessionId",
			"createdAt",
			"header",
			"sessionFile",
			"activeLeaf",
			"rawFrameCursor",
			"eventCursor",
			"operationId",
			"assistantText",
			"events",
			"modelSelection",
			"observations",
			"attachment",
			"managedAuthority",
			"journal",
			"retiredAt",
			"prior",
		]) ||
		value.version !== SESSION_AUTHORITY_VERSION ||
		![value.chatId, value.projectId, value.sessionId, value.createdAt, value.operationId, value.retiredAt].every(
			isNonEmptyString,
		) ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.retiredAt) ||
		!hasOnlyKeys(value.header, ["chatId", "projectId", "sessionId"]) ||
		value.header.chatId !== value.chatId ||
		value.header.projectId !== value.projectId ||
		value.header.sessionId !== value.sessionId ||
		!isNonnegativeSafeInteger(value.rawFrameCursor) ||
		!isNonnegativeSafeInteger(value.eventCursor) ||
		!Array.isArray(value.journal) ||
		(value.sessionFile !== undefined && (!isNonEmptyString(value.sessionFile) || !isAbsolute(value.sessionFile))) ||
		(value.activeLeaf !== undefined && !isNonEmptyString(value.activeLeaf)) ||
		(value.assistantText !== undefined && typeof value.assistantText !== "string") ||
		(value.events !== undefined && (!Array.isArray(value.events) || !value.events.every(isEvent))) ||
		(value.observations !== undefined && (!isRecord(value.observations) || !isJsonValue(value.observations))) ||
		(value.modelSelection !== undefined && !isNormalizedModelSelection(value.modelSelection)) ||
		(value.attachment !== undefined &&
			(!isAttachmentProof(value.attachment) || value.attachment.expectedSessionId !== value.sessionId)) ||
		(value.managedAuthority !== undefined &&
			!isManagedTurnAuthority(value.managedAuthority, {
				chatId: value.chatId as string,
				projectId: value.projectId as string,
				sessionId: value.sessionId as string,
			})) ||
		!value.journal.every(isOperation) ||
		(value.prior !== undefined && !isTombstone(value.prior))
	)
		return false;
	return true;
}

function isManagedTurnAuthority(
	value: unknown,
	identity: Readonly<{ chatId: string; projectId: string; sessionId: string | undefined }>,
): value is ManagedTurnAuthority {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			"authorityEpoch",
			"principalId",
			"projectId",
			"canonicalWorkspace",
			"chatId",
			"sessionId",
			"generation",
			"leaseId",
			"epoch",
			"requestKey",
		]) &&
		(value.authorityEpoch === undefined || value.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH) &&
		isNonEmptyString(value.principalId) &&
		value.projectId === identity.projectId &&
		isNonEmptyString(value.canonicalWorkspace) &&
		isAbsolute(value.canonicalWorkspace) &&
		value.chatId === identity.chatId &&
		value.sessionId === identity.sessionId &&
		isNonnegativeSafeInteger(value.generation) &&
		value.generation > 0 &&
		isNonEmptyString(value.leaseId) &&
		isNonEmptyString(value.epoch) &&
		isNonEmptyString(value.requestKey)
	);
}

function addIdentity(identities: Map<string, string>, chatId: string, identifier: string, identity: string): boolean {
	const key = `${chatId}\u0000${identifier}`;
	const prior = identities.get(key);
	if (prior !== undefined && prior !== identity) return false;
	if (prior === identity) return false;
	identities.set(key, identity);
	return true;
}

function sameTargetIdentity(
	operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "kind" | "detail">,
	target: { readonly id: string; readonly ingressId?: string; readonly kind: string; readonly detail?: string },
): boolean {
	return (
		operationIdentity(operation) === JSON.stringify([target.id, target.ingressId ?? target.id]) &&
		operation.kind === target.kind &&
		operation.detail === target.detail
	);
}

function hasUniqueTombstoneIdentities(tombstone: SessionAuthorityTombstone): boolean {
	const identifiers = new Set<string>();
	for (const operation of tombstone.journal)
		for (const identifier of operationIdentifiers(operation)) {
			if (identifiers.has(identifier)) return false;
			identifiers.add(identifier);
		}
	return true;
}

function hasConsistentTombstoneResults(
	tombstone: SessionAuthorityTombstone,
	root: ManagedHistoricalAssociationOwner,
): boolean {
	return tombstone.journal.every(operation => {
		if (!hasConsistentSuccessor(tombstone, operation, root)) return false;
		if (operation.result === undefined) return true;
		const resultMapping = operation.result.mapping;
		return (
			(resultMapping.chatId === root.chatId ||
				(operation.result.historicalBinding !== undefined &&
					managedHistoricalSourceAssociation(root, operation.result.historicalBinding, operation) !==
						undefined)) &&
			resultMapping.projectId === tombstone.projectId &&
			hasConsistentResultSession(tombstone, operation) &&
			resultMapping.operationId === operation.id
		);
	});
}
function reassignmentTombstoneRoots(
	reassignment: SessionAuthorityRecord["reassignment"] | undefined,
): readonly SessionAuthorityTombstone[] {
	const sourceTombstone = reassignment?.sourceTombstone;
	if (sourceTombstone !== undefined) return [sourceTombstone];
	const priorTombstone = reassignment?.priorTombstone;
	return priorTombstone === undefined ? [] : [priorTombstone];
}
function reassignmentTombstoneChainContainsProject(
	reassignment: SessionAuthorityRecord["reassignment"] | undefined,
	projectId: string,
): boolean {
	const roots = [reassignment?.sourceTombstone, reassignment?.priorTombstone];
	for (const root of roots)
		for (let current = root; current !== undefined; current = current.prior)
			if (current.projectId === projectId) return true;
	return false;
}
