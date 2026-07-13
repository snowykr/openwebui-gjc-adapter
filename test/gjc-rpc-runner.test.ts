import { describe, expect, test } from "bun:test";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import { createGjcRpcTurnRunner, createResolvedGjcRpcTurnRunner, GjcRpcRunnerError } from "../src/gjc/rpc-runner";
import { FakeRpcTransport, type RecordedClient, recordFactory } from "./gjc-rpc-runner-fixtures";

describe("createGjcRpcTurnRunner", () => {
	test("starts a project-bound new session and persists event cursors", async () => {
		const runtimeLocations = resolveGjcRuntimeLocations({ mode: "managed" });
		const sdkSessionRoot = "/var/lib/gjc/home/.gjc/agent/sessions/--workspace-project--";
		const client = new FakeRpcTransport({
			states: [
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-1",
					rawFrameCursor: 11,
					eventCursor: 5,
				},
			],
			promptEvents: [
				[
					{ type: "message_update", message: { content: [{ type: "text", text: "partial" }] } },
					{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" },
				],
			],
			assistantTexts: ["assistant final"],
		});
		const created: RecordedClient[] = [];
		const runner = createGjcRpcTurnRunner({ runtimeLocations, clientFactory: recordFactory(created, client) });

		const result = await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		expect(created).toHaveLength(1);
		expect(created[0]?.options.cwd).toBe("/workspace/project");
		expect(created[0]?.options.sessionRoot).toBe(sdkSessionRoot);
		expect(created[0]?.client).toBe(client);
		expect(created[0]?.options.runtimeLocations).toBeDefined();
		expect(client.calls).toEqual([
			{ type: "start" },
			{ type: "new_session" },
			{ type: "on_workflow_gate" },
			{ type: "prompt", message: "hello" },
			{ type: "get_state" },
			{ type: "get_last_assistant_text" },
		]);
		expect(result).toMatchObject({
			cwd: "/workspace/project",
			sessionRoot: sdkSessionRoot,
			projectId: "project",
			chatId: "chat-1",
			sessionId: "session-1",
			text: "assistant final",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 11,
			eventCursor: 5,
		});
		expect(result.events).toEqual([
			{ type: "message_update", text: "partial" },
			{ type: "tool_execution_start", id: "tool-1", text: "bash" },
		]);
	});

	test("passes configured CLI path to the RPC transport", async () => {
		const runtimeLocations = resolveGjcRuntimeLocations({ mode: "managed" });
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
			assistantTexts: ["assistant final"],
		});
		const created: RecordedClient[] = [];
		const runner = createGjcRpcTurnRunner({
			cliPath: "/opt/gjc/src/cli.ts",
			runtimeLocations,
			clientFactory: recordFactory(created, client),
		});

		await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		expect(created).toMatchObject([
			{
				options: {
					cwd: "/workspace/project",
					sessionRoot: "/var/lib/gjc/home/.gjc/agent/sessions/--workspace-project--",
					cliPath: "/opt/gjc/src/cli.ts",
				},
				client,
			},
		]);
		expect(created[0]?.options.runtimeLocations).toBe(runtimeLocations);
	});

	test("uses the current-dev SDK session directory instead of the adapter mapping root", async () => {
		// Given: managed runtime locations and a legacy adapter-owned session root.
		const runtimeLocations = resolveGjcRuntimeLocations({ mode: "managed" });
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
			assistantTexts: ["assistant final"],
		});
		const created: RecordedClient[] = [];
		const runner = createResolvedGjcRpcTurnRunner({
			runtimeLocations,
			clientFactory: recordFactory(created, client),
		});

		// When: the adapter starts a session for the managed /workspace mount.
		const result = await runner.startNewSession({
			cwd: "/workspace",
			sessionRoot: "/run/gjc-session",
			projectId: "workspace",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		// Then: both transport discovery and returned authority use the SDK-owned root.
		const sdkSessionRoot = "/var/lib/gjc/home/.gjc/agent/sessions/--workspace--";
		expect(created[0]?.options.sessionRoot).toBe(sdkSessionRoot);
		expect(result.sessionRoot).toBe(sdkSessionRoot);
	});

	test("continues with switch_session then refreshed get_state before prompting", async () => {
		const client = new FakeRpcTransport({
			states: [
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-fresh",
					rawFrameCursor: 20,
					eventCursor: 9,
				},
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-after",
					rawFrameCursor: 23,
					eventCursor: 11,
				},
			],
			promptEvents: [
				[
					{ type: "message_update", message: { content: [{ type: "text", text: "continued partial" }] } },
					{ type: "tool_execution_start", toolCallId: "tool-2", toolName: "read" },
				],
			],
			assistantTexts: ["continued final"],
		});
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });
		const address = {
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			sessionId: "session-1",
			chatId: "chat-1",
		};

		await runner.switchSession(address);
		const state = await runner.getState(address);
		const result = await runner.continueSession({
			...address,
			userMessageId: "message-2",
			parentId: "message-1",
			text: "again",
			activeLeaf: state.activeLeaf,
			rawFrameCursor: state.rawFrameCursor,
			eventCursor: state.eventCursor,
			operationId: "message-2",
		});

		expect(client.calls).toEqual([
			{ type: "start" },
			{ type: "switch_session", sessionPath: undefined },
			{ type: "get_state" },
			{ type: "on_workflow_gate" },
			{ type: "prompt", message: "again" },
			{ type: "get_state" },
			{ type: "get_last_assistant_text" },
		]);
		expect(result).toEqual({
			text: "continued final",
			events: [
				{ type: "message_update", text: "continued partial" },
				{ type: "tool_execution_start", id: "tool-2", text: "read" },
			],
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-after",
			rawFrameCursor: 23,
			eventCursor: 11,
		});
	});

	test("surfaces RPC command failures with command context", async () => {
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
		});
		client.failCommand = "prompt";
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });

		const promise = runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		await expect(promise).rejects.toThrow(GjcRpcRunnerError);
		await expect(promise).rejects.toThrow("GJC RPC prompt failed: fake prompt failure");
	});
});
