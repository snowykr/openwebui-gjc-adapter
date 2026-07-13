import { describe, expect, test } from "bun:test";
import { createGjcRpcTurnRunner } from "../src/gjc/rpc-runner";
import { FakeRpcTransport, recordFactory } from "./gjc-rpc-runner-fixtures";

describe("createGjcRpcTurnRunner workflow gates", () => {
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

	test("answers workflow gates and persists the refreshed RPC state", async () => {
		const client = new FakeRpcTransport({
			states: [
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					activeLeaf: "leaf-1",
					rawFrameCursor: 11,
					eventCursor: 5,
				},
				{
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-2.jsonl",
					activeLeaf: "leaf-2",
					rawFrameCursor: 12,
					eventCursor: 6,
				},
			],
			assistantTexts: ["accepted"],
			advanceStateAfterRespondGate: true,
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
		expect(result).toMatchObject({
			text: "accepted",
			sessionFile: "/workspace/project/.gjc/sessions/session-2.jsonl",
			activeLeaf: "leaf-2",
			rawFrameCursor: 12,
			eventCursor: 6,
		});
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
});
