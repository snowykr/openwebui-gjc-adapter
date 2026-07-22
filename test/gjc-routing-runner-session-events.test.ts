import { describe, expect, test } from "bun:test";
import { SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

describe("createGjcRoutingLiveGatewayRunner session event projection", () => {
	test("projects session events through closed status families without serializing raw payloads", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const secret = "SESSION_SECRET_MARKER";
		turnRunner.events = [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start", text: secret } } },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_delta", text: secret } } },
			{
				type: "message_update",
				payload: { assistantMessageEvent: { type: "thinking_end", text: secret, nested: { secret } } },
			},
			{
				type: "tool_execution_start",
				text: secret,
				payload: { toolName: "mcp__filesystem__read_file", args: { secret }, result: secret },
			},
			{
				type: "tool_execution_update",
				payload: { toolName: `bad tool ${secret}`, args: { secret }, result: secret },
			},
			{
				type: "tool_execution_end",
				payload: { toolName: "read_file", args: { secret }, result: secret },
			},
			{ type: "todo_reminder", payload: { todoCount: 2, tokens: secret, nested: { secret } } },
			{ type: "todo_auto_clear", payload: { reason: secret } },
			{ type: "goal_updated", payload: { objective: secret } },
			{ type: "notice", payload: { level: "warning", message: secret } },
			{ type: "subagent_steer_message", payload: { text: secret } },
			{ type: "irc_message", payload: { text: secret } },
			{ type: "auto_compaction_start", payload: { action: secret, reason: secret } },
			{ type: "auto_compaction_end", payload: { action: secret, error: secret } },
			{ type: "auto_retry_start", payload: { errorMessage: secret } },
			{ type: "auto_retry_end", payload: { finalError: secret } },
			{ type: "retry_fallback_applied", payload: { from: secret, to: secret } },
			{ type: "retry_fallback_succeeded", payload: { role: secret } },
			{ type: "ttsr_triggered", payload: { ruleCount: 99, tokens: secret } },
			{ type: "thinking_level_changed", payload: { thinkingLevel: secret } },
			{ type: "unknown_event", id: secret, text: secret, payload: { secret, nested: { secret } } },
		];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new SessionMappingStore(),
			modelReaderFactory: staticModelReaderFactory(),
		});

		const result = await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
			requestedModelId: "gjc",
		});

		const serialized = JSON.stringify(result.events);
		expect(serialized).not.toContain(secret);
		expect(result.events).toEqual([
			status("Thinking started", false, "skill_progress"),
			status("Thinking in progress", false, "skill_progress"),
			status("Thinking completed", true, "skill_progress"),
			status("MCP tool mcp__filesystem__read_file started", false, "mcp_progress"),
			status("Tool updated", false, "tool_progress"),
			status("Tool read_file finished", true, "tool_progress"),
			status("Todo reminder received"),
			status("Todo list cleared", true),
			status("Goal updated"),
			status("Session notice received", true),
			status("Subagent message received", false, "subagent_progress"),
			status("IRC message received", false, "subagent_progress"),
			status("Automatic compaction started", false),
			status("Automatic compaction completed", true),
			status("Automatic retry started", false),
			status("Automatic retry completed", true),
			status("Retry fallback applied"),
			status("Retry fallback succeeded", true),
			status("TTSR triggered", true),
			status("Thinking level updated", true),
			status("Unsupported GJC frame", true),
		]);
		for (const event of result.events ?? []) {
			if (event.type !== "status") continue;
			expect(event.data.gjc_adapter).toEqual(
				event.data.description === "Unsupported GJC frame"
					? { diagnostic: "unsupported_frame" }
					: {
							frameKind: event.data.gjc_adapter?.frameKind,
							phase: event.data.gjc_adapter?.phase,
							metadata: {},
						},
			);
		}
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
