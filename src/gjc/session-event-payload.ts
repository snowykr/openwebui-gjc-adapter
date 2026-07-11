import type { GjcRpcRunnerTransportEvent } from "./rpc-runner";

const SECRET_PATTERNS: readonly RegExp[] = [
	/RAW_SECRET[0-9A-Z_a-z-]*/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
	/\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*["']?[^"'\s,;]{4,}/gi,
	/\b(?:sk|ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_=-]{8,}/g,
];

export function sessionEventPayload(event: GjcRpcRunnerTransportEvent): Readonly<Record<string, unknown>> | undefined {
	switch (event.type) {
		case "message_update":
			return messageUpdatePayload(event);
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return toolExecutionPayload(event);
		case "notice":
			return compactRecord({
				level: event.level,
				message: safeText(textValue(event.message)),
				source: event.source,
			});
		case "todo_reminder":
			return compactRecord({
				todoCount: Array.isArray(event.todos) ? event.todos.length : undefined,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		case "todo_auto_clear":
			return {};
		case "goal_updated":
			return compactRecord({
				goalPresent: event.goal !== null && event.goal !== undefined,
				objective: safeText(goalObjective(event.goal)),
			});
		case "subagent_steer_message":
		case "irc_message":
			return compactRecord({
				messageKind: messageKind(event.message),
				text: safeText(customMessageText(event.message)),
			});
		case "auto_compaction_start":
			return compactRecord({ reason: event.reason, action: event.action });
		case "auto_compaction_end":
			return compactRecord({
				action: event.action,
				aborted: event.aborted,
				willRetry: event.willRetry,
				skipped: event.skipped,
				errorMessage: safeText(event.errorMessage),
			});
		case "auto_retry_start":
			return compactRecord({
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				errorMessage: safeText(event.errorMessage),
			});
		case "auto_retry_end":
			return compactRecord({
				success: event.success,
				attempt: event.attempt,
				finalError: safeText(event.finalError),
			});
		case "retry_fallback_applied":
			return compactRecord({ from: event.from, to: event.to, role: event.role });
		case "retry_fallback_succeeded":
			return compactRecord({ model: event.model, role: event.role });
		case "ttsr_triggered":
			return compactRecord({ ruleCount: Array.isArray(event.rules) ? event.rules.length : undefined });
		case "thinking_level_changed":
			return compactRecord({ thinkingLevel: event.thinkingLevel });
		default:
			return undefined;
	}
}

function messageUpdatePayload(event: GjcRpcRunnerTransportEvent): Readonly<Record<string, unknown>> | undefined {
	const assistant = recordValue(event.assistantMessageEvent);
	const assistantType = stringValue(assistant?.type);
	if (assistantType === undefined) return undefined;
	return {
		assistantMessageEvent: compactRecord({
			type: assistantType,
			contentIndex: numberValue(assistant?.contentIndex),
			text: safeText(textValue(assistant?.delta) ?? textValue(assistant?.content)),
		}),
	};
}

function toolExecutionPayload(event: GjcRpcRunnerTransportEvent): Readonly<Record<string, unknown>> | undefined {
	const payload = compactRecord({
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		intent: safeText(event.intent),
		isError: event.isError,
		argsPresent: event.args === undefined ? undefined : true,
		partialResultPresent: event.partialResult === undefined ? undefined : true,
		resultPresent: event.result === undefined ? undefined : true,
	});
	if (
		payload.intent === undefined &&
		payload.isError === undefined &&
		payload.argsPresent === undefined &&
		payload.partialResultPresent === undefined &&
		payload.resultPresent === undefined
	) {
		return undefined;
	}
	return payload;
}

function compactRecord(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) output[key] = value;
	}
	return output;
}

function safeText(value: string | undefined, maxLength = 180): string | undefined {
	if (value === undefined) return undefined;
	return sanitizeSessionEventText(value, maxLength);
}

export function sanitizeSessionEventText(value: string, maxLength = 180): string {
	let redacted = value;
	for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, redactSecretMatch);
	return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}

function redactSecretMatch(match: string): string {
	const separatorIndex = separatorPosition(match);
	if (separatorIndex === undefined) return "[redacted]";
	return `${match.slice(0, separatorIndex + 1)}[redacted]`;
}

function separatorPosition(value: string): number | undefined {
	const colon = value.indexOf(":");
	const equals = value.indexOf("=");
	if (colon === -1) return equals === -1 ? undefined : equals;
	if (equals === -1) return colon;
	return Math.min(colon, equals);
}

function customMessageText(value: unknown): string | undefined {
	const message = recordValue(value);
	return textValue(message?.text) ?? textValue(message?.body) ?? textValue(message?.message);
}

function messageKind(value: unknown): string | undefined {
	const message = recordValue(value);
	return stringValue(message?.kind) ?? stringValue(message?.type) ?? (message === undefined ? undefined : "custom");
}

function goalObjective(value: unknown): string | undefined {
	const goal = recordValue(value);
	return textValue(goal?.objective) ?? textValue(goal?.title);
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
