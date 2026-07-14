import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackedSessionMappingStore, SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { InMemoryOutboxStore } from "../src/state/outbox";
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
				gateCorrelation: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
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

	test("classifies duplicate replay before catalog or transport and keeps its immutable binding", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		mappings.upsert({ ...requiredMapping(mappings), operationId: "user-2", assistantText: "cached" });
		let readerCount = 0;
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "gjc",
			createNeutralModelReader: () => {
				readerCount += 1;
				throw new Error("must not read");
			},
		});

		expect(await runner.run(replyInput("1"))).toMatchObject({
			content: "cached",
			model: "gjc/anthropic/claude-sonnet-4:medium",
		});
		expect(readerCount).toBe(0);
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(turnRunner.starts).toHaveLength(0);
	});

	test("rejects pending missing or mismatched bindings without mutable reads or writes", async () => {
		for (const modelSelection of [
			undefined,
			{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
		] as const) {
			const turnRunner = new FakeGjcTurnRunner();
			const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
			const before = requiredMapping(mappings);
			mappings.set({ ...before, modelSelection });
			let readerCount = 0;
			const runner = createGjcRoutingLiveGatewayRunner({
				turnRunner,
				mappings,
				requestedModelId: () => "gjc/anthropic/claude-sonnet-4:medium",
				createNeutralModelReader: () => {
					readerCount += 1;
					throw new Error("must not read");
				},
			});

			await expect(runner.run(replyInput("1"))).rejects.toThrow(
				modelSelection === undefined ? "no valid GJC model selection binding" : "original GJC model selection",
			);
			expect(readerCount).toBe(0);
			expect(turnRunner.gateResponses).toHaveLength(0);
			expect(mappings.get("chat-1")).toEqual({ ...before, modelSelection });
		}
	});

	test("answers a matching pending gate from its bound tuple despite mutable catalog drift", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		let readerCount = 0;
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "gjc",
			createNeutralModelReader: () => {
				readerCount += 1;
				throw new Error("drifted catalog must not be read");
			},
		});

		expect(await runner.run(replyInput("1"))).toEqual({
			content: "workflow gate accepted",
			model: "gjc/anthropic/claude-sonnet-4:medium",
		});
		expect(readerCount).toBe(0);
		expect(turnRunner.gateResponses).toHaveLength(1);
		expect(mappings.get("chat-1")?.modelSelection).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4",
			thinkingLevel: "medium",
		});
	});

	for (const failure of ["setter", "prompt"] as const) {
		test(`keeps file-backed bytes and outbox unchanged after selected ${failure} failure`, async () => {
			const root = mkdtempSync(join(tmpdir(), `gjc-${failure}-failure-`));
			try {
				const filePath = join(root, "mappings.json");
				const mappings = new FileBackedSessionMappingStore(filePath);
				mappings.set({ ...baseMapping("seed-chat"), operationId: "seed-user" });
				const before = readFileSync(filePath, "utf8");
				const turnRunner = new FakeGjcTurnRunner();
				const start = turnRunner.startNewSession.bind(turnRunner);
				turnRunner.startNewSession = async input => {
					if (failure === "prompt") await start(input);
					throw new Error(`${failure} failed`);
				};
				const outbox = new InMemoryOutboxStore();
				const runner = createGjcRoutingLiveGatewayRunner({
					turnRunner,
					mappings,
					outbox,
					requestedModelId: () => "gjc/anthropic/claude-sonnet-4:low",
					createNeutralModelReader: selectedReader,
				});

				await expect(runner.run({ ...replyInput("hello"), chatId: "failed-chat" })).rejects.toThrow(
					`${failure} failed`,
				);
				expect(mappings.get("failed-chat")).toBeUndefined();
				expect(readFileSync(filePath, "utf8")).toBe(before);
				expect(hashText(readFileSync(filePath, "utf8"))).toBe(hashText(before));
				expect(outbox.listPending()).toHaveLength(0);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
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
		modelSelection: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "medium" },
		events: [event as never],
	});
	return mappings;
}

function requiredMapping(mappings: SessionMappingStore) {
	const mapping = mappings.get("chat-1");
	if (mapping === undefined) throw new Error("expected mapping");
	return mapping;
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

function baseMapping(chatId: string) {
	return {
		chatId,
		projectId: project.id,
		sessionId: "session-1",
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "user-1",
	};
}

function selectedReader() {
	return {
		async getAvailableModels() {
			return [
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
					reasoning: true,
					thinking: { validLevels: ["off", "low"] },
				},
			];
		},
		async getState() {
			return {};
		},
		stop() {},
	};
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
