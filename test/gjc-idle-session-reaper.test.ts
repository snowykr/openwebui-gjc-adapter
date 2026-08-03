import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import type { SessionAttachmentProof, SessionOperation } from "../src/gjc/session-authority";
import type { SessionMapping } from "../src/gjc/session-router";
import { SessionMappingStore } from "../src/gjc/session-router";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "../src/live/chat-completions";
import { createGjcIdleSessionReaper, DEFAULT_IDLE_SESSION_TIMEOUT_MS } from "../src/live/gjc-idle-session-reaper";
import type { GjcSessionTurnRunner } from "../src/live/gjc-routing-runner";
import type { OpenWebUIProjectionRepository } from "../src/openwebui/client";
import { FakeGjcTurnRunner } from "./cli-fixtures";

const project = {
	id: "project-1",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

class MappingFixture {
	mapping: SessionMapping = createMapping("turn-1");
	readonly operationRecords = new Map<string, SessionOperation>([["turn-1", completedOperation("turn-1", 0)]]);
	get(chatId: string): SessionMapping | undefined {
		return chatId === this.mapping.chatId ? this.mapping : undefined;
	}
	entries(): readonly SessionMapping[] {
		return [this.mapping];
	}
	operation(_chatId: string, operationId: string): SessionOperation | undefined {
		return this.operationRecords.get(operationId);
	}
	operations(_chatId: string): readonly SessionOperation[] {
		return [...this.operationRecords.values()];
	}
	recordClose(ingressId: string, state: SessionOperation["state"]): void {
		this.operationRecords.set(ingressId, {
			id: ingressId,
			kind: "close",
			state,
			ingressId,
			startedAt: new Date(0).toISOString(),
			...(state === "complete"
				? {
						completedAt: new Date(0).toISOString(),
						result: {
							kind: "close" as const,
							assistantText: "",
							events: [],
							mapping: this.mapping,
							correlation: { closeStatus: "closed", mappingOperationId: this.mapping.operationId },
						},
					}
				: {}),
			detail: ingressId,
		});
	}
	recordActivity(id: string, state: SessionOperation["state"], startedAt: number): void {
		this.operationRecords.set(id, {
			id,
			kind: "prompt",
			state,
			ingressId: id,
			startedAt: new Date(startedAt).toISOString(),
			detail: `activity:${id}`,
		});
	}
	publish(operationId: string, completedAt = 0): void {
		this.mapping = createMapping(operationId);
		this.operationRecords.set(operationId, completedOperation(operationId, completedAt));
	}
}

class ManualTimers {
	now = 0;
	private nextId = 1;
	private readonly pending = new Map<number, { readonly at: number; readonly handler: () => void }>();
	setTimeout(handler: () => void, timeoutMs: number): number {
		const id = this.nextId++;
		this.pending.set(id, { at: this.now + timeoutMs, handler });
		return id;
	}
	clearTimeout(id: number): void {
		this.pending.delete(id);
	}
	advance(timeoutMs: number): void {
		this.now += timeoutMs;
		for (const [id, timer] of [...this.pending]) {
			if (timer.at > this.now) continue;
			this.pending.delete(id);
			timer.handler();
		}
	}
	count(): number {
		return this.pending.size;
	}
}

function createInput(chatId = "chat-1"): LiveGatewayRunnerInput {
	return {
		project,
		prompt: "hello",
		chatId,
		messageId: "assistant-1",
		userMessageId: "turn-1",
		userMessageParentId: null,
		continued: false,
	};
}

function createMapping(operationId: string): SessionMapping {
	return {
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		rawFrameCursor: 1,
		eventCursor: 1,
		operationId,
		attachment: attachmentProof(),
	};
}

function attachmentProof(): SessionAttachmentProof {
	return {
		descriptorPath: "/workspace/project/.gjc/descriptor.json",
		descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		payloadDigest: "digest",
		generation: 1,
		expectedSessionId: "session-1",
		expectedCwd: project.cwd,
		tmuxSocket: "socket",
		tmuxPane: "%1",
		tmuxPanePid: 42,
		tmuxOwnershipTag: "owned",
	};
}

function completedOperation(id: string, completedAt: number): SessionOperation {
	return {
		id,
		kind: "prompt",
		state: "complete",
		ingressId: id,
		startedAt: new Date(completedAt).toISOString(),
		completedAt: new Date(completedAt).toISOString(),
	};
}

function createHarness(
	options: {
		readonly run?: (input: LiveGatewayRunnerInput) => Promise<LiveGatewayRunnerResult>;
		readonly close?: (
			mapping: SessionMapping,
			ingress: { readonly ingressId: string; readonly ingressHash: string },
		) => Promise<import("../src/gjc/session-router").SessionCloseResult>;
		readonly stop?: () => void | Promise<void>;
	} = {},
) {
	const clock = new ManualTimers();
	const mappings = new MappingFixture();
	const closeCalls: Array<{ readonly mapping: SessionMapping; readonly ingressId: string }> = [];
	const discarded: string[] = [];
	const base: LiveGatewayRunner = {
		run: options.run ?? (async () => ({ content: "done", model: "gjc" })),
		stop: options.stop ?? (() => {}),
	};
	const reaper = createGjcIdleSessionReaper({
		runner: base,
		mappings,
		closeSession: async (mapping, ingress) => {
			closeCalls.push({ mapping, ingressId: ingress.ingressId });
			return options.close === undefined ? { status: "closed" } : await options.close(mapping, ingress);
		},
		now: () => clock.now,
		setTimeout: (handler, timeoutMs) =>
			clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
		clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		discardSessionAttachment: (cwd, sessionId) => discarded.push(`${cwd}:${sessionId}`),
	});
	return { clock, mappings, closeCalls, discarded, reaper };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("GJC idle session reaper", () => {
	test("uses the ten-minute default and does not close before the threshold", async () => {
		const harness = createHarness();
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS - 1);
		await flush();
		expect(harness.closeCalls).toHaveLength(0);
		harness.clock.advance(1);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);
		await harness.reaper.stop();
	});

	test("an active turn prevents an idle close race", async () => {
		let complete!: () => void;
		const harness = createHarness({
			run: () =>
				new Promise(resolve => {
					complete = () => resolve({ content: "done", model: "gjc" });
				}),
		});
		const pending = harness.reaper.runner.run(createInput());
		await flush();
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(0);
		complete();
		await pending;
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS - 1);
		await flush();
		expect(harness.closeCalls).toHaveLength(0);
		await harness.reaper.stop();
	});
	test("an explicit close shares the chat gate with a normal turn", async () => {
		let complete!: () => void;
		const harness = createHarness({
			run: () =>
				new Promise(resolve => {
					complete = () => resolve({ content: "done", model: "gjc" });
				}),
		});
		const pendingTurn = harness.reaper.runner.run(createInput());
		await flush();
		const pendingClose = harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "manual-close",
			ingressHash: "manual-close",
		});
		await flush();
		expect(harness.closeCalls).toHaveLength(0);
		complete();
		await pendingTurn;
		await pendingClose;
		expect(harness.closeCalls).toHaveLength(1);
		await harness.reaper.stop();
	});
	test("does not close while a persisted session operation is pending", async () => {
		const harness = createHarness();
		harness.mappings.recordActivity("pending-turn", "pending", harness.clock.now);
		const result = await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "manual-close",
			ingressHash: "manual-close",
		});

		expect(result).toMatchObject({ status: "unavailable" });
		expect(harness.closeCalls).toHaveLength(0);
		await harness.reaper.stop();
	});
	test("same-process explicit close reuses a successful idle close", async () => {
		const harness = createHarness();
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);
		const result = await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "explicit-close-after-idle",
			ingressHash: "explicit-close-after-idle",
		});
		expect(result).toEqual({ status: "closed" });
		expect(harness.closeCalls).toHaveLength(1);
		await harness.reaper.stop();
	});
	test("does not let a prior close suppress idle cleanup for a new mapping generation", async () => {
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			close: async (_mapping, ingress) => {
				harness.mappings.recordClose(ingress.ingressId, "complete");
				return { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);

		harness.mappings.publish("turn-2", harness.clock.now);
		await harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" });
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();

		expect(harness.closeCalls).toHaveLength(2);
		await harness.reaper.stop();
	});
	test("explicit close regenerates a repeated ingress after control activity", async () => {
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			close: async (_mapping, ingress) => {
				harness.mappings.recordClose(ingress.ingressId, "complete");
				return { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		const firstIngress = harness.closeCalls[0]!.ingressId;

		await harness.reaper.runner.run({ ...createInput(), control: { operation: "abort" } });
		const result = await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: firstIngress,
			ingressHash: firstIngress,
		});

		expect(result).toEqual({ status: "closed" });
		expect(harness.closeCalls).toHaveLength(2);
		expect(harness.closeCalls[1]!.ingressId).not.toBe(firstIngress);
		expect(harness.closeCalls[1]!.ingressId).toContain(":rearmed:");
		await harness.reaper.stop();
	});
	test("allocates distinct rearmed close ingress IDs across same-millisecond activity cycles", async () => {
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			close: async (_mapping, ingress) => {
				harness.mappings.recordClose(ingress.ingressId, "complete");
				return { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		const originalIngress = harness.closeCalls[0]!.ingressId;

		await harness.reaper.runner.run({ ...createInput(), control: { operation: "abort" } });
		await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: originalIngress,
			ingressHash: originalIngress,
		});
		await harness.reaper.runner.run({ ...createInput(), control: { operation: "abort" } });
		await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: originalIngress,
			ingressHash: originalIngress,
		});

		expect(harness.closeCalls).toHaveLength(3);
		expect(harness.closeCalls[1]!.ingressId).toContain(":rearmed:turn-1:1");
		expect(harness.closeCalls[2]!.ingressId).toContain(":rearmed:turn-1:2");
		await harness.reaper.stop();
	});
	test("recognizes a legacy completed close bound to the current mapping generation", async () => {
		const harness = createHarness();
		harness.mappings.recordClose("legacy-close", "complete");
		const legacy = harness.mappings.operationRecords.get("legacy-close")!;
		harness.mappings.operationRecords.set("legacy-close", {
			...legacy,
			startedAt: new Date(0).toISOString(),
			completedAt: new Date(0).toISOString(),
			result: {
				...legacy.result!,
				correlation: { closeStatus: "closed" },
			},
		});

		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();

		expect(harness.closeCalls).toHaveLength(0);
		await harness.reaper.stop();
	});
	test("does not reuse a legacy close after the mapping generation advances", async () => {
		const harness = createHarness();
		harness.mappings.recordClose("legacy-close", "complete");
		const legacy = harness.mappings.operationRecords.get("legacy-close")!;
		harness.mappings.operationRecords.set("legacy-close", {
			...legacy,
			startedAt: new Date(1).toISOString(),
			completedAt: new Date(1).toISOString(),
			result: {
				...legacy.result!,
				correlation: { closeStatus: "closed" },
			},
		});
		harness.mappings.publish("turn-2", 2);
		await harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" });
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS + 2);
		await flush();

		expect(harness.closeCalls).toHaveLength(1);
		await harness.reaper.stop();
	});
	test("retries a non-closed idle close with a new deterministic authority ingress", async () => {
		let attempts = 0;
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			close: async (_mapping, ingress) => {
				attempts += 1;
				harness.mappings.recordClose(ingress.ingressId, attempts === 1 ? "conflict" : "complete");
				return attempts === 1 ? { status: "unavailable", message: "endpoint unavailable" } : { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(attempts).toBe(2);
		expect(harness.closeCalls[0]?.ingressId).not.toBe(harness.closeCalls[1]?.ingressId);
		expect(harness.closeCalls[1]?.ingressId).toContain(":retry:1");
		await harness.reaper.stop();
	});

	test("retries an uncertain idle close without rewriting the prior authority operation", async () => {
		let attempts = 0;
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			close: async (_mapping, ingress) => {
				attempts += 1;
				harness.mappings.recordClose(ingress.ingressId, attempts === 1 ? "uncertain" : "complete");
				return attempts === 1
					? { status: "uncertain", message: "close acknowledgement uncertain" }
					: { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(attempts).toBe(2);
		expect(harness.closeCalls[1]?.ingressId).toContain(":retry:1");
		await harness.reaper.stop();
	});
	test("rearms idle cleanup after a control completes on a closed generation", async () => {
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			close: async (_mapping, ingress) => {
				harness.mappings.recordClose(ingress.ingressId, "complete");
				return { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);
		await harness.reaper.runner.run({ ...createInput(), control: { operation: "abort" } });
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(2);
		expect(harness.closeCalls[1]?.ingressId).toContain(":retry:1");
		await harness.reaper.stop();
	});

	test("rearms idle cleanup after a failed cold-resume attempt", async () => {
		let runCalls = 0;
		let harness!: ReturnType<typeof createHarness>;
		harness = createHarness({
			run: async () => {
				runCalls += 1;
				if (runCalls === 2) throw new Error("cold resume failed");
				return { content: "done", model: "gjc" };
			},
			close: async (_mapping, ingress) => {
				harness.mappings.recordClose(ingress.ingressId, "complete");
				return { status: "closed" };
			},
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		await expect(harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" })).rejects.toThrow(
			"cold resume failed",
		);
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(2);
		expect(harness.closeCalls[1]?.ingressId).toContain(":retry:1");
		await harness.reaper.stop();
	});
	test("recognizes an explicit completed close after reaper restart", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		mappings.recordClose("manual-close-operation", "complete");
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			closeSession: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		expect(clock.count()).toBe(0);
		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS * 2);
		await flush();
		expect(closeCalls).toBe(0);
		await reaper.stop();
	});
	test("matches a persisted production close result for the retained mapping generation", async () => {
		const clock = new ManualTimers();
		clock.now = Date.now();
		const mappings = new SessionMappingStore();
		const retained = createMapping("turn-1");
		mappings.set(retained);
		const closeIngressId = "manual-close-operation";
		mappings.beginOperation("chat-1", {
			id: closeIngressId,
			kind: "close",
			ingressId: closeIngressId,
			detail: "manual-close-hash",
		});
		mappings.completeOperationWithMapping("chat-1", closeIngressId, "manual-close-hash", retained, "close");
		const persistedClose = mappings.operation("chat-1", closeIngressId);
		expect(persistedClose?.result?.mapping.operationId).toBe(closeIngressId);
		expect(persistedClose?.result?.correlation?.mappingOperationId).toBe(retained.operationId);
		expect(mappings.get("chat-1")?.operationId).toBe(retained.operationId);
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			closeSession: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		const result = await reaper.closeSession(retained, {
			ingressId: "explicit-close-after-restart",
			ingressHash: "explicit-close-after-restart",
		});
		expect(result).toEqual({ status: "closed" });
		expect(closeCalls).toBe(0);
		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(closeCalls).toBe(0);
		await reaper.stop();
	});
	test("restart activity uses a newer uncertain journal operation for the current mapping generation", async () => {
		const clock = new ManualTimers();
		clock.now = 1_000;
		const mappings = new MappingFixture();
		mappings.recordActivity("turn-interrupted", "uncertain", 500);
		const closeCalls: string[] = [];
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			closeSession: async (_mapping, ingress) => {
				closeCalls.push(ingress.ingressId);
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS - 1_000);
		await flush();
		expect(closeCalls).toHaveLength(0);
		clock.advance(500);
		await flush();
		expect(closeCalls).toHaveLength(1);
		await reaper.stop();
	});
	test("restart pending journal activity remains a no-close guard", async () => {
		const clock = new ManualTimers();
		clock.now = 1_000;
		const mappings = new MappingFixture();
		mappings.recordActivity("turn-pending", "pending", 500);
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			closeSession: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS * 2);
		await flush();
		expect(closeCalls).toBe(0);
		await reaper.stop();
	});

	test("stop waits for an in-flight idle close before stopping the base runner", async () => {
		let releaseClose!: () => void;
		let baseStopped = false;
		const harness = createHarness({
			stop: () => {
				baseStopped = true;
			},
			close: () =>
				new Promise(resolve => {
					releaseClose = () => resolve({ status: "closed" });
				}),
		});
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);
		const stopping = harness.reaper.stop();
		await flush();
		expect(baseStopped).toBe(false);
		releaseClose();
		await stopping;
		expect(baseStopped).toBe(true);
	});

	test("retains the mapping after close so the next turn can resume it", async () => {
		const harness = createHarness();
		const original = harness.mappings.mapping;
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);
		expect(harness.mappings.get("chat-1")).toEqual(original);
		expect(harness.discarded).toEqual([`${project.cwd}:session-1`]);
		harness.mappings.publish("turn-2", harness.clock.now);
		await harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" });
		expect(harness.mappings.get("chat-1")?.operationId).toBe("turn-2");
		await harness.reaper.stop();
	});

	test("stop clears its timer and delegates to the base runner", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		let stopped = 0;
		const runner = createGjcIdleSessionReaper({
			runner: {
				run: async () => ({ content: "done", model: "gjc" }),
				stop: () => {
					stopped += 1;
				},
			},
			mappings,
			closeSession: async () => ({ status: "closed" }),
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
			now: () => clock.now,
		});
		await runner.runner.run(createInput());
		expect(clock.count()).toBe(1);
		await runner.stop();
		expect(clock.count()).toBe(0);
		expect(stopped).toBe(1);
	});
	test("holds the chat gate while a canceled stream drains its underlying source", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		let calls = 0;
		let first = true;
		let releaseDrain!: () => void;
		const drainReady = new Promise<void>(resolve => {
			releaseDrain = resolve;
		});
		const sourceIterator: AsyncIterator<string> & AsyncIterable<string> = {
			async next() {
				if (first) {
					first = false;
					return { value: "first", done: false };
				}
				await drainReady;
				return { value: undefined, done: true };
			},
			async return() {
				return { value: undefined, done: true };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
		const reaper = createGjcIdleSessionReaper({
			runner: {
				run: async () => {
					calls += 1;
					return { chunks: sourceIterator, model: "gjc" };
				},
			},
			mappings,
			closeSession: async () => ({ status: "closed" }),
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		const firstResult = await reaper.runner.run(createInput());
		const iterator = (firstResult.chunks as AsyncIterable<string>)[Symbol.asyncIterator]();
		await iterator.next();
		const cancelled = (
			iterator as AsyncIterator<string> & { return?: () => Promise<IteratorResult<string>> }
		).return?.();
		await flush();
		const second = reaper.runner.run({ ...createInput(), userMessageId: "turn-2" });
		await flush();
		expect(calls).toBe(1);
		releaseDrain();
		await cancelled;
		await second;
		expect(calls).toBe(2);
		await reaper.stop();
	});
	test("releases the chat gate when a handed-off stream is never read", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		let calls = 0;
		let releaseSource!: () => void;
		const sourceDone = new Promise<void>(resolve => {
			releaseSource = resolve;
		});
		const source = (async function* () {
			await sourceDone;
			yield "late";
		})();
		const reaper = createGjcIdleSessionReaper({
			runner: {
				run: async () => {
					calls += 1;
					return { chunks: source, model: "gjc" };
				},
			},
			mappings,
			closeSession: async () => ({ status: "closed" }),
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});

		const first = await reaper.runner.run(createInput());
		if (first.chunks === undefined || first.abandon === undefined)
			throw new Error("Expected streamed runner result.");
		const abandoned = first.abandon();
		const second = reaper.runner.run({ ...createInput(), userMessageId: "turn-2" });
		await flush();
		expect(calls).toBe(1);
		releaseSource();
		await abandoned;
		await second;
		expect(calls).toBe(2);
		await reaper.stop();
	});
	test("releases the gate when a stream iterator cannot be created", async () => {
		const harness = createHarness({
			run: async () => ({
				chunks: {
					[Symbol.asyncIterator]() {
						throw new Error("iterator construction failed");
					},
				},
				model: "gjc",
			}),
		});
		await expect(harness.reaper.runner.run(createInput())).rejects.toThrow("iterator construction failed");
		await expect(harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" })).rejects.toThrow(
			"iterator construction failed",
		);
		await harness.reaper.stop();
	});
});
test("adapter initialization failure stops the constructed reaper", async () => {
	const root = await mkdtemp(join(tmpdir(), "gjc-idle-reaper-init-"));
	const failure = new Error("projection startup failure");
	let stopCalls = 0;
	const turnRunner = new FakeGjcTurnRunner() as GjcSessionTurnRunner;
	turnRunner.stop = () => {
		stopCalls += 1;
	};
	const projectionRepository: OpenWebUIProjectionRepository = {
		async upsertFolder() {
			throw failure;
		},
		async upsertChat(record) {
			return record;
		},
		async replaceChatMessages(_ownerUserId, _chatId, messages) {
			return messages;
		},
		async getChat() {
			return undefined;
		},
	};
	try {
		await expect(
			buildAdapterServerOptions(
				{
					mode: "existing",
					bindHost: "127.0.0.1",
					bindPort: 8765,
					openWebUIBaseUrl: "http://127.0.0.1:3000",
					allowedProjectRoots: [root],
					projects: [{ cwd: root, name: "demo" }],
					statePath: join(root, "state"),
					sessionRoot: join(root, "sessions"),
					gjcCommand: "/bin/true",
					turnTimeoutMs: 60_000,
				},
				{ turnRunner, projectionRepository },
			),
		).rejects.toThrow(failure);
		expect(stopCalls).toBe(1);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
