import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackedSessionMappingStore, SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { deepInterviewWorkflowGateEvent, FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

describe("createGjcRoutingLiveGatewayRunner sequential workflow gates", () => {
	test("resumes a persisted correlation and stores the next gate", async () => {
		// Given: a process restart reloads a pending gate and its SDK turn correlation.
		const root = mkdtempSync(join(tmpdir(), "gjc-sequential-gate-"));
		try {
			const filePath = join(root, "mappings.json");
			new FileBackedSessionMappingStore(filePath).set({
				...pendingGateSeed(),
			});
			const mappings = new FileBackedSessionMappingStore(filePath);
			const turnRunner = new FakeGjcTurnRunner();
			turnRunner.gateResponseEvents = [nextWorkflowGateEvent];
			const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

			// When: the reloaded gate is answered.
			const result = await runner.run({
				project,
				prompt: "1",
				chatId: "chat-1",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "user-1",
				continued: true,
			});

			// Then: the resumed answer uses the original correlation and persists the new gate.
			expect(turnRunner.gateResponses[0]?.gateCorrelation).toEqual({
				commandId: "command-1",
				turnId: "turn-1",
				sessionId: "session-1",
			});
			expect(result.content).toContain("Choose deployment target");
			expect(result.content).toContain("1. Cloud");
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.events?.at(-1)).toMatchObject({
				id: "gate-deep-2",
				payload: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("carries only the answered and next gate events across gate replies instead of full history", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-sequential-gate-carry-"));
		try {
			const filePath = join(root, "mappings.json");
			const mappings = new FileBackedSessionMappingStore(filePath);
			mappings.set({
				...pendingGateSeed(),
			});

			const firstRunner = new FakeGjcTurnRunner();
			firstRunner.gateResponseEvents = [firstTurnMessageUpdate, nextWorkflowGateEvent];
			const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings });
			await first.run(gateReplyInput("user-2"));

			const secondRunner = new FakeGjcTurnRunner();
			secondRunner.gateResponseEvents = [secondTurnMessageUpdate];
			const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings });
			await second.run(gateReplyInput("user-3"));

			const persisted = new FileBackedSessionMappingStore(filePath).get("chat-1");
			expect(persisted?.events?.filter(event => event.type === "workflow_gate").map(event => event.id)).toEqual([
				"gate-deep-2",
			]);
			const serialized = JSON.stringify(persisted?.events);
			expect(serialized).toContain("second-turn-update-text");
			expect(serialized).not.toContain("first-turn-update-text");
			expect(serialized).not.toContain("idem-deep-1");
			expect(persisted?.events?.at(-1)).toMatchObject({ type: "message_update" });
			expect(firstRunner.gateResponses).toHaveLength(1);
			expect(secondRunner.gateResponses).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("rejects a conflicting payload replay of the current completed gate op", async () => {
		const mappings = new SessionMappingStore();
		mappings.set({
			...pendingGateSeed(),
		});
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.gateResponseEvents = [firstTurnMessageUpdate];
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		await gateway.run(gateReplyInput("user-2"));
		expect(mappings.get("chat-1")?.operationId).toBe("user-2");

		await expect(gateway.run({ ...gateReplyInput("user-2"), prompt: "2" })).rejects.toThrow(
			"completed without a valid immutable result binding",
		);
		expect(turnRunner.gateResponses).toHaveLength(1);
	});
	test("accepts an identical replay of the current completed gate op without a second gate response", async () => {
		const mappings = new SessionMappingStore();
		mappings.set({
			...pendingGateSeed(),
		});
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.gateResponseEvents = [firstTurnMessageUpdate];
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		await gateway.run(gateReplyInput("user-2"));

		const replayed = await gateway.run(gateReplyInput("user-2"));

		expect(replayed.content).toBe("workflow gate accepted");
		expect(turnRunner.gateResponses).toHaveLength(1);
	});
	test("accepts a replayed gate op superseded by a regular turn without re-enqueueing rows", async () => {
		const mappings = new SessionMappingStore();
		const outbox = new InMemoryOutboxStore();
		mappings.set({
			...pendingGateSeed(),
		});
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.gateResponseEvents = [firstTurnMessageUpdate];
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox });
		await gateway.run(gateReplyInput("user-2"));

		await gateway.run({ ...gateReplyInput("user-3"), prompt: "regular follow-up" });
		expect(mappings.get("chat-1")?.operationId).toBe("user-3");
		const rowsAfterRegularTurn = outbox.listPending().length;

		const replayed = await gateway.run(gateReplyInput("user-2"));

		expect(replayed.content).toBe("workflow gate accepted");
		expect(outbox.listPending().length).toBe(rowsAfterRegularTurn);
		expect(turnRunner.continues).toHaveLength(1);
	});
	test("accepts a replayed gate op superseded by a later gate via the durable detail binding", async () => {
		const mappings = new SessionMappingStore();
		mappings.set({
			...pendingGateSeed(),
		});
		const firstRunner = new FakeGjcTurnRunner();
		firstRunner.gateResponseEvents = [firstTurnMessageUpdate, nextWorkflowGateEvent];
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings });
		await first.run(gateReplyInput("user-2"));
		const secondRunner = new FakeGjcTurnRunner();
		secondRunner.gateResponseEvents = [secondTurnMessageUpdate];
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings });
		await second.run(gateReplyInput("user-3"));
		expect(mappings.get("chat-1")?.operationId).toBe("user-3");
		// Only the answered gate of the CURRENT operation is retained; the
		// earlier answered gate is gone, so the replay is accepted through the
		// durable detail binding for both identical and conflicting payloads.
		const replayed = await second.run(gateReplyInput("user-2"));
		expect(replayed.content).toContain("Choose deployment target");

		const conflicting = await second.run({ ...gateReplyInput("user-2"), prompt: "2" });
		expect(conflicting.content).toContain("Choose deployment target");
		expect(firstRunner.gateResponses).toHaveLength(1);
		expect(secondRunner.gateResponses).toHaveLength(1);
	});
});

function pendingGateSeed(): Parameters<SessionMappingStore["set"]>[0] {
	return {
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
		operationId: "user-1",
		assistantText: "pending",
		modelSelection: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "medium" },
		events: [deepInterviewWorkflowGateEvent],
	};
}

function gateReplyInput(userMessageId: string) {
	return {
		project,
		prompt: "1",
		chatId: "chat-1",
		messageId: `assistant-${userMessageId}`,
		userMessageId,
		userMessageParentId: "user-1",
		continued: true,
	};
}

const firstTurnMessageUpdate = {
	type: "message_update",
	payload: {
		assistantMessageEvent: { type: "text_delta", text: "first-turn-update-text" },
	},
} as const;

const secondTurnMessageUpdate = {
	type: "message_update",
	payload: {
		assistantMessageEvent: { type: "text_delta", text: "second-turn-update-text" },
	},
} as const;

const nextWorkflowGateEvent = {
	type: "workflow_gate",
	id: "gate-deep-2",
	payload: {
		gateId: "gate-deep-2",
		schemaHash: "sha256:next",
		idempotencyKey: "idem-deep-2",
		commandId: "command-1",
		turnId: "turn-1",
		sessionId: "session-1",
		context: { prompt: "Choose deployment target" },
		options: [
			{ label: "Cloud", value: "cloud" },
			{ label: "Local", value: "local" },
		],
		schema: { type: "string", enum: ["cloud", "local"] },
	},
} as const;
