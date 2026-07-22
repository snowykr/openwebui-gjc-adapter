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
				payload: {
					assistantMessageEvent: {
						type: "reasoning_summary_start",
						partial: { thinkingSignature: secret },
					},
				},
			},
			{
				type: "message_update",
				payload: {
					assistantMessageEvent: {
						type: "reasoning_summary_delta",
						delta: "Checking weather",
						partial: { rawBuffer: secret, thinkingSignature: secret },
					},
				},
			},
			{
				type: "message_update",
				payload: { assistantMessageEvent: { type: "reasoning_summary_end", partial: { secret } } },
			},
			{
				type: "message_update",
				payload: { assistantMessageEvent: { type: "thinking_end", text: secret, nested: { secret } } },
			},
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking", text: secret } } },
			{
				type: "message_update",
				payload: { assistantMessageEvent: { type: "tool_call", name: "read", args: { secret } } },
			},
			{
				type: "message_update",
				payload: { assistantMessageEvent: { type: "toolcall_start", partial: { secret } } },
			},
			{
				type: "message_update",
				payload: { assistantMessageEvent: { type: "toolcall_delta", delta: secret, partial: { secret } } },
			},
			{
				type: "message_update",
				payload: {
					assistantMessageEvent: {
						type: "toolcall_end",
						toolCall: { name: "read", arguments: { secret } },
						partial: { secret },
					},
				},
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

		const liveEvents: NonNullable<Awaited<ReturnType<typeof runner.run>>["events"]>[number][] = [];
		const result = await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
			requestedModelId: "gjc",
			onLiveEvents: events => {
				liveEvents.push(...events);
			},
		});
		let content = "";
		if (result.chunks !== undefined) for await (const chunk of result.chunks) content += chunk;
		expect(content).toBe("new:hello");

		const serialized = JSON.stringify(liveEvents);
		expect(serialized).not.toContain(secret);
		expect(liveEvents).toEqual([
			status("Thinking started", false, "skill_progress"),
			status("Thinking in progress", false, "skill_progress"),
			status("Thinking: Checking weather", false, "skill_progress"),
			status("Thinking completed", true, "skill_progress"),
			status("Thinking completed", true, "skill_progress"),
			status("Tool read started", false, "tool_progress"),
			status("Tool started", false, "tool_progress"),
			status("Tool read finished", true, "tool_progress"),
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
		]);
		for (const event of liveEvents) {
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
	test("rejects before opening a stream when the first observed frame is agent_failed", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.observedEvents = [{ type: "agent_failed" }];
		turnRunner.completionError = new Error("GJC prompt failed");
		const liveEvents: unknown[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new SessionMappingStore(),
			modelReaderFactory: staticModelReaderFactory(),
		});

		await expect(
			runner.run({
				project,
				prompt: "hello",
				chatId: "chat-failed",
				messageId: "assistant-failed",
				userMessageId: "user-failed",
				userMessageParentId: null,
				continued: false,
				requestedModelId: "gjc",
				onLiveEvents: events => {
					liveEvents.push(...events);
				},
			}),
		).rejects.toThrow("GJC prompt failed");
		expect(liveEvents).toEqual([]);
	});
	test("preserves artifact fallback events after observing a terminal frame", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.observedEvents = [{ type: "agent_start" }, { type: "agent_end" }];
		turnRunner.events = [
			{ type: "agent_start" },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start" } } },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
			{ type: "tool_execution_start", payload: { toolName: "read" } },
			{ type: "tool_execution_end", payload: { toolName: "read" } },
			{ type: "agent_end" },
		];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new SessionMappingStore(),
			modelReaderFactory: staticModelReaderFactory(),
		});
		const liveEvents: NonNullable<Awaited<ReturnType<typeof runner.run>>["events"]>[number][] = [];
		const result = await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-artifact-fallback",
			messageId: "assistant-artifact-fallback",
			userMessageId: "user-artifact-fallback",
			userMessageParentId: null,
			continued: false,
			requestedModelId: "gjc",
			onLiveEvents: events => {
				liveEvents.push(...events);
			},
		});
		if (result.chunks === undefined) throw new Error("expected live chunks");
		for await (const _chunk of result.chunks) {
			// Drain the response so completion events are delivered.
		}

		expect(liveEvents).toEqual([
			status("agent_start", false),
			status("Thinking started", false, "skill_progress"),
			status("Thinking completed", true, "skill_progress"),
			status("Tool read started", false, "tool_progress"),
			status("Tool read finished", true, "tool_progress"),
			status("agent_end", true),
		]);
	});
	test.each(["delta", "text"] as const)(
		"streams native text deltas from %s before terminal persistence completes",
		async field => {
			const turnRunner = new FakeGjcTurnRunner();
			let release!: () => void;
			turnRunner.completionBarrier = new Promise<void>(resolve => {
				release = resolve;
			});
			turnRunner.events = [
				{
					type: "message_update",
					payload: { assistantMessageEvent: { type: "text_delta", [field]: "new:" } },
				},
			];
			const runner = createGjcRoutingLiveGatewayRunner({
				turnRunner,
				mappings: new SessionMappingStore(),
				modelReaderFactory: staticModelReaderFactory(),
			});

			const result = await runner.run({
				project,
				prompt: "hello",
				chatId: "chat-stream",
				messageId: "assistant-stream",
				userMessageId: "user-stream",
				userMessageParentId: null,
				continued: false,
				requestedModelId: "gjc",
				onLiveEvents: () => undefined,
			});
			if (result.chunks === undefined) throw new Error("expected live chunks");
			if (!(Symbol.asyncIterator in result.chunks)) throw new Error("expected async live chunks");
			const iterator = result.chunks[Symbol.asyncIterator]();

			expect(await iterator.next()).toEqual({ value: "new:", done: false });
			let secondSettled = false;
			const second = iterator.next().then(value => {
				secondSettled = true;
				return value;
			});
			await Promise.resolve();
			expect(secondSettled).toBeFalse();

			release();
			expect(await second).toEqual({ value: "hello", done: false });
			expect(await iterator.next()).toEqual({ value: undefined, done: true });
		},
	);
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
