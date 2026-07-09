import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GjcContinueSessionInput,
	GjcRespondWorkflowGateInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../src/gjc/rpc-runner";
import { FileBackedSessionMappingStore, SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import type { RegisteredProject } from "../src/projects/registry";
import { InMemoryOutboxStore } from "../src/state/outbox";

class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly switches: GjcSwitchSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];
	readonly gateResponses: GjcRespondWorkflowGateInput[] = [];

	state: GjcSessionState = {
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
	};
	events: GjcTurnResult["events"] = [{ type: "assistant", text: "assistant from gjc" }];

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		this.starts.push(input);
		return {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-1",
			text: `new:${input.text}`,
			events: this.events,
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
		};
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		this.continues.push(input);
		return {
			text: `continued:${input.text}`,
			events: this.events,
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-2",
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
		};
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		this.switches.push(input);
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		this.states.push(input);
		return this.state;
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		this.gateResponses.push(input);
		return {
			text: "workflow gate accepted",
			events: [{ type: "assistant", text: "workflow gate accepted" }],
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-gate",
			rawFrameCursor: input.rawFrameCursor,
			eventCursor: input.eventCursor,
		};
	}
}

describe("createGjcRoutingLiveGatewayRunner", () => {
	test("surfaces workflow gate options as the assistant message", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [deepInterviewWorkflowGateEvent];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings: new SessionMappingStore() });

		const result = await runner.run({
			project,
			prompt: "/deep-interview",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		expect(result.content).toContain("Choose authentication method");
		expect(result.content).toContain("1. JWT");
		expect(result.content).toContain("Reply with a number");
	});

	test("routes numbered workflow gate replies back to GJC instead of continuing the session", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "pending",
			events: [deepInterviewWorkflowGateEvent],
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		const result = await runner.run({
			project,
			prompt: "1",
			chatId: "chat-1",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "user-1",
			continued: true,
		});

		expect(result).toEqual({ content: "workflow gate accepted" });
		expect(turnRunner.continues).toHaveLength(0);
		expect(turnRunner.gateResponses).toMatchObject([
			{
				gateId: "gate-deep-1",
				answer: { selected: ["JWT"] },
				idempotencyKey: "chat-1:user-2",
				userMessageId: "user-2",
			},
		]);
	});

	test("rejects invalid numbered workflow gate replies without answering GJC", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "pending",
			events: [deepInterviewWorkflowGateEvent],
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(
			runner.run({
				project,
				prompt: "9",
				chatId: "chat-1",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "user-1",
				continued: true,
			}),
		).rejects.toThrow("Invalid workflow gate reply");
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(turnRunner.continues).toHaveLength(0);
	});

	test("rejects workflow gate replies when the stored session file is outside the project session root", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/tmp/outside-session.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "pending",
			events: [deepInterviewWorkflowGateEvent],
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(
			runner.run({
				project,
				prompt: "1",
				chatId: "chat-1",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "user-1",
				continued: true,
			}),
		).rejects.toThrow("outside project session root");
		expect(turnRunner.gateResponses).toHaveLength(0);
	});

	test("routes numbered approval gate replies as structured decisions", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "pending",
			events: [decisionWorkflowGateEvent],
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await runner.run({
			project,
			prompt: "1",
			chatId: "chat-1",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "user-1",
			continued: true,
		});

		expect(turnRunner.gateResponses).toMatchObject([
			{
				gateId: "gate-plan-1",
				answer: { decision: "approve" },
				idempotencyKey: "chat-1:user-2",
			},
		]);
	});

	test("continues mapped HTTP-style turns through switchSession and getState", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "old-leaf",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "user-1",
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		const result = await runner.run({
			project,
			prompt: "again",
			chatId: "chat-1",
			messageId: "assistant-2",
			userMessageId: "user-2",
			userMessageParentId: "user-1",
			continued: true,
		});

		expect(result).toEqual({ content: "continued:again" });
		expect(turnRunner.starts).toHaveLength(0);
		expect(turnRunner.switches).toHaveLength(1);
		expect(turnRunner.states).toHaveLength(1);
		expect(turnRunner.continues).toHaveLength(1);
		expect(turnRunner.continues[0]).toMatchObject({
			chatId: "chat-1",
			sessionId: "session-1",
			userMessageId: "user-2",
			parentId: "user-1",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-2",
		});
	});

	test("persists mappings across file-backed store instances", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const first = new FileBackedSessionMappingStore(filePath);
		first.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "new:hello",
			events: [{ type: "assistant", text: "new:hello" }],
		});

		const second = new FileBackedSessionMappingStore(filePath);
		expect(second.get("chat-1")).toEqual(first.get("chat-1"));
	});

	test("returns cached duplicate content after store reload without rerunning", async () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const firstStore = new FileBackedSessionMappingStore(filePath);
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings: firstStore });
		expect(
			await first.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });

		const secondRunner = new FakeGjcTurnRunner();
		const secondStore = new FileBackedSessionMappingStore(filePath);
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings: secondStore });

		expect(
			await second.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });
		expect(secondRunner.starts).toHaveLength(0);
		expect(secondRunner.switches).toHaveLength(0);
		expect(secondRunner.continues).toHaveLength(0);
	});

	test("enqueues a stable session_mapping outbox operation when provided", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const outbox = new InMemoryOutboxStore();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox, ownerUserId: "owner-1" });

		await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		const operations = outbox.listPending();
		expect(operations).toHaveLength(1);
		expect(operations[0]).toMatchObject({
			operationId: "user-1",
			ownerUserId: "owner-1",
			projectId: project.id,
			chatId: "chat-1",
			kind: "session_mapping",
			state: "pending",
		});
		const enqueued = outbox.get("user-1");
		if (enqueued === undefined) throw new Error("expected enqueued operation");
		expect(operations[0]?.payloadHash).toBe(enqueued.payloadHash);
	});
});

const project: RegisteredProject = {
	id: "project",
	name: "Project",
	cwd: "/workspace/project",
	modelId: "gjc/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const deepInterviewWorkflowGateEvent = {
	type: "workflow_gate",
	id: "gate-deep-1",
	payload: {
		gateId: "gate-deep-1",
		stage: "deep-interview",
		kind: "question",
		schemaHash: "sha256:deep",
		idempotencyKey: "idem-deep-1",
		context: { prompt: "Choose authentication method" },
		options: [
			{ label: "JWT", value: "JWT" },
			{ label: "OAuth2", value: "OAuth2" },
			{ label: "Session cookies", value: "Session cookies" },
		],
		schema: {
			type: "object",
			required: ["selected"],
			additionalProperties: false,
			properties: {
				selected: {
					type: "array",
					minItems: 1,
					items: { type: "string", enum: ["JWT", "OAuth2", "Session cookies"] },
				},
			},
		},
	},
} as const;

const decisionWorkflowGateEvent = {
	type: "workflow_gate",
	id: "gate-plan-1",
	payload: {
		gateId: "gate-plan-1",
		stage: "ralplan",
		kind: "approval",
		schemaHash: "sha256:decision",
		context: { prompt: "Approve this plan?" },
		options: [
			{ label: "Approve", value: "approve" },
			{ label: "Reject", value: "reject" },
		],
		schema: {
			type: "object",
			required: ["decision"],
			additionalProperties: false,
			properties: {
				decision: { type: "string", enum: ["approve", "reject"] },
			},
		},
	},
} as const;
