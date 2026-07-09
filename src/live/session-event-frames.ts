import type { GjcTurnEvent } from "../gjc/rpc-runner";
import type { ProjectableAgentFrame } from "../projection/events";

export function sessionEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | undefined {
	switch (event.type) {
		case "message_update":
			return messageUpdateFrame(event);
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return toolFrame(event);
		case "todo_reminder":
			return skillFrame(todoReminderLabel(event), event, "progress");
		case "todo_auto_clear":
			return skillFrame("Todo list cleared", event, "end");
		case "goal_updated":
			return skillFrame(`Goal updated: ${textPayload(event, "objective") ?? "none"}`, event, "progress");
		case "notice":
			return skillFrame(noticeLabel(event), event, "end");
		case "subagent_steer_message":
		case "irc_message":
			return {
				kind: "subagent_progress",
				label: `Subagent message: ${textPayload(event, "text") ?? "received"}`,
				phase: "progress",
				metadata: metadata(event),
			};
		case "auto_compaction_start":
			return skillFrame(
				`Auto compaction started: ${textPayload(event, "action") ?? "unknown"} (${textPayload(event, "reason") ?? "unknown"})`,
				event,
				"start",
			);
		case "auto_compaction_end":
			return skillFrame(autoCompactionEndLabel(event), event, "end");
		case "auto_retry_start":
			return skillFrame(autoRetryStartLabel(event), event, "start");
		case "auto_retry_end":
			return skillFrame(autoRetryEndLabel(event), event, "end");
		case "retry_fallback_applied":
			return skillFrame(
				`Retry fallback applied: ${textPayload(event, "from") ?? "unknown"} -> ${textPayload(event, "to") ?? "unknown"}`,
				event,
				"progress",
			);
		case "retry_fallback_succeeded":
			return skillFrame(`Retry fallback succeeded for ${textPayload(event, "role") ?? "model"}`, event, "end");
		case "ttsr_triggered":
			return skillFrame(`TTSR triggered: ${numberPayload(event, "ruleCount") ?? 0} rules`, event, "end");
		case "thinking_level_changed":
			return skillFrame(`Thinking level: ${textPayload(event, "thinkingLevel") ?? "default"}`, event, "end");
		default:
			return undefined;
	}
}

function messageUpdateFrame(event: GjcTurnEvent): ProjectableAgentFrame | undefined {
	const assistant = recordPayload(event, "assistantMessageEvent");
	if (assistant === undefined) return undefined;
	const assistantType = textField(assistant, "type");
	if (assistantType === undefined || !assistantType.startsWith("thinking_")) return undefined;
	const text = textField(assistant, "text");
	const phase = assistantType === "thinking_start" ? "start" : assistantType === "thinking_end" ? "end" : "progress";
	return skillFrame(text === undefined ? "Thinking" : `Thinking: ${text}`, event, phase);
}

function toolFrame(event: GjcTurnEvent): ProjectableAgentFrame {
	const toolName = textPayload(event, "toolName") ?? event.text ?? "tool";
	const phase = event.type.endsWith("_end") ? "end" : event.type.endsWith("_start") ? "start" : "progress";
	const verb = phase === "start" ? "started" : phase === "end" ? "finished" : "updated";
	return {
		kind: toolName.startsWith("mcp__") ? "mcp_progress" : "tool_progress",
		label: `${toolName.startsWith("mcp__") ? "MCP tool" : "Tool"} ${toolName} ${verb}`,
		phase,
		metadata: metadata(event),
	};
}

function skillFrame(label: string, event: GjcTurnEvent, phase: "start" | "progress" | "end"): ProjectableAgentFrame {
	return {
		kind: "skill_progress",
		label,
		phase,
		metadata: metadata(event),
	};
}

function todoReminderLabel(event: GjcTurnEvent): string {
	const count = numberPayload(event, "todoCount") ?? 0;
	const attempt = numberPayload(event, "attempt");
	const maxAttempts = numberPayload(event, "maxAttempts");
	if (attempt === undefined || maxAttempts === undefined) return `Todo reminder: ${count} open items`;
	return `Todo reminder: ${count} open items (attempt ${attempt}/${maxAttempts})`;
}

function noticeLabel(event: GjcTurnEvent): string {
	const level = textPayload(event, "level") ?? "info";
	const message = textPayload(event, "message") ?? "notice";
	return `${capitalize(level)}: ${message}`;
}

function autoCompactionEndLabel(event: GjcTurnEvent): string {
	const action = textPayload(event, "action") ?? "unknown";
	if (booleanPayload(event, "skipped") === true) return `Auto compaction skipped: ${action}`;
	if (booleanPayload(event, "aborted") === true) return `Auto compaction aborted: ${action}`;
	return `Auto compaction completed: ${action}`;
}

function autoRetryStartLabel(event: GjcTurnEvent): string {
	const attempt = numberPayload(event, "attempt");
	const maxAttempts = numberPayload(event, "maxAttempts");
	const error = textPayload(event, "errorMessage");
	const suffix = error === undefined ? "" : `: ${error}`;
	if (attempt === undefined || maxAttempts === undefined) return `Auto retry started${suffix}`;
	return `Auto retry started: attempt ${attempt}/${maxAttempts}${suffix}`;
}

function autoRetryEndLabel(event: GjcTurnEvent): string {
	const attempt = numberPayload(event, "attempt");
	const finalError = textPayload(event, "finalError");
	if (booleanPayload(event, "success") === true) return `Auto retry succeeded on attempt ${attempt ?? "unknown"}`;
	return `Auto retry failed on attempt ${attempt ?? "unknown"}${finalError === undefined ? "" : `: ${finalError}`}`;
}

function metadata(event: GjcTurnEvent): Record<string, unknown> {
	return {
		eventType: event.type,
		id: event.id ?? null,
		...(isRecord(event.payload) ? event.payload : {}),
	};
}

function textPayload(event: GjcTurnEvent, key: string): string | undefined {
	return isRecord(event.payload) ? textField(event.payload, key) : undefined;
}

function numberPayload(event: GjcTurnEvent, key: string): number | undefined {
	const value = isRecord(event.payload) ? event.payload[key] : undefined;
	return typeof value === "number" ? value : undefined;
}

function booleanPayload(event: GjcTurnEvent, key: string): boolean | undefined {
	const value = isRecord(event.payload) ? event.payload[key] : undefined;
	return typeof value === "boolean" ? value : undefined;
}

function recordPayload(event: GjcTurnEvent, key: string): Record<string, unknown> | undefined {
	const value = isRecord(event.payload) ? event.payload[key] : undefined;
	return isRecord(value) ? value : undefined;
}

function textField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
