import { isAbsolute } from "node:path";
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
} from "./session-authority-types";
import { SESSION_AUTHORITY_VERSION } from "./session-authority-types";
import {
	hasOnlyKeys,
	isJsonValue,
	isNonEmptyString,
	isNonnegativeSafeInteger,
	isRecord,
	isTimestamp,
} from "./session-authority-validation-primitives";
import { operationIdentifiers } from "./session-operation-codec";

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
	const {
		chatId: _chatId,
		projectId: _projectId,
		sessionId: _sessionId,
		sessionFile: _sessionFile,
		attachment: _attachment,
		...operation
	} = value;
	return isOperation(operation);
}

export function isAuthorityDocumentRelationallyValid(
	mappings: readonly SessionAuthorityRecord[],
	provisionalOperations: readonly ProvisionalSessionOperation[],
): boolean {
	const chatIds = new Set<string>();
	const identities = new Map<string, string>();
	const provisionalIdentities = new Set<string>();
	const projectsByChatId = new Map<string, string>();
	for (const mapping of mappings) {
		if (chatIds.has(mapping.chatId)) return false;
		chatIds.add(mapping.chatId);
		projectsByChatId.set(mapping.chatId, mapping.projectId);
		if (!hasUniqueJournalIdentities(mapping) || !hasConsistentOperationResults(mapping)) return false;
		for (const operation of mapping.journal)
			for (const identifier of operationIdentifiers(operation))
				if (!addIdentity(identities, mapping.chatId, identifier, operationIdentity(operation))) return false;
		let tombstone = mapping.reassignment?.sourceTombstone;
		while (tombstone !== undefined) {
			if (tombstone.chatId !== mapping.chatId || tombstone.projectId === mapping.projectId) return false;
			if (!hasUniqueTombstoneIdentities(tombstone) || !hasConsistentTombstoneResults(tombstone)) return false;
			for (const operation of tombstone.journal)
				for (const identifier of operationIdentifiers(operation))
					if (!addIdentity(identities, mapping.chatId, identifier, operationIdentity(operation))) return false;
			tombstone = tombstone.prior;
		}
	}
	for (const operation of provisionalOperations) {
		const mapping = mappings.find(candidate => candidate.chatId === operation.chatId);
		const activeProject = projectsByChatId.get(operation.chatId);
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
				tombstoneChainContainsProject(mapping.reassignment?.sourceTombstone, operation.projectId);
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
			const key = `${operation.chatId}\u0000${identifier}`,
				prior = identities.get(key);
			if (provisionalIdentities.has(key) || (prior !== undefined && prior !== identity)) return false;
			provisionalIdentities.add(key);
			identities.set(key, identity);
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

function hasConsistentOperationResults(mapping: SessionAuthorityRecord): boolean {
	return mapping.journal.every(operation => {
		if (operation.result === undefined) return true;
		const resultMapping = operation.result.mapping;
		if (
			resultMapping.chatId !== mapping.chatId ||
			resultMapping.projectId !== mapping.projectId ||
			resultMapping.operationId !== operation.id
		)
			return false;
		const correlation = operation.result.correlation;
		return (
			correlation === undefined ||
			((correlation.chatId === undefined || correlation.chatId === mapping.chatId) &&
				(correlation.projectId === undefined || correlation.projectId === mapping.projectId) &&
				(correlation.operationId === undefined || correlation.operationId === operation.id))
		);
	});
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
		!value.journal.every(isOperation) ||
		(value.prior !== undefined && !isTombstone(value.prior))
	)
		return false;
	return true;
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

function hasConsistentTombstoneResults(tombstone: SessionAuthorityTombstone): boolean {
	return tombstone.journal.every(operation => {
		if (operation.result === undefined) return true;
		const resultMapping = operation.result.mapping;
		return (
			resultMapping.chatId === tombstone.chatId &&
			resultMapping.projectId === tombstone.projectId &&
			resultMapping.operationId === operation.id
		);
	});
}
function tombstoneChainContainsProject(tombstone: SessionAuthorityTombstone | undefined, projectId: string): boolean {
	let current = tombstone;
	while (current !== undefined) {
		if (current.projectId === projectId) return true;
		current = current.prior;
	}
	return false;
}
