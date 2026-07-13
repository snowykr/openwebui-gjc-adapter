import { describe, expect, test } from "bun:test";
import { createGjcRpcTurnRunner } from "../src/gjc/rpc-runner";
import { FakeRpcTransport, recordFactory } from "./gjc-rpc-runner-fixtures";

describe("createGjcRpcTurnRunner event redaction", () => {
	test("preserves bounded full session event details without raw secret payloads", async () => {
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
			promptEvents: [
				[
					{
						type: "message_update",
						assistantMessageEvent: {
							type: "thinking_delta",
							contentIndex: 0,
							delta: "Considering Bearer abcdefghijklmnop before reading files",
						},
						message: { content: [{ type: "text", text: "api_key=sk_should_not_escape_from_message_content" }] },
					},
					{
						type: "tool_execution_end",
						toolCallId: "tool-1",
						toolName: "mcp__filesystem__read_file",
						result: { content: [{ type: "text", text: "password=hunter2" }] },
						isError: false,
					},
					{ type: "notice", level: "warning", message: "Notice token=abcdefghijklmnop", source: "session" },
				],
			],
			assistantTexts: ["assistant final"],
		});
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });

		const result = await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		const json = JSON.stringify(result.events);
		expect(json).not.toContain("abcdefghijklmnop");
		expect(json).not.toContain("sk_should_not_escape");
		expect(json).not.toContain("hunter2");
		expect(result.events).toEqual([
			{
				type: "message_update",
				text: "api_key=[redacted]",
				payload: {
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						text: "Considering [redacted] before reading files",
					},
				},
			},
			{
				type: "tool_execution_end",
				id: "tool-1",
				text: "mcp__filesystem__read_file",
				payload: {
					toolCallId: "tool-1",
					toolName: "mcp__filesystem__read_file",
					isError: false,
					resultPresent: true,
				},
			},
			{ type: "notice", payload: { level: "warning", message: "Notice token=[redacted]", source: "session" } },
		]);
	});
});
