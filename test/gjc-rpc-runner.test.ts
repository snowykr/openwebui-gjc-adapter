import { describe, expect, test } from "bun:test";
import { createGjcRpcTurnRunner, GjcRpcRunnerError } from "../src/gjc/rpc-runner";
import { FakeRpcTransport, type RecordedClient, recordFactory } from "./gjc-rpc-runner-fixtures";

describe("createGjcRpcTurnRunner", () => {
	test("starts a project-bound new session and persists event cursors", async () => {
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
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory(created, client) });

		const result = await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});

		expect(created).toEqual([
			{ options: { cwd: "/workspace/project", sessionRoot: "/workspace/project/.gjc/sessions" }, client },
		]);
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
			sessionRoot: "/workspace/project/.gjc/sessions",
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
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 }],
			assistantTexts: ["assistant final"],
		});
		const created: RecordedClient[] = [];
		const runner = createGjcRpcTurnRunner({
			cliPath: "/opt/gjc/src/cli.ts",
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

		expect(created).toEqual([
			{
				options: {
					cwd: "/workspace/project",
					sessionRoot: "/workspace/project/.gjc/sessions",
					cliPath: "/opt/gjc/src/cli.ts",
				},
				client,
			},
		]);
	});

	test("preserves workflow gate payloads from RPC events", async () => {
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 1 }],
			promptEvents: [
				[
					{
						type: "workflow_gate",
						gate_id: "gate-deep-1",
						stage: "deep-interview",
						kind: "question",
						schema_hash: "sha256:deep",
						schema: {
							type: "object",
							required: ["selected"],
							properties: { selected: { type: "array", items: { type: "string" } } },
						},
						options: [{ label: "JWT", value: "JWT" }],
						context: { prompt: "Choose authentication method" },
						required: true,
					},
				],
			],
			assistantTexts: [""],
		});
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });

		const result = await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "/deep-interview",
		});

		expect(result.events).toMatchObject([
			{
				type: "workflow_gate",
				id: "gate-deep-1",
				payload: {
					gateId: "gate-deep-1",
					stage: "deep-interview",
					kind: "question",
					schemaHash: "sha256:deep",
					options: [{ label: "JWT", value: "JWT" }],
					context: { prompt: "Choose authentication method" },
				},
			},
		]);
	});

	test("collects workflow gates delivered through the top-level RPC listener", async () => {
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 0, eventCursor: 1 }],
			promptEvents: [[]],
			assistantTexts: [""],
		});
		client.workflowGateOnPrompt = {
			type: "workflow_gate",
			gate_id: "gate-deep-1",
			stage: "deep-interview",
			kind: "question",
			schema_hash: "sha256:deep",
			created_at: "2026-07-09T00:00:00.000Z",
			schema: { type: "object", required: ["selected"], properties: { selected: { type: "array" } } },
			options: [{ label: "JWT", value: "JWT" }],
			context: { prompt: "Choose authentication method" },
			required: true,
		};
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });

		const result = await runner.startNewSession({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "/deep-interview",
		});

		expect(client.calls).toContainEqual({ type: "on_workflow_gate" });
		expect(result.events).toMatchObject([
			{
				type: "workflow_gate",
				id: "gate-deep-1",
				payload: {
					gateId: "gate-deep-1",
					createdAt: "2026-07-09T00:00:00.000Z",
					required: true,
				},
			},
		]);
	});

	test("answers workflow gates through the RPC transport", async () => {
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
			assistantTexts: ["accepted"],
		});
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });
		const result = await runner.respondWorkflowGate?.({
			cwd: "/workspace/project",
			sessionRoot: "/workspace/project/.gjc/sessions",
			projectId: "project",
			sessionId: "session-1",
			chatId: "chat-1",
			gateId: "gate-deep-1",
			answer: { selected: ["JWT"] },
			idempotencyKey: "idem-deep-1",
			userMessageId: "message-2",
			parentId: "message-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			rawFrameCursor: 10,
			eventCursor: 4,
			operationId: "message-2",
		});

		expect(client.calls).toEqual([
			{ type: "start" },
			{ type: "respond_gate", gateId: "gate-deep-1", answer: { selected: ["JWT"] }, idempotencyKey: "idem-deep-1" },
			{ type: "get_state" },
			{ type: "get_last_assistant_text" },
		]);
		expect(result).toMatchObject({ text: "accepted", rawFrameCursor: 11, eventCursor: 5 });
	});

	test("surfaces rejected workflow gate resolutions from the RPC transport", async () => {
		const client = new FakeRpcTransport({
			states: [{ sessionId: "session-1", rawFrameCursor: 10, eventCursor: 4 }],
			assistantTexts: ["should not be read"],
		});
		client.respondGateResult = {
			gate_id: "gate-deep-1",
			status: "rejected",
			answer_hash: "sha256:answer",
			resolved_at: "2026-07-09T00:00:00.000Z",
			error: {
				code: "invalid_workflow_gate_answer",
				errors: [{ path: "answer.selected", keyword: "enum", message: "Invalid selection" }],
			},
		};
		const runner = createGjcRpcTurnRunner({ clientFactory: recordFactory([], client) });

		await expect(
			runner.respondWorkflowGate?.({
				cwd: "/workspace/project",
				sessionRoot: "/workspace/project/.gjc/sessions",
				projectId: "project",
				sessionId: "session-1",
				chatId: "chat-1",
				gateId: "gate-deep-1",
				answer: { selected: ["BAD"] },
				idempotencyKey: "idem-deep-1",
				userMessageId: "message-2",
				parentId: "message-1",
				rawFrameCursor: 10,
				eventCursor: 4,
				operationId: "message-2",
			}),
		).rejects.toThrow("GJC RPC workflow_gate_response failed: invalid_workflow_gate_answer");
		expect(client.calls).toEqual([
			{ type: "start" },
			{ type: "respond_gate", gateId: "gate-deep-1", answer: { selected: ["BAD"] }, idempotencyKey: "idem-deep-1" },
		]);
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
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
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
			{ type: "switch_session", sessionPath: "/workspace/project/.gjc/sessions/session-1.jsonl" },
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
