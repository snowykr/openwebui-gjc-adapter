import { describe, expect, test } from "bun:test";
import { SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

describe("createGjcRoutingLiveGatewayRunner session event projection", () => {
	test("projects full GJC session events into bounded OpenWebUI status families", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } } },
			{
				type: "message_update",
				payload: {
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						text: "Considering [redacted] before reading files",
					},
				},
			},
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } } },
			{
				type: "tool_execution_start",
				id: "tool-1",
				text: "mcp__filesystem__read_file",
				payload: { toolCallId: "tool-1", toolName: "mcp__filesystem__read_file", argsPresent: true },
			},
			{ type: "todo_reminder", payload: { todoCount: 2, attempt: 1, maxAttempts: 3 } },
			{ type: "goal_updated", payload: { goalPresent: true, objective: "Finish [redacted]" } },
			{ type: "notice", payload: { level: "warning", message: "Notice [redacted]", source: "session" } },
			{ type: "subagent_steer_message", payload: { messageKind: "custom", text: "Worker [redacted]" } },
			{ type: "auto_compaction_start", payload: { reason: "threshold", action: "context-full" } },
			{ type: "auto_retry_end", payload: { success: false, attempt: 2, finalError: "failed [redacted]" } },
			{ type: "assistant", text: "done" },
		];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings: new SessionMappingStore() });

		const result = await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		expect(result.events).toEqual([
			status("Thinking", false, "skill_progress"),
			status("Thinking: Considering [redacted] before reading files", false, "skill_progress"),
			status("Thinking", true, "skill_progress"),
			status("MCP tool mcp__filesystem__read_file started", false, "mcp_progress"),
			status("Todo reminder: 2 open items (attempt 1/3)"),
			status("Goal updated: Finish [redacted]"),
			status("Warning: Notice [redacted]"),
			status("Subagent message: Worker [redacted]"),
			status("Auto compaction started: context-full (threshold)"),
			status("Auto retry failed on attempt 2: failed [redacted]", true),
		]);
	});
});

function status(description: string, done?: boolean, frameKind?: string) {
	return expect.objectContaining({
		type: "status",
		data: expect.objectContaining({
			description,
			...(done === undefined ? {} : { done }),
			...(frameKind === undefined ? {} : { gjc_adapter: expect.objectContaining({ frameKind }) }),
		}),
	});
}
