import { describe, expect, test } from "bun:test";
import type { SessionAttachmentProof, SessionOperation } from "../src/gjc/session-authority";
import type { SessionMapping } from "../src/gjc/session-router";
import type { LiveGatewayRunner, LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createGjcIdleSessionReaper, DEFAULT_IDLE_SESSION_TIMEOUT_MS } from "../src/live/gjc-idle-session-reaper";

const project = {
	id: "project-1",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

class MappingFixture {
	mapping: SessionMapping = createMapping("turn-1");
	readonly operations = new Map<string, SessionOperation>([["turn-1", completedOperation("turn-1", 0)]]);
	get(chatId: string): SessionMapping | undefined {
		return chatId === this.mapping.chatId ? this.mapping : undefined;
	}
	entries(): readonly SessionMapping[] {
		return [this.mapping];
	}
	operation(_chatId: string, operationId: string): SessionOperation | undefined {
		return this.operations.get(operationId);
	}
	publish(operationId: string, completedAt = 0): void {
		this.mapping = createMapping(operationId);
		this.operations.set(operationId, completedOperation(operationId, completedAt));
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
		readonly run?: (input: LiveGatewayRunnerInput) => Promise<{ readonly content: string; readonly model: string }>;
	} = {},
) {
	const clock = new ManualTimers();
	const mappings = new MappingFixture();
	const closeCalls: Array<{ readonly mapping: SessionMapping; readonly ingressId: string }> = [];
	const discarded: string[] = [];
	const base: LiveGatewayRunner = {
		run: options.run ?? (async () => ({ content: "done", model: "gjc" })),
		stop: () => {},
	};
	const reaper = createGjcIdleSessionReaper({
		runner: base,
		mappings,
		closeSession: async (mapping, ingress) => {
			closeCalls.push({ mapping, ingressId: ingress.ingressId });
			return { status: "closed" };
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
});
