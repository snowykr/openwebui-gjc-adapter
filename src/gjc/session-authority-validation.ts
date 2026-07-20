import { isAbsolute } from "node:path";
import { GJC_THINKING_LEVELS, type NormalizedModelSelection } from "../contracts";
import {
	type AuthorityMutationLockRecord,
	type ProvisionalSessionOperation,
	SESSION_AUTHORITY_VERSION,
	type SessionAttachmentProof,
	type SessionAuthorityRecord,
	type SessionOperation,
	type SessionOperationKind,
	type SessionOperationResult,
	type SessionOperationState,
} from "./session-authority-types";
import type { GjcTurnEvent } from "./turn-runner";

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
	if (value.modelSelection !== undefined && !isNormalizedModelSelection(value.modelSelection)) return false;
	return (
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
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).every(key => keys.includes(key));
}
function isJsonValue(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) ? value.every(isJsonValue) : isRecord(value) && Object.values(value).every(isJsonValue))
	);
}
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isEvent(value: unknown): value is GjcTurnEvent {
	return (
		hasOnlyKeys(value, ["type", "text", "id", "payload"]) &&
		isNonEmptyString(value.type) &&
		(value.text === undefined || typeof value.text === "string") &&
		(value.id === undefined || isNonEmptyString(value.id)) &&
		(value.payload === undefined || (isRecord(value.payload) && isJsonValue(value.payload)))
	);
}
function isOperation(value: unknown): value is SessionOperation {
	if (
		!hasOnlyKeys(value, ["id", "kind", "state", "ingressId", "startedAt", "completedAt", "detail", "result"]) ||
		!isNonEmptyString(value.id) ||
		!isOperationKind(value.kind) ||
		!isOperationState(value.state) ||
		!isTimestamp(value.startedAt)
	)
		return false;
	if (value.ingressId !== undefined && !isNonEmptyString(value.ingressId)) return false;
	if (value.detail !== undefined && typeof value.detail !== "string") return false;
	return value.state === "complete"
		? isTimestamp(value.completedAt) &&
				Date.parse(value.completedAt) >= Date.parse(value.startedAt) &&
				(value.result === undefined || isOperationResult(value.result))
		: value.completedAt === undefined && value.result === undefined;
}
function isOperationKind(value: unknown): value is SessionOperationKind {
	return (
		typeof value === "string" &&
		["create", "resume", "close", "prompt", "reply", "gate", "branch", "model", "thinking"].includes(value)
	);
}
function isOperationState(value: unknown): value is SessionOperationState {
	return typeof value === "string" && ["pending", "complete", "uncertain", "conflict"].includes(value);
}
function isNormalizedModelSelection(value: unknown): value is NormalizedModelSelection {
	return (
		hasOnlyKeys(value, ["provider", "modelId", "thinkingLevel"]) &&
		isNonEmptyString(value.provider) &&
		!value.provider.includes("/") &&
		isNonEmptyString(value.modelId) &&
		typeof value.thinkingLevel === "string" &&
		GJC_THINKING_LEVELS.includes(value.thinkingLevel as NormalizedModelSelection["thinkingLevel"])
	);
}
function isAttachmentProof(value: unknown): value is SessionAttachmentProof {
	if (
		!hasOnlyKeys(value, [
			"descriptorPath",
			"descriptorStat",
			"payloadDigest",
			"generation",
			"expectedSessionId",
			"expectedCwd",
			"tmuxSocket",
			"tmuxPane",
			"tmuxPanePid",
			"tmuxOwnershipTag",
			"ownedAt",
		]) ||
		!isNonEmptyString(value.descriptorPath) ||
		!isAbsolute(value.descriptorPath) ||
		!isSha256HexDigest(value.payloadDigest) ||
		!isNonnegativeFiniteNumber(value.generation)
	)
		return false;
	if (
		!isNonEmptyString(value.expectedSessionId) ||
		!isNonEmptyString(value.expectedCwd) ||
		!isAbsolute(value.expectedCwd)
	)
		return false;
	if (
		!hasOnlyKeys(value.descriptorStat, ["dev", "ino", "size", "mtimeMs"]) ||
		![
			value.descriptorStat.dev,
			value.descriptorStat.ino,
			value.descriptorStat.size,
			value.descriptorStat.mtimeMs,
		].every(isNonnegativeFiniteNumber) ||
		value.generation !== value.descriptorStat.mtimeMs
	)
		return false;
	const tmux = [value.tmuxSocket, value.tmuxPane, value.tmuxPanePid, value.tmuxOwnershipTag, value.ownedAt].some(
		item => item !== undefined,
	);
	return (
		!tmux ||
		(isNonEmptyString(value.tmuxSocket) &&
			isNonEmptyString(value.tmuxPane) &&
			isNonnegativeSafeInteger(value.tmuxPanePid) &&
			isNonEmptyString(value.tmuxOwnershipTag) &&
			isTimestamp(value.ownedAt))
	);
}
function isNonnegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isSha256HexDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isOperationResult(value: unknown): value is SessionOperationResult {
	if (
		!hasOnlyKeys(value, ["kind", "assistantText", "events", "mapping", "correlation"]) ||
		(value.kind !== "turn" && value.kind !== "control" && value.kind !== "close") ||
		typeof value.assistantText !== "string" ||
		!Array.isArray(value.events) ||
		!value.events.every(isEvent) ||
		!hasOnlyKeys(value.mapping, [
			"chatId",
			"projectId",
			"sessionId",
			"sessionFile",
			"activeLeaf",
			"rawFrameCursor",
			"eventCursor",
			"operationId",
			"modelSelection",
			"attachment",
		])
	)
		return false;
	const mapping = value.mapping;
	if (
		![mapping.chatId, mapping.projectId, mapping.sessionId, mapping.operationId].every(isNonEmptyString) ||
		!isNonnegativeSafeInteger(mapping.rawFrameCursor) ||
		!isNonnegativeSafeInteger(mapping.eventCursor)
	)
		return false;
	if (
		mapping.sessionFile !== undefined &&
		(!isNonEmptyString(mapping.sessionFile) || !isAbsolute(mapping.sessionFile))
	)
		return false;
	if (mapping.activeLeaf !== undefined && !isNonEmptyString(mapping.activeLeaf)) return false;
	if (mapping.modelSelection !== undefined && !isNormalizedModelSelection(mapping.modelSelection)) return false;
	if (
		mapping.attachment !== undefined &&
		(!isAttachmentProof(mapping.attachment) || mapping.attachment.expectedSessionId !== mapping.sessionId)
	)
		return false;
	return value.kind === "close"
		? isRecord(value.correlation) &&
				value.correlation.closeStatus === "closed" &&
				Object.keys(value.correlation).every(key => key === "closeStatus")
		: value.correlation === undefined ||
				(isRecord(value.correlation) && Object.values(value.correlation).every(isNonEmptyString));
}
export function isLegacyMappingDocument(value: unknown): boolean {
	return (
		Array.isArray(value) ||
		(isRecord(value) && Array.isArray(value.mappings) && value.kind === undefined && value.version === undefined)
	);
}
export function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST"
	);
}
export function parseAuthorityMutationLockRecord(value: unknown): AuthorityMutationLockRecord | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (!isNonEmptyString(value.owner)) {
		return undefined;
	}

	if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) {
		return undefined;
	}

	if (typeof value.leaseExpiresAt !== "number" || !Number.isFinite(value.leaseExpiresAt)) {
		return undefined;
	}

	return {
		owner: value.owner,
		pid: value.pid,
		leaseExpiresAt: value.leaseExpiresAt,
	};
}
