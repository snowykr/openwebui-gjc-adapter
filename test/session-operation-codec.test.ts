import { describe, expect, test } from "bun:test";
import { operationResult } from "../src/gjc/session-operation-codec";
import { SessionMappingStore } from "../src/gjc/session-router";

describe("session operation codec", () => {
	test("operationResult binds an empty event array while the stored record keeps its events", () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 2,
			operationId: "op-1",
			assistantText: "done",
			events: [{ type: "tool_start", id: "tool-1" }],
		};
		mappings.set({ ...mapping, operationId: "bootstrap" });
		mappings.beginOperation("chat-1", { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMapping("chat-1", "op-1", "request", mapping, "turn");

		expect(mappings.operation("chat-1", "op-1")?.result?.events).toEqual([]);
		expect(mappings.get("chat-1")?.events).toEqual([{ type: "tool_start", id: "tool-1" }]);
		expect(mappings.get("chat-1")?.assistantText).toBe("done");
	});

	test("operationResult retains the immutable mapping fields and assistant text", () => {
		const result = operationResult("turn", {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 2,
			operationId: "op-1",
			assistantText: "done",
			events: [{ type: "tool_start", id: "tool-1" }],
		});

		expect(result).toMatchObject({
			kind: "turn",
			assistantText: "done",
			events: [],
			mapping: {
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 1,
				eventCursor: 2,
				operationId: "op-1",
			},
		});
		expect(JSON.stringify(result)).not.toContain("tool_start");
	});
});
