import { isAbsolute } from "node:path";
import { operationIdentity } from "./session-authority-operation-identity";
import {
	isAttachmentProof,
	isEvent,
	isNormalizedModelSelection,
	isOperation,
} from "./session-authority-operation-validation";
import type { ProvisionalSessionOperation, SessionAuthorityRecord } from "./session-authority-types";
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
		value.journal.every(isOperation)
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
	for (const mapping of mappings) {
		if (chatIds.has(mapping.chatId)) return false;
		chatIds.add(mapping.chatId);
		if (!hasUniqueJournalIdentities(mapping) || !hasConsistentOperationResults(mapping)) return false;
		for (const operation of mapping.journal)
			for (const identifier of operationIdentifiers(operation))
				identities.set(`${mapping.chatId}\u0000${identifier}`, operationIdentity(operation));
	}
	for (const operation of provisionalOperations) {
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
