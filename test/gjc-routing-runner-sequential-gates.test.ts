import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedSessionMappingStore } from "../src/gjc/scoped-session-mapping-store";
import type { SessionMappingStore } from "../src/gjc/session-router";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { workflowGateOperationHash } from "../src/live/workflow-gate-turn-utils";
import { replayCompletedWorkflowGateReply } from "../src/live/workflow-gate-turns";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { managedPreparedAuthority } from "./gjc-lifecycle-fixtures";
import { deepInterviewWorkflowGateEvent, FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

const principalId = "owner-test";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mappingFile(): string {
	const root = mkdtempSync(join(tmpdir(), "gjc-sequential-gate-v3-"));
	roots.push(root);
	return join(root, "mappings.json");
}

function managedMappings(filePath = mappingFile()): SessionMappingStore {
	return scopedSessionMappingStore(new V3FileBackedSessionMappingStore(filePath), principalId, "chat-1");
}

describe("createGjcRoutingLiveGatewayRunner sequential workflow gates", () => {
	test("resumes a persisted correlation and stores the next gate", async () => {
		const filePath = mappingFile();
		managedMappings(filePath).set(pendingGateSeed());
		const mappings = managedMappings(filePath);
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.gateResponseEvents = [nextWorkflowGateEvent];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		const result = await runner.run(gateReplyInput("user-2"));

		expect(turnRunner.gateResponses[0]?.gateCorrelation).toEqual({
			commandId: "command-1",
			turnId: "turn-1",
			sessionId: "session-1",
		});
		expect(turnRunner.gateResponses[0]?.managedAuthority).toEqual(pendingGateSeed().managedAuthority);
		expect(result.content).toContain("Choose deployment target");
		expect(result.content).toContain("1. Cloud");
		expect(managedMappings(filePath).get("chat-1")?.events?.at(-1)).toMatchObject({
			id: "gate-deep-2",
			payload: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
		});
	});
	test("bounds carried record gates while retaining each operation's immutable V3 events", async () => {
		const filePath = mappingFile();
		const mappings = managedMappings(filePath);
		mappings.set(pendingGateSeed());
		const firstRunner = new FakeGjcTurnRunner();
		firstRunner.gateResponseEvents = [firstTurnMessageUpdate, nextWorkflowGateEvent];
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings });
		await first.run(gateReplyInput("user-2"));
		const firstResult = mappings.operation("chat-1", "user-2")?.result;

		const secondRunner = new FakeGjcTurnRunner();
		secondRunner.gateResponseEvents = [secondTurnMessageUpdate];
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings });
		await second.run(gateReplyInput("user-3"));

		const restarted = managedMappings(filePath);
		const persisted = restarted.get("chat-1");
		expect(persisted?.events?.filter(event => event.type === "workflow_gate").map(event => event.id)).toEqual([
			"gate-deep-2",
		]);
		const serialized = JSON.stringify(persisted?.events);
		expect(serialized).toContain("second-turn-update-text");
		expect(serialized).not.toContain("first-turn-update-text");
		expect(serialized).not.toContain("idem-deep-1");
		expect(persisted?.events?.at(-1)).toMatchObject({ type: "message_update" });
		expect(restarted.operation("chat-1", "user-2")?.result).toEqual(firstResult);
		expect(JSON.stringify(firstResult?.events)).toContain("first-turn-update-text");
		expect(JSON.stringify(firstResult?.events)).toContain("idem-deep-1");
		expect(firstRunner.gateResponses).toHaveLength(1);
		expect(secondRunner.gateResponses).toHaveLength(1);
	});
	test("rejects a conflicting payload replay of the current completed gate op", async () => {
		const mappings = managedMappings();
		mappings.set(pendingGateSeed());
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
		const mappings = managedMappings();
		mappings.set(pendingGateSeed());
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.gateResponseEvents = [firstTurnMessageUpdate];
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		await gateway.run(gateReplyInput("user-2"));

		const replayed = await gateway.run(gateReplyInput("user-2"));

		expect(replayed.content).toBe("workflow gate accepted");
		expect(turnRunner.gateResponses).toHaveLength(1);
	});
	test("verifies a replayed gate op superseded by a regular turn without re-enqueuing projections", async () => {
		const filePath = mappingFile();
		const outbox = new InMemoryOutboxStore();
		const mappings = managedMappings(filePath);
		mappings.set(pendingGateSeed());
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.gateResponseEvents = [firstTurnMessageUpdate];
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox });
		await gateway.run(gateReplyInput("user-2"));
		expect(mappings.operation("chat-1", "user-2")?.result?.gate).toEqual(answeredGateBinding);

		await gateway.run({ ...gateReplyInput("user-3"), prompt: "regular follow-up" });
		expect(mappings.get("chat-1")?.operationId).toBe("user-3");
		const rowsAfterRegularTurn = outbox.listPending().length;

		const replayRunner = new FakeGjcTurnRunner();
		const restarted = createGjcRoutingLiveGatewayRunner({
			turnRunner: replayRunner,
			mappings: managedMappings(filePath),
			outbox,
		});
		const replayed = await restarted.run(gateReplyInput("user-2"));
		expect(replayed.content).toBe("workflow gate accepted");
		expect(outbox.listPending().length).toBe(rowsAfterRegularTurn);

		await expect(restarted.run({ ...gateReplyInput("user-2"), prompt: "2" })).rejects.toThrow(
			"completed without a valid immutable result binding",
		);
		expect(turnRunner.continues).toHaveLength(1);
		expect(replayRunner.gateResponses).toHaveLength(0);
		expect(replayRunner.continues).toHaveLength(0);
	});
	test("verifies a replayed gate op superseded by a later gate without re-enqueuing projections", async () => {
		const mappings = managedMappings();
		mappings.set(pendingGateSeed());
		const outbox = new InMemoryOutboxStore();
		const firstRunner = new FakeGjcTurnRunner();
		firstRunner.gateResponseEvents = [firstTurnMessageUpdate, nextWorkflowGateEvent];
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings, outbox });
		await first.run(gateReplyInput("user-2"));
		const secondRunner = new FakeGjcTurnRunner();
		secondRunner.gateResponseEvents = [secondTurnMessageUpdate];
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings, outbox });
		await second.run(gateReplyInput("user-3"));
		expect(mappings.get("chat-1")?.operationId).toBe("user-3");
		const rowsAfterSecondGate = outbox.listPending().length;
		// Only the current operation's answered gate is carried on the record;
		// the prior result retains both its compact binding and immutable events.
		const replayed = await second.run(gateReplyInput("user-2"));
		expect(replayed.content).toContain("Choose deployment target");
		expect(outbox.listPending().length).toBe(rowsAfterSecondGate);

		await expect(second.run({ ...gateReplyInput("user-2"), prompt: "2" })).rejects.toThrow(
			"completed without a valid immutable result binding",
		);
		expect(firstRunner.gateResponses).toHaveLength(1);
		expect(secondRunner.gateResponses).toHaveLength(1);
	});
	for (const binding of ["immutable events", "compact identity"] as const) {
		test(`verifies a superseded V3 gate op independently through its ${binding}`, () => {
			const filePath = mappingFile();
			const mappings = managedMappings(filePath);
			const turnRunner = new FakeGjcTurnRunner();
			mappings.set(pendingGateSeed());
			const hash = workflowGateOperationHash(gateReplyInput("user-2"), answeredGateBinding);
			mappings.beginOperation("chat-1", { id: "user-2", kind: "gate", ingressId: "user-2", detail: hash });
			mappings.transitionOperation("chat-1", "user-2", "complete", hash, {
				kind: "control",
				assistantText: "persisted gate accepted",
				events: binding === "immutable events" ? [deepInterviewWorkflowGateEvent] : [],
				...(binding === "compact identity" ? { gate: answeredGateBinding } : {}),
				managedAuthority: managedPreparedAuthority({ requestKey: "user-2" }),
				mapping: {
					chatId: "chat-1",
					projectId: project.id,
					sessionId: "session-1",
					rawFrameCursor: 7,
					eventCursor: 3,
					operationId: "user-2",
				},
			});
			mappings.upsert({
				...pendingGateSeed(),
				operationId: "user-3",
				events: [{ type: "assistant", text: "regular" }],
			});

			const restarted = managedMappings(filePath);
			const replayed = replayCompletedWorkflowGateReply(
				{ turnRunner, mappings: restarted },
				gateReplyInput("user-2"),
			);
			expect(replayed?.content).toBe("persisted gate accepted");
			expect(() =>
				replayCompletedWorkflowGateReply(
					{ turnRunner, mappings: restarted },
					{ ...gateReplyInput("user-2"), prompt: "2" },
				),
			).toThrow("completed without a valid immutable result binding");
		});
	}
});

function pendingGateSeed(): Parameters<SessionMappingStore["set"]>[0] {
	return {
		principalId,
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		managedAuthority: managedPreparedAuthority(),
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
		ownerUserId: principalId,
		continued: true,
	};
}

const answeredGateBinding = {
	gateId: "gate-deep-1",
	commandId: "command-1",
	turnId: "turn-1",
	sessionId: "session-1",
};

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
