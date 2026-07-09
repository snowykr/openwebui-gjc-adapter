import { describe, expect, test } from "bun:test";
import { SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import {
	decisionWorkflowGateEvent,
	deepInterviewWorkflowGateEvent,
	FakeGjcTurnRunner,
	project,
} from "./gjc-routing-runner-fixtures";

describe("createGjcRoutingLiveGatewayRunner workflow gates", () => {
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
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		const result = await runner.run(replyInput("1"));

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
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(runner.run(replyInput("9"))).rejects.toThrow("Invalid workflow gate reply");
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(turnRunner.continues).toHaveLength(0);
	});

	test("rejects workflow gate replies when the stored session file is outside the project session root", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent, "/tmp/outside-session.jsonl");
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(runner.run(replyInput("1"))).rejects.toThrow("outside project session root");
		expect(turnRunner.gateResponses).toHaveLength(0);
	});

	test("routes numbered approval gate replies as structured decisions", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(decisionWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await runner.run(replyInput("1"));

		expect(turnRunner.gateResponses).toMatchObject([
			{
				gateId: "gate-plan-1",
				answer: { decision: "approve" },
				idempotencyKey: "chat-1:user-2",
			},
		]);
	});
});

function pendingGateMappings(event: unknown, sessionFile = "/workspace/project/.gjc/sessions/session-1.jsonl") {
	const mappings = new SessionMappingStore();
	mappings.set({
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile,
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
		operationId: "user-1",
		assistantText: "pending",
		events: [event as never],
	});
	return mappings;
}

function replyInput(prompt: string) {
	return {
		project,
		prompt,
		chatId: "chat-1",
		messageId: "assistant-2",
		userMessageId: "user-2",
		userMessageParentId: "user-1",
		continued: true,
	};
}
