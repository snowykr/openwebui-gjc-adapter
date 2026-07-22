import type { SessionEntry, SessionHeader } from "@gajae-code/coding-agent";
import { isEvictedContentMarker, isSessionMessage, isUserContent } from "./session-message-decoder";

type JsonRecord = Record<string, unknown>;
type FieldCheck = (value: unknown) => boolean;

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNull = (value: unknown): value is null => value === null;
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
const oneOf =
	(...checks: FieldCheck[]): FieldCheck =>
	value =>
		checks.some(check => check(value));

export function decodeSessionHeader(value: unknown): SessionHeader | undefined {
	if (
		!hasExactFields<SessionHeader>(value, "session", ["id", "timestamp", "cwd"], {
			version: optional(isNumber),
			id: nonEmptyString,
			title: optional(isString),
			titleSource: optional(value => value === "auto" || value === "user"),
			timestamp: isString,
			cwd: nonEmptyString,
			parentSession: optional(isString),
		})
	)
		return undefined;
	return value;
}

export function decodeSessionEntry(value: unknown): SessionEntry | undefined {
	return isSessionEntry(value) ? value : undefined;
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (!isRecord(value) || !isString(value.type)) return false;
	const check = entryChecks[value.type];
	return check?.(value) ?? false;
}

const entryBase = { id: nonEmptyString, parentId: oneOf(isString, isNull), timestamp: isString };
const entryChecks: Record<string, (value: unknown) => boolean> = {
	message: value =>
		hasExactFields(value, "message", ["id", "parentId", "timestamp", "message"], {
			...entryBase,
			message: isSessionMessage,
			evictedContent: optional(isEvictedContentMarker),
		}),
	thinking_level_change: value =>
		hasExactFields(value, "thinking_level_change", ["id", "parentId", "timestamp"], {
			...entryBase,
			thinkingLevel: optional(oneOf(isString, isNull)),
		}),
	model_change: value =>
		hasExactFields(value, "model_change", ["id", "parentId", "timestamp", "model"], {
			...entryBase,
			model: isString,
			role: optional(isString),
			previousModel: optional(isString),
			reason: optional(isString),
			thinkingLevel: optional(oneOf(isString, isNull)),
		}),
	service_tier_change: value =>
		hasExactFields(value, "service_tier_change", ["id", "parentId", "timestamp", "serviceTier"], {
			...entryBase,
			serviceTier: oneOf(isString, isNull),
		}),
	compaction: value =>
		hasExactFields(
			value,
			"compaction",
			["id", "parentId", "timestamp", "summary", "firstKeptEntryId", "tokensBefore"],
			{
				...entryBase,
				summary: isString,
				shortSummary: optional(isString),
				firstKeptEntryId: isString,
				tokensBefore: isNumber,
				details: optional(isJson),
				preserveData: optional(isRecord),
				fromExtension: optional(isBoolean),
			},
		),
	branch_summary: value =>
		hasExactFields(value, "branch_summary", ["id", "parentId", "timestamp", "fromId", "summary"], {
			...entryBase,
			fromId: isString,
			summary: isString,
			details: optional(isJson),
			fromExtension: optional(isBoolean),
		}),
	custom: value =>
		hasExactFields(value, "custom", ["id", "parentId", "timestamp", "customType"], {
			...entryBase,
			customType: isString,
			data: optional(isJson),
		}),
	custom_message: value =>
		hasExactFields(value, "custom_message", ["id", "parentId", "timestamp", "customType", "content", "display"], {
			...entryBase,
			customType: isString,
			content: isUserContent,
			details: optional(isJson),
			display: isBoolean,
			attribution: optional(isMessageAttribution),
			evictedContent: optional(isEvictedContentMarker),
		}),
	label: value =>
		hasExactFields(value, "label", ["id", "parentId", "timestamp", "targetId"], {
			...entryBase,
			targetId: isString,
			label: optional(isString),
		}),
	ttsr_injection: value =>
		hasExactFields(value, "ttsr_injection", ["id", "parentId", "timestamp", "injectedRules"], {
			...entryBase,
			injectedRules: isStringArray,
			injectedRuleRecords: optional(Array.isArray),
			ttsrMessageCount: optional(isNumber),
		}),
	mcp_tool_selection: value =>
		hasExactFields(value, "mcp_tool_selection", ["id", "parentId", "timestamp", "selectedToolNames"], {
			...entryBase,
			selectedToolNames: isStringArray,
		}),
	discovered_builtin_tool_selection: value =>
		hasExactFields(value, "discovered_builtin_tool_selection", ["id", "parentId", "timestamp", "selectedToolNames"], {
			...entryBase,
			selectedToolNames: isStringArray,
		}),
	session_init: value =>
		hasExactFields(value, "session_init", ["id", "parentId", "timestamp", "systemPrompt", "task", "tools"], {
			...entryBase,
			systemPrompt: isString,
			task: isString,
			tools: isStringArray,
			outputSchema: optional(isJson),
			forkContext: optional(isJson),
		}),
	mode_change: value =>
		hasExactFields(value, "mode_change", ["id", "parentId", "timestamp", "mode"], {
			...entryBase,
			mode: isString,
			data: optional(isRecord),
		}),
	configured_model_chain: value =>
		hasExactFields(
			value,
			"configured_model_chain",
			["id", "parentId", "timestamp", "role", "entries", "origin", "explicitHead"],
			{
				...entryBase,
				role: isString,
				entries: isStringArray,
				origin: isString,
				identity: optional(isString),
				explicitHead: isBoolean,
				cleared: optional(isBoolean),
			},
		),
};

function hasExactFields<T extends object>(
	value: unknown,
	type: string,
	required: string[],
	checks: Record<string, FieldCheck>,
): value is T {
	if (!isRecord(value) || value.type !== type) return false;
	const keys = Object.keys(value);
	if (!keys.every(key => key === "type" || key in checks) || !required.every(key => key in value)) return false;
	return Object.entries(checks).every(([key, check]) => check(value[key]));
}

function nonEmptyString(value: unknown): boolean {
	return isString(value) && value.trim().length > 0;
}
function isMessageAttribution(value: unknown): boolean {
	return value === "user" || value === "agent";
}
