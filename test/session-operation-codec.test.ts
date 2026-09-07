import { describe, expect, test } from "bun:test";
import { operationResult } from "../src/gjc/session-operation-codec";
import { SessionMappingStore } from "../src/gjc/session-router";

describe("session operation codec", () => {
	test("operationResult preserves replay events independently of later mapping events", () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 2,
			operationId: "op-1",
			assistantText: "done",
			events: [{ type: "tool_start", id: "tool-1", payload: { args: { value: "original" } } }],
		};
		mappings.set({ ...mapping, operationId: "bootstrap" });
		mappings.beginOperation("chat-1", { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMapping("chat-1", "op-1", "request", mapping, "turn");

		const expected = structuredClone(mapping.events);
		mapping.events[0]!.payload.args.value = "mutated input";
		expect(mappings.operation("chat-1", "op-1")?.result?.events).toEqual(expected);
		expect(mappings.get("chat-1")?.events).toEqual(expected);
		expect(mappings.get("chat-1")?.assistantText).toBe("done");
		mappings.upsert({ ...mapping, operationId: "op-2", events: [{ type: "message", id: "later" }] });
		expect(mappings.operation("chat-1", "op-1")?.result?.events).toEqual(expected);
		const copied = mappings.operation("chat-1", "op-1")?.result?.events?.[0]?.payload;
		if (copied === undefined) throw new Error("expected copied replay payload");
		(copied.args as { value: string }).value = "mutated read";
		expect(mappings.operation("chat-1", "op-1")?.result?.events).toEqual(expected);
	});

	test("operationResult retains mapping, assistant text, and a deep copy of replay payloads", () => {
		const events = [{ type: "tool_start", id: "tool-1", payload: { args: { value: "original" } } }];
		const result = operationResult("turn", {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 2,
			operationId: "op-1",
			assistantText: "done",
			events,
		});

		expect(result).toMatchObject({
			kind: "turn",
			assistantText: "done",
			events,
			mapping: {
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 1,
				eventCursor: 2,
				operationId: "op-1",
			},
		});
		expect(result.events).not.toBe(events);
		events[0]!.payload.args.value = "mutated input";
		expect(result.events?.[0]?.payload).toEqual({ args: { value: "original" } });
		const payload = result.events?.[0]?.payload;
		if (payload === undefined) throw new Error("expected replay payload");
		(payload.args as { value: string }).value = "mutated result";
		expect(events[0]!.payload.args.value).toBe("mutated input");
	});

	test("operationResult binds a compact gate identity without the gate payload", () => {
		const result = operationResult(
			"control",
			{
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 1,
				eventCursor: 2,
				operationId: "op-1",
				assistantText: "done",
				events: [],
			},
			{ gateId: "gate-1", commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
		);

		expect(result.gate).toEqual({
			gateId: "gate-1",
			commandId: "command-1",
			turnId: "turn-1",
			sessionId: "session-1",
		});
		expect(JSON.stringify(result)).not.toContain("schemaHash");
	});
});
