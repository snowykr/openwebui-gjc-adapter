import type { GjcTurnEvent } from "../gjc/turn-runner";
import type { ProjectableAgentFrame } from "../projection/events";

export function sessionEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | undefined {
	switch (event.type) {
		case "message_update":
			return thinkingFrame(event);
		case "tool_execution_start":
			return toolFrame(event, "start");
		case "tool_execution_update":
			return toolFrame(event, "progress");
		case "tool_execution_end":
			return toolFrame(event, "end");
		case "todo_reminder":
			return skillFrame("Todo reminder received", "progress");
		case "todo_auto_clear":
			return skillFrame("Todo list cleared", "end");
		case "goal_updated":
			return skillFrame("Goal updated", "progress");
		case "notice":
			return skillFrame("Session notice received", "end");
		case "subagent_steer_message":
			return subagentFrame("Subagent message received");
		case "irc_message":
			return subagentFrame("IRC message received");
		case "auto_compaction_start":
			return skillFrame("Automatic compaction started", "start");
		case "auto_compaction_end":
			return skillFrame("Automatic compaction completed", "end");
		case "auto_retry_start":
			return skillFrame("Automatic retry started", "start");
		case "auto_retry_end":
			return skillFrame("Automatic retry completed", "end");
		case "retry_fallback_applied":
			return skillFrame("Retry fallback applied", "progress");
		case "retry_fallback_succeeded":
			return skillFrame("Retry fallback succeeded", "end");
		case "ttsr_triggered":
			return skillFrame("TTSR triggered", "end");
		case "thinking_level_changed":
			return skillFrame("Thinking level updated", "end");
		default:
			return undefined;
	}
}

function thinkingFrame(event: GjcTurnEvent): ProjectableAgentFrame | undefined {
	const assistant = recordPayload(event, "assistantMessageEvent");
	const assistantType = assistant === undefined ? undefined : textField(assistant, "type");
	switch (assistantType) {
		case "thinking_start":
			return skillFrame("Thinking started", "start");
		case "thinking_delta":
			return skillFrame("Thinking in progress", "progress");
		case "reasoning_summary_delta": {
			const delta = textField(assistant ?? {}, "delta")?.trim();
			return delta === undefined || delta.length === 0
				? undefined
				: skillFrame(`Thinking: ${delta.slice(0, 240)}`, "progress");
		}
		case "thinking_end":
			return skillFrame("Thinking completed", "end");
		case "thinking":
			return skillFrame("Thinking completed", "end");
		case "tool_call":
			return toolFrameForName(
				safeToolNameValue(assistant === undefined ? undefined : textField(assistant, "name")),
				"start",
			);
		case "toolcall_start":
			return toolFrameForName(undefined, "start");
		case "toolcall_delta":
		case "reasoning_summary_start":
		case "reasoning_summary_end":
			return undefined;
		case "toolcall_end": {
			const toolCall = assistant === undefined ? undefined : assistant.toolCall;
			return toolFrameForName(
				isRecord(toolCall) ? safeToolNameValue(textField(toolCall, "name")) : undefined,
				"end",
			);
		}
		default:
			return undefined;
	}
}

function toolFrame(event: GjcTurnEvent, phase: "start" | "progress" | "end"): ProjectableAgentFrame {
	return toolFrameForName(safeToolName(event), phase);
}

function toolFrameForName(toolName: string | undefined, phase: "start" | "progress" | "end"): ProjectableAgentFrame {
	const isMcpTool = toolName?.startsWith("mcp__") ?? false;
	const verb = phase === "start" ? "started" : phase === "end" ? "finished" : "updated";
	return {
		kind: isMcpTool ? "mcp_progress" : "tool_progress",
		label:
			toolName === undefined
				? `${isMcpTool ? "MCP tool" : "Tool"} ${verb}`
				: `${isMcpTool ? "MCP tool" : "Tool"} ${toolName} ${verb}`,
		phase,
	};
}

function skillFrame(label: string, phase: "start" | "progress" | "end"): ProjectableAgentFrame {
	return { kind: "skill_progress", label, phase };
}

function subagentFrame(label: string): ProjectableAgentFrame {
	return { kind: "subagent_progress", label, phase: "progress" };
}

function safeToolName(event: GjcTurnEvent): string | undefined {
	return safeToolNameValue(textPayload(event, "toolName"));
}

function safeToolNameValue(toolName: string | undefined): string | undefined {
	if (toolName === undefined || toolName.length === 0 || toolName.length > 64) return undefined;
	return /^[a-z0-9][a-z0-9_.-]*$/iu.test(toolName) ? toolName : undefined;
}

function textPayload(event: GjcTurnEvent, key: string): string | undefined {
	return isRecord(event.payload) ? textField(event.payload, key) : undefined;
}

function recordPayload(event: GjcTurnEvent, key: string): Record<string, unknown> | undefined {
	const value = isRecord(event.payload) ? event.payload[key] : undefined;
	return isRecord(value) ? value : undefined;
}

function textField(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
