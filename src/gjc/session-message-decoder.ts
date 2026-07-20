type JsonRecord = Record<string, unknown>;
type FieldCheck = (value: unknown) => boolean;

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isJson = (value: unknown): boolean =>
	value === null ||
	isString(value) ||
	isBoolean(value) ||
	isNumber(value) ||
	(Array.isArray(value) && value.every(isJson)) ||
	(isRecord(value) && Object.values(value).every(isJson));
const optional =
	(check: FieldCheck): FieldCheck =>
	value =>
		value === undefined || check(value);
const nonEmptyString = (value: unknown): boolean => isString(value) && value.trim().length > 0;

export function isSessionMessage(value: unknown): boolean {
	if (!isRecord(value) || !isString(value.role)) return false;
	switch (value.role) {
		case "user":
		case "developer":
			return hasExactFields(value, ["role", "content", "timestamp"], {
				role: isString,
				content: isUserContent,
				timestamp: isNumber,
				synthetic: optional(isBoolean),
				attribution: optional(isAttribution),
				providerPayload: optional(isProviderPayload),
			});
		case "assistant":
			return hasExactFields(
				value,
				["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
				{
					role: isString,
					content: isAssistantContent,
					api: isString,
					provider: isString,
					model: isString,
					responseId: optional(isString),
					usage: isUsage,
					stopReason: isStopReason,
					errorMessage: optional(isString),
					errorKind: optional(value => value === "provider_safety_stop"),
					errorStatus: optional(isNumber),
					transportFailure: optional(isJson),
					disabledFeatures: optional(isStringArray),
					providerPayload: optional(isProviderPayload),
					timestamp: isNumber,
					duration: optional(isNumber),
					ttft: optional(isNumber),
				},
			);
		case "toolResult":
			return hasExactFields(value, ["role", "toolCallId", "toolName", "content", "isError", "timestamp"], {
				role: isString,
				toolCallId: nonEmptyString,
				toolName: nonEmptyString,
				content: isToolResultContent,
				details: optional(isJson),
				isError: isBoolean,
				attribution: optional(isAttribution),
				prunedAt: optional(isNumber),
				timestamp: isNumber,
			});
		default:
			return false;
	}
}

export function isEvictedContentMarker(value: unknown): boolean {
	return hasExactFields(value, ["evictedAt", "reason", "compactionEntryId", "firstKeptEntryId", "payloads"], {
		evictedAt: isNumber,
		reason: value => value === "compacted_history",
		compactionEntryId: nonEmptyString,
		firstKeptEntryId: nonEmptyString,
		payloads: isColdSpillRefs,
	});
}

export function isUserContent(value: unknown): boolean {
	return isString(value) || (Array.isArray(value) && value.every(isUserContentPart));
}
function isUserContentPart(value: unknown): boolean {
	return isTextContent(value) || isImageContent(value);
}
function isToolResultContent(value: unknown): boolean {
	return Array.isArray(value) && value.every(isUserContentPart);
}
function isAssistantContent(value: unknown): boolean {
	return Array.isArray(value) && value.every(isAssistantContentPart);
}
function isAssistantContentPart(value: unknown): boolean {
	return (
		isTextContent(value) ||
		hasExactFields(value, ["type", "thinking"], {
			type: value => value === "thinking",
			thinking: isString,
			thinkingSignature: optional(isString),
			itemId: optional(isString),
			provenance: optional(value => value === "summary" || value === "raw" || value === "mixed"),
			summaryText: optional(isString),
			rawText: optional(isString),
		}) ||
		hasExactFields(value, ["type", "data"], { type: value => value === "redactedThinking", data: isString }) ||
		hasExactFields(value, ["type", "id", "name", "arguments"], {
			type: value => value === "toolCall",
			id: nonEmptyString,
			name: nonEmptyString,
			arguments: isJsonRecord,
			thoughtSignature: optional(isString),
			intent: optional(isString),
			customWireName: optional(isString),
			incompleteArguments: optional(isBoolean),
		})
	);
}
function isTextContent(value: unknown): boolean {
	return hasExactFields(value, ["type", "text"], {
		type: value => value === "text",
		text: isString,
		textSignature: optional(isString),
	});
}
function isImageContent(value: unknown): boolean {
	return hasExactFields(value, ["type", "data", "mimeType"], {
		type: value => value === "image",
		data: isString,
		mimeType: nonEmptyString,
	});
}
function isUsage(value: unknown): boolean {
	return hasExactFields(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], {
		input: isNumber,
		output: isNumber,
		cacheRead: isNumber,
		cacheWrite: isNumber,
		totalTokens: isNumber,
		premiumRequests: optional(isNumber),
		reasoningTokens: optional(isNumber),
		cttl: optional(isJson),
		server: optional(isJson),
		cost: value =>
			hasExactFields(value, ["input", "output", "cacheRead", "cacheWrite", "total"], {
				input: isNumber,
				output: isNumber,
				cacheRead: isNumber,
				cacheWrite: isNumber,
				total: isNumber,
			}),
	});
}
function isProviderPayload(value: unknown): boolean {
	return hasExactFields(value, ["type", "items"], {
		type: value => value === "openaiResponsesHistory",
		provider: optional(isString),
		dt: optional(isBoolean),
		items: value => Array.isArray(value) && value.every(isJsonRecord),
	});
}
function isAttribution(value: unknown): boolean {
	return value === "user" || value === "agent";
}
function isStopReason(value: unknown): boolean {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}
function isJsonRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(isJson);
}
function isColdSpillRefs(value: unknown): boolean {
	return (
		isRecord(value) &&
		Object.values(value).every(ref =>
			hasExactFields(ref, ["kind", "ref", "encoding", "originalChars", "sha256", "bytes"], {
				kind: value => value === "cold_spill",
				ref: nonEmptyString,
				encoding: value => value === "utf8" || value === "json",
				originalChars: isNumber,
				sha256: nonEmptyString,
				bytes: isNumber,
			}),
		)
	);
}
function hasExactFields(value: unknown, required: string[], checks: Record<string, FieldCheck>): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	return (
		keys.every(key => key in checks) &&
		required.every(key => key in value) &&
		Object.entries(checks).every(([key, check]) => check(value[key]))
	);
}
