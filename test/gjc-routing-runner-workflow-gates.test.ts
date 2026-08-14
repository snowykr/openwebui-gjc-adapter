import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { projectTurnEvents, synthesizeProjectionRows } from "../src/live/workflow-gate-projection";
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
				promptText: "1",
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
	test("bounds oversized gate fields before projecting the gate label", () => {
		// projectPendingWorkflowGateMessage() concatenates the prompt and every
		// option before boundedText() truncates; a retained gate with a
		// payload-sized prompt would allocate that whole string during boot
		// projection. The projected label must equal boundedText() applied to the
		// full message while never materializing the full message itself.
		const hugePrompt = "x".repeat(10_000);
		const hugeLabel = "y".repeat(10_000);
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-huge-1",
					payload: {
						gateId: "gate-huge-1",
						schemaHash: "sha256:huge",
						idempotencyKey: "idem-huge-1",
						boundUserMessageId: null,
						status: "pending",
						context: { prompt: hugePrompt },
						options: [{ label: hugeLabel, value: hugeLabel }],
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		// The projected label is boundedText() of the assembled message; the
		// huge fields must not leak past the 80-char truncation.
		expect(description!.length).toBeLessThanOrEqual(80);
		expect(description!).not.toContain("x".repeat(80));
		expect(description!).not.toContain("y".repeat(80));
	});
	test("preserves the schema-derived gate prompt fallback in the projected label", () => {
		// A gate without context.prompt/title must keep projectPendingWorkflowGateMessage()'s
		// schema fallback; dropping it would change the payload hash across an upgrade
		// and make startup synthesis reject the stored outbox row.
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-string-1",
					payload: {
						gateId: "gate-string-1",
						schemaHash: "sha256:string",
						idempotencyKey: "idem-string-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { type: "string" },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		expect(description!).toContain("Answer with the requested text for this workfl");
	});
	test("bounds a huge schema enum in the gate prompt fallback", () => {
		// A large enum must not be joined whole before the label truncates;
		// only the bounded prefix is projected.
		const hugeEnum = Array.from({ length: 10_000 }, (_, index) => `option-${index}`);
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-enum-1",
					payload: {
						gateId: "gate-enum-1",
						schemaHash: "sha256:enum",
						idempotencyKey: "idem-enum-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { enum: hugeEnum },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		expect(description!.length).toBeLessThanOrEqual(80);
		expect(description!).toContain("option-0");
		expect(description!).not.toContain("option-9999");
	});
	test("keeps the oversized first enum value's prefix in the gate prompt", () => {
		// A first enum value that alone exceeds the window must retain its
		// prefix (boundedText of the assembled message would show it); dropping
		// it would change the payload hash across the streaming change.
		const oversized = "x".repeat(100);
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-enum-first-1",
					payload: {
						gateId: "gate-enum-first-1",
						schemaHash: "sha256:enum-first",
						idempotencyKey: "idem-enum-first-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { enum: [oversized] },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		expect(description!.length).toBeLessThanOrEqual(80);
		expect(description!).toContain("Choose one of: " + "x".repeat(20));
		expect(description!).not.toContain("Choose one of: " + "x".repeat(80));
	});
	test("preserves the authenticated principal for workflow gate publication and replay after restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-workflow-gate-projection-"));
		const mappingFile = join(root, "mappings.json");
		const principalId = "normal-workflow-user";
		const adminPrincipalId = "admin-1";
		const seed = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const seedMapping = requiredMapping(seed);
		const mappings = new FileBackedSessionMappingStore(mappingFile);
		mappings.setScoped({ principalId, chatId: "chat-1" }, { ...seedMapping, principalId });
		const turn = { ...replyInput("1"), ownerUserId: principalId };
		const outbox = new InMemoryOutboxStore();
		try {
			const first = createGjcRoutingLiveGatewayRunner({
				turnRunner: new FakeGjcTurnRunner(),
				mappings,
				outbox,
				ownerUserId: adminPrincipalId,
			});
			await first.run(turn);
			expect(outbox.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId, ownerUserId: principalId },
				{ operationId: `${turn.userMessageId}:event`, principalId, ownerUserId: principalId },
			]);

			const restartedMappings = new FileBackedSessionMappingStore(mappingFile);
			const synthesized = new InMemoryOutboxStore();
			synthesizeProjectionRows(synthesized, restartedMappings, adminPrincipalId, adminPrincipalId);
			expect(synthesized.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId, ownerUserId: principalId },
				{ operationId: `${turn.userMessageId}:event`, principalId, ownerUserId: principalId },
			]);

			const replayRunner = new FakeGjcTurnRunner();
			const replay = createGjcRoutingLiveGatewayRunner({
				turnRunner: replayRunner,
				mappings: restartedMappings,
				outbox: synthesized,
				ownerUserId: adminPrincipalId,
			});
			await replay.run(turn);
			expect(synthesized.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId, ownerUserId: principalId },
				{ operationId: `${turn.userMessageId}:event`, principalId, ownerUserId: principalId },
			]);
			expect(replayRunner.gateResponses).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("streams resumed workflow gate events before completion", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		let release!: () => void;
		turnRunner.completionBarrier = new Promise<void>(resolve => {
			release = resolve;
		});
		turnRunner.gateResponseEvents = [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", text: "workflow " } } },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start" } } },
			{ type: "agent_end" },
		];
		const liveEvents: unknown[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const result = await runner.run({
			...replyInput("1"),
			requestedModelId: "gjc/anthropic/claude-sonnet-4:medium",
			onLiveEvents: events => {
				liveEvents.push(...events);
			},
		});
		if (result.chunks === undefined) throw new Error("expected live chunks");
		if (!(Symbol.asyncIterator in result.chunks)) throw new Error("expected async live chunks");
		const iterator = result.chunks[Symbol.asyncIterator]();

		expect(await iterator.next()).toEqual({ value: "workflow ", done: false });
		expect(turnRunner.gateResponses[0]?.observer).toBeDefined();
		release();
		expect(await iterator.next()).toEqual({ value: "gate accepted", done: false });
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
		expect(liveEvents).toEqual([
			expect.objectContaining({
				type: "status",
				data: expect.objectContaining({ description: "Thinking started", done: false }),
			}),
			expect.objectContaining({
				type: "status",
				data: expect.objectContaining({ description: "agent_end", done: true }),
			}),
		]);
	});
	test("delivers workflow gate artifact fallback after terminal-only observation", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		turnRunner.gateObservedEvents = [{ type: "agent_end" }];
		turnRunner.gateResponseEvents = [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start" } } },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
			{ type: "tool_execution_start", payload: { toolName: "read" } },
			{ type: "tool_execution_end", payload: { toolName: "read" } },
			{ type: "agent_end" },
		];
		const liveEvents: unknown[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const result = await runner.run({
			...replyInput("1"),
			requestedModelId: "gjc/anthropic/claude-sonnet-4:medium",
			onLiveEvents: events => {
				liveEvents.push(...events);
			},
		});
		if (result.chunks === undefined) throw new Error("expected live chunks");
		for await (const _chunk of result.chunks) {
			// Drain the response so completion fallback events are delivered.
		}

		expect(liveEvents).toEqual([
			expect.objectContaining({ data: expect.objectContaining({ description: "Thinking started" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "Thinking completed" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "Tool read started" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "Tool read finished" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "agent_end" }) }),
		]);
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
				const before = readAuthorityMerged(filePath);
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
				const document = readAuthorityMerged(filePath) as {
					readonly mappings: readonly { readonly chatId?: unknown }[];
					readonly provisionalOperations: readonly Record<string, unknown>[];
				};
				expect(document.mappings).toEqual(
					(before as { readonly mappings: readonly { readonly chatId?: unknown }[] }).mappings,
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
			expect(readAuthorityMerged(filePath)).toMatchObject({
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

function readAuthorityMerged(filePath: string): any {
	const base = JSON.parse(readFileSync(filePath, "utf8"));
	const walPath = `${filePath}.wal`;
	let walBytes: string;
	try {
		walBytes = readFileSync(walPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return base;
		throw error;
	}
	const lines = walBytes.split("\n").filter(line => line.length > 0);
	if (lines.length === 0) return base;
	let header: any;
	try {
		header = JSON.parse(lines[0]!);
	} catch {
		return base;
	}
	const baseStat = statSync(filePath);
	if (header?.base?.size !== baseStat.size || header?.base?.mtimeMs !== baseStat.mtimeMs) return base;
	const records = new Map<string, any>();
	const provisional = new Map<string, any>();
	for (const record of base.mappings ?? []) records.set(record.chatId, record);
	for (const operation of base.provisionalOperations ?? [])
		provisional.set(JSON.stringify([operation.chatId, operation.ingressId ?? operation.id]), operation);
	for (const line of lines.slice(1)) {
		let delta: any;
		try {
			delta = JSON.parse(line);
		} catch {
			continue;
		}
		if (delta?.kind !== "openwebui-gjc-session-authority-wal") continue;
		for (const record of delta.records ?? []) records.set(record.chatId, record);
		for (const item of delta.provisional ?? [])
			if (item?.key !== undefined) provisional.set(item.key, item.operation);
	}
	return { ...base, mappings: [...records.values()], provisionalOperations: [...provisional.values()] };
}

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
		async getActiveProviders() {
			return [{ provider: "anthropic", connectionKind: "credential" }];
		},
		async getState() {
			return {};
		},
		stop() {},
	};
}
