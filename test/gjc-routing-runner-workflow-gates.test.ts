import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedModelSelection } from "../src/contracts";
import { SessionAuthorityLoadError } from "../src/gjc/session-authority";
import {
	FileBackedSessionMappingStore,
	SessionFileBoundaryError,
	SessionMappingStore,
} from "../src/gjc/session-router";
import type {
	GjcLifecycleTransaction,
	GjcSessionAddress,
	GjcStartNewSessionInput,
	GjcTurnResult,
} from "../src/gjc/turn-runner";
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
		expect(mappings.get("chat-1")?.attachment).toMatchObject({
			expectedSessionId: "session-1",
			expectedCwd: project.cwd,
		});
	});
	test("cold-resumes a persisted gate binding and answers its exact session without starting a new turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-cold-gate-"));
		try {
			const filePath = join(root, "mappings.json");
			const first = new FileBackedSessionMappingStore(filePath);
			for (const mapping of pendingGateMappings(deepInterviewWorkflowGateEvent).entries()) first.set(mapping);
			const turnRunner = new FakeGjcTurnRunner();
			const resumed = createGjcRoutingLiveGatewayRunner({
				turnRunner,
				mappings: new FileBackedSessionMappingStore(filePath),
			});

			await expect(resumed.run(replyInput("1"))).resolves.toEqual({ content: "workflow gate accepted" });
			expect(turnRunner.starts).toHaveLength(0);
			expect(turnRunner.continues).toHaveLength(0);
			expect(turnRunner.gateResponses).toMatchObject([
				{
					gateId: "gate-deep-1",
					sessionId: "session-1",
					sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
					gateCorrelation: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
				},
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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

		await expect(runner.run(replyInput("1"))).rejects.toBeInstanceOf(SessionFileBoundaryError);
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
			const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent, undefined, modelSelection ?? null);
			const before = requiredMapping(mappings);
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
				class FailingStartFakeGjcTurnRunner extends FakeGjcTurnRunner {
					async startNewSession<T>(
						input: GjcStartNewSessionInput,
						publish: (
							result: GjcSessionAddress & GjcTurnResult,
							lifecycle: GjcLifecycleTransaction,
						) => Promise<T>,
					): Promise<T> {
						if (failure === "setter") throw new Error(`${failure} failed`);
						return await super.startNewSession(input, async (result, lifecycle) => {
							if (failure === "prompt") throw new Error(`${failure} failed`);
							return await publish(result, lifecycle);
						});
					}
				}
				const turnRunner = new FailingStartFakeGjcTurnRunner();
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
				const document = JSON.parse(readFileSync(filePath, "utf8")) as {
					readonly mappings: readonly { readonly chatId?: unknown }[];
					readonly provisionalOperations: readonly Record<string, unknown>[];
				};
				expect(document.mappings).toEqual(
					(JSON.parse(before) as { readonly mappings: readonly { readonly chatId?: unknown }[] }).mappings,
				);
				expect(document.mappings.some(mapping => mapping.chatId === "failed-chat")).toBeFalse();
				expect(document.provisionalOperations).toHaveLength(1);
				expect(document.provisionalOperations[0]).toMatchObject({
					id: "user-2",
					ingressId: "user-2",
					kind: "create",
					state: "uncertain",
					chatId: "failed-chat",
					projectId: "project",
					detail: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
				expect(Object.keys(document.provisionalOperations[0] ?? {}).sort()).toEqual([
					"chatId",
					"detail",
					"id",
					"ingressId",
					"kind",
					"projectId",
					"startedAt",
					"state",
				]);
				expect(JSON.stringify(document.provisionalOperations[0])).not.toMatch(/assistant|hello/);
				expect(outbox.listPending()).toHaveLength(0);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
	test("loads a v2 document without provisional operations until its next mutation", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v2-provisional-"));
		try {
			const filePath = join(root, "mappings.json");
			const mapping = {
				...baseMapping("legacy-chat"),
				version: 2,
				createdAt: "2026-01-01T00:00:00.000Z",
				header: { chatId: "legacy-chat", projectId: project.id, sessionId: "session-1" },
				journal: [],
			};
			const legacy = `${JSON.stringify(
				{ kind: "openwebui-gjc-session-authority", version: 2, mappings: [mapping] },
				null,
				2,
			)}\n`;
			writeFileSync(filePath, legacy, "utf8");

			const mappings = new FileBackedSessionMappingStore(filePath);
			expect(mappings.get("legacy-chat")).toMatchObject({ chatId: "legacy-chat" });
			expect(readFileSync(filePath, "utf8")).toBe(legacy);

			mappings.set({ ...baseMapping("next-chat"), operationId: "next-user" });
			expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
				provisionalOperations: [],
			});

			writeFileSync(filePath, JSON.stringify({ ...JSON.parse(legacy), provisionalOperations: {} }), "utf8");
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow(SessionAuthorityLoadError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("quarantines a legacy authority before writing v2 state", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v2-quarantine-"));
		try {
			const filePath = join(root, "mappings.json");
			const legacy = JSON.stringify([{ chatId: "old-chat" }]);
			writeFileSync(filePath, legacy, "utf8");

			const mappings = new FileBackedSessionMappingStore(filePath);
			expect(mappings.entries()).toEqual([]);
			const quarantines = readdirSync(root).filter(name => name.startsWith("mappings.json.legacy-"));
			expect(quarantines).toHaveLength(1);
			expect(readFileSync(join(root, quarantines[0]!), "utf8")).toBe(legacy);

			mappings.set({ ...baseMapping("new-chat"), operationId: "new-user" });
			expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
				kind: "openwebui-gjc-session-authority",
				version: 2,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function pendingGateMappings(
	event: unknown,
	sessionFile = "/workspace/project/.gjc/sessions/session-1.jsonl",
	modelSelection: NormalizedModelSelection | null = {
		provider: "anthropic",
		modelId: "claude-sonnet-4",
		thinkingLevel: "medium",
	},
) {
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
		modelSelection: modelSelection ?? undefined,
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
