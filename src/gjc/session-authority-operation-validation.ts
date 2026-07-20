import { isAbsolute } from "node:path";
import type { NormalizedModelSelection } from "../contracts";
import type {
	SessionAttachmentProof,
	SessionOperation,
	SessionOperationKind,
	SessionOperationResult,
	SessionOperationState,
} from "./session-authority-types";
import {
	hasOnlyKeys,
	isJsonValue,
	isNonEmptyString,
	isNonnegativeSafeInteger,
	isRecord,
	isTimestamp,
} from "./session-authority-validation-primitives";
import { normalizeModelSelection } from "./session-operation-codec";
import type { GjcTurnEvent } from "./turn-runner";

export function isOperation(value: unknown): value is SessionOperation {
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
			"acknowledgedSuccessor",
		]) ||
		!isNonEmptyString(value.id) ||
		!isOperationKind(value.kind) ||
		!isOperationState(value.state) ||
		!isTimestamp(value.startedAt)
	)
		return false;
	if (value.ingressId !== undefined && !isNonEmptyString(value.ingressId)) return false;
	if (value.detail !== undefined && typeof value.detail !== "string") return false;
	if (
		value.acknowledgedSuccessor !== undefined &&
		((value.kind !== "create" && value.kind !== "branch") ||
			(value.state !== "pending" && value.state !== "uncertain") ||
			!isAcknowledgedSuccessor(value.acknowledgedSuccessor))
	)
		return false;
	return value.state === "complete"
		? isTimestamp(value.completedAt) &&
				Date.parse(value.completedAt) >= Date.parse(value.startedAt) &&
				(value.result === undefined || isOperationResult(value.result))
		: value.completedAt === undefined && value.result === undefined;
}
export function requiresUncertainAcknowledgedSuccessorCompletionReconciliation(
	operation: SessionOperation,
	state: SessionOperationState,
	detail: string | undefined,
	result: SessionOperationResult | undefined,
): boolean {
	return (
		operation.state === "uncertain" &&
		state === "complete" &&
		(operation.kind !== "create" ||
			operation.acknowledgedSuccessor === undefined ||
			detail !== operation.detail ||
			result?.kind !== "control" ||
			result.mapping.operationId !== operation.id ||
			result.mapping.sessionId !== operation.acknowledgedSuccessor.sessionId ||
			result.mapping.sessionFile === undefined ||
			JSON.stringify(result.mapping.attachment) !== JSON.stringify(operation.acknowledgedSuccessor.attachment))
	);
}

export function isNormalizedModelSelection(value: unknown): value is NormalizedModelSelection {
	return normalizeModelSelection(value) !== undefined;
}

export function isAttachmentProof(value: unknown): value is SessionAttachmentProof {
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

export function isEvent(value: unknown): value is GjcTurnEvent {
	return (
		hasOnlyKeys(value, ["type", "text", "id", "payload"]) &&
		isNonEmptyString(value.type) &&
		(value.text === undefined || typeof value.text === "string") &&
		(value.id === undefined || isNonEmptyString(value.id)) &&
		(value.payload === undefined || (isRecord(value.payload) && isJsonValue(value.payload)))
	);
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
function isAcknowledgedSuccessor(value: unknown): boolean {
	return (
		hasOnlyKeys(value, ["sessionId", "attachment"]) &&
		isNonEmptyString(value.sessionId) &&
		isEndpointSessionAttachmentProof(value.attachment) &&
		value.sessionId === value.attachment.expectedSessionId
	);
}
function isEndpointSessionAttachmentProof(value: unknown): value is SessionAttachmentProof {
	return (
		hasOnlyKeys(value, [
			"descriptorPath",
			"descriptorStat",
			"payloadDigest",
			"generation",
			"expectedSessionId",
			"expectedCwd",
		]) && isAttachmentProof(value)
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
