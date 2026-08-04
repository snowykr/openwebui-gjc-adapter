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
import { type WorkspaceLeaseAcquireOptions, WorkspaceLeaseManager } from "../src/security/workspace-lease";
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
	getScoped(scope: { readonly principalId: string; readonly chatId: string }): SessionMapping | undefined {
		const mapping = this.get(scope.chatId);
		return mapping?.principalId === scope.principalId ? mapping : undefined;
	}
	operationScoped(
		scope: { readonly principalId: string; readonly chatId: string },
		operationId: string,
	): SessionOperation | undefined {
		return this.getScoped(scope)?.operationId === this.mapping.operationId
			? this.operationRecords.get(operationId)
			: undefined;
	}
	operationsScoped(scope: { readonly principalId: string; readonly chatId: string }): readonly SessionOperation[] {
		return this.getScoped(scope) === undefined ? [] : [...this.operationRecords.values()];
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
		ownerUserId: "owner-1",
	};
}

function createMapping(operationId: string): SessionMapping {
	return {
		chatId: "chat-1",
		principalId: "owner-1",
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
		adminPrincipalId: "owner-1",
	});
	return { clock, mappings, closeCalls, discarded, reaper };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
	await new Promise<void>(resolve => setImmediate(resolve));
	await Bun.sleep(5);
}

describe("GJC idle session reaper", () => {
	test("partitions same-chat lifecycle state by principal and closes only each scoped mapping", async () => {
		const clock = new ManualTimers();
		const mappingsByPrincipal = new Map<string, SessionMapping>([
			["owner-a", { ...createMapping("turn-a"), principalId: "owner-a" }],
			["owner-b", { ...createMapping("turn-b"), principalId: "owner-b" }],
		]);
		const operationsByPrincipal = new Map<string, SessionOperation>([
			["owner-a", completedOperation("turn-a", 0)],
			["owner-b", completedOperation("turn-b", 0)],
		]);
		const mappings = {
			get: () => undefined,
			getScoped: ({ principalId, chatId }: { principalId: string; chatId: string }) =>
				chatId === "chat-1" ? mappingsByPrincipal.get(principalId) : undefined,
			entries: () => [...mappingsByPrincipal.values()],
			operation: () => undefined,
			operationScoped: ({ principalId, chatId }: { principalId: string; chatId: string }, operationId: string) => {
				const operation = chatId === "chat-1" ? operationsByPrincipal.get(principalId) : undefined;
				return operation?.id === operationId ? operation : undefined;
			},
			operations: () => [],
			operationsScoped: ({ principalId, chatId }: { principalId: string; chatId: string }) => {
				const operation = chatId === "chat-1" ? operationsByPrincipal.get(principalId) : undefined;
				return operation === undefined ? [] : [operation];
			},
		};
		const workspaceRegistry = {
			open: async (userId: string) => ({
				userId,
				safeKey: "a".repeat(64),
				root: "/workspace",
				sessionRoot: "/workspace/.gjc/sessions",
			}),
		};
		const workspaceLeaseManager = {
			acquire: async () =>
				({
					assertFence: async () => {},
					release: async () => {},
				}) as never,
		};
		const runnerCalls: string[] = [];
		const closeCalls: string[] = [];
		const reaper = createGjcIdleSessionReaper({
			runner: {
				run: async turn => {
					const owner = turn.ownerUserId ?? "legacy";
					runnerCalls.push(owner);
					return {
						chunks: (async function* () {
							yield owner;
						})(),
					};
				},
			},
			mappings,
			closeSession: async mapping => {
				closeCalls.push(mapping.principalId ?? "legacy");
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
			workspaceRegistry,
			workspaceLeaseManager,
		});
		const [first, second] = await Promise.all([
			reaper.runner.run({ ...createInput(), ownerUserId: "owner-a" }),
			reaper.runner.run({ ...createInput(), ownerUserId: "owner-b" }),
		]);
		expect(runnerCalls).toEqual(["owner-a", "owner-b"]);
		if (first.chunks !== undefined)
			for await (const _chunk of first.chunks) {
				// drain
			}
		if (second.chunks !== undefined)
			for await (const _chunk of second.chunks) {
				// drain
			}
		await flush();
		expect(clock.count()).toBe(1);
		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(closeCalls.sort()).toEqual(["owner-a", "owner-b"]);
		await reaper.stop();
	});
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
	test("schedules a retained owned mapping with an empty journal conservatively", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		mappings.operationRecords.clear();
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			adminPrincipalId: "owner-1",
			closeSession: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});

		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(closeCalls).toBe(1);
		await reaper.stop();
	});
	test("skips a retained mapping with an unresolved manual close and no baseline operation", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		mappings.operationRecords.clear();
		mappings.recordClose("manual-close", "uncertain");
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			adminPrincipalId: "owner-1",
			closeSession: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});

		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();

		expect(closeCalls).toBe(0);
		await reaper.stop();
	});

	test("rejects an explicit close without a principal owner", async () => {
		const harness = createHarness();
		await expect(
			harness.reaper.closeSession(
				{ ...harness.mappings.mapping, principalId: undefined },
				{ ingressId: "missing-principal-close", ingressHash: "missing-principal-close" },
			),
		).rejects.toThrow("explicit principal owner");
		expect(harness.closeCalls).toHaveLength(0);
		await harness.reaper.stop();
	});
	test("does not reap an unowned persisted mapping", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		mappings.mapping = { ...mappings.mapping, principalId: undefined };
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
	test("serializes a same-user idle close behind a turn in another chat", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-idle-reaper-lease-"));
		try {
			const clock = new ManualTimers();
			const principalId = "normal-1";
			const safeKey = "a".repeat(64);
			const mappingByChat = new Map<string, SessionMapping>([
				["chat-1", { ...createMapping("turn-1"), chatId: "chat-1", principalId }],
				["chat-2", { ...createMapping("turn-2"), chatId: "chat-2", principalId }],
			]);
			const operationByChat = new Map<string, SessionOperation>([
				["chat-1", completedOperation("turn-1", 0)],
				["chat-2", completedOperation("turn-2", 0)],
			]);
			const mappings = {
				entries: () => [...mappingByChat.values()],
				getScoped: ({ principalId: owner, chatId }: { principalId: string; chatId: string }) =>
					owner === principalId ? mappingByChat.get(chatId) : undefined,
				operationScoped: (
					{ principalId: owner, chatId }: { principalId: string; chatId: string },
					operationId: string,
				) => {
					const operation = owner === principalId ? operationByChat.get(chatId) : undefined;
					return operation?.id === operationId ? operation : undefined;
				},
				operationsScoped: ({ principalId: owner, chatId }: { principalId: string; chatId: string }) =>
					owner === principalId
						? operationByChat.get(chatId) === undefined
							? []
							: [operationByChat.get(chatId)!]
						: [],
			};
			const workspaceLeaseManager = new WorkspaceLeaseManager({ stateRoot: root });
			let reaperLeaseAttempts = 0;
			let rejectedReaperLeaseAttempts = 0;
			const reaperWorkspaceLeaseManager = new Proxy(workspaceLeaseManager, {
				get(target, property, receiver) {
					if (property !== "acquire") return Reflect.get(target, property, receiver);
					return async (options: WorkspaceLeaseAcquireOptions) => {
						reaperLeaseAttempts += 1;
						try {
							return await target.acquire(options);
						} catch (error) {
							rejectedReaperLeaseAttempts += 1;
							throw error;
						}
					};
				},
			});
			const workspaceRegistry = {
				open: async (userId: string) => ({
					userId,
					safeKey,
					root,
					sessionRoot: join(root, ".gjc", "sessions"),
				}),
			};
			let releaseTurn!: () => void;
			const turnFinished = new Promise<void>(resolve => {
				releaseTurn = resolve;
			});
			let turnStarted!: () => void;
			const started = new Promise<void>(resolve => {
				turnStarted = resolve;
			});
			const closeCalls: string[] = [];
			const reaper = createGjcIdleSessionReaper({
				runner: {
					run: async turn => {
						const lease = await workspaceLeaseManager.acquire({
							safeKey,
							holderId: "turn-holder",
							operation: "turn",
							leaseMs: 60_000,
						});
						turnStarted();
						await turnFinished;
						await lease.release();
						return { content: turn.chatId, model: "gjc" };
					},
				},
				mappings,
				closeSession: async mapping => {
					closeCalls.push(mapping.chatId);
					return { status: "closed" };
				},
				workspaceRegistry,
				workspaceLeaseManager: reaperWorkspaceLeaseManager,
				now: () => clock.now,
				setTimeout: (handler, timeoutMs) =>
					clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
				clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
			});
			const pendingTurn = reaper.runner.run({ ...createInput("chat-1"), ownerUserId: principalId });
			await started;
			clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
			await flush();
			expect(closeCalls).toEqual([]);
			for (let attempt = 0; attempt < 100 && rejectedReaperLeaseAttempts === 0; attempt += 1) await flush();
			expect(reaperLeaseAttempts).toBeGreaterThan(0);
			expect(rejectedReaperLeaseAttempts).toBeGreaterThan(0);
			releaseTurn();
			await pendingTurn;
			await flush();
			for (let attempt = 0; attempt < 10 && !closeCalls.includes("chat-2"); attempt += 1) {
				clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
				await flush();
			}
			expect(closeCalls).toContain("chat-2");
			await reaper.stop();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
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
	test("does not report a closed session while later work is pending", async () => {
		const harness = createHarness();
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();
		expect(harness.closeCalls).toHaveLength(1);

		harness.mappings.recordActivity("pending-after-close", "pending", harness.clock.now);
		const result = await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "explicit-close-after-pending",
			ingressHash: "explicit-close-after-pending",
		});

		expect(result).toMatchObject({ status: "unavailable" });
		expect(harness.closeCalls).toHaveLength(1);
		await harness.reaper.stop();
	});
	test("does not acknowledge endpoint-only mappings as idle-closed", async () => {
		const harness = createHarness({
			close: async () => ({ status: "uncertain", message: "owned pane proof is unavailable" }),
		});
		harness.mappings.mapping = {
			...harness.mappings.mapping,
			attachment: {
				...harness.mappings.mapping.attachment!,
				tmuxSocket: undefined,
				tmuxPane: undefined,
				tmuxPanePid: undefined,
				tmuxOwnershipTag: undefined,
			},
		};
		await harness.reaper.runner.run(createInput());
		harness.clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS);
		await flush();

		expect(harness.closeCalls).toHaveLength(0);
		const result = await harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "endpoint-only-close",
			ingressHash: "endpoint-only-close",
		});
		expect(result).toMatchObject({ status: "uncertain" });
		expect(harness.closeCalls).toHaveLength(1);
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
	test("uses timestamps before journal order for a delayed legacy close after a newer turn", async () => {
		const harness = createHarness();
		harness.clock.now = 100;
		harness.mappings.publish("turn-2", 100);
		await harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" });
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

		expect(harness.closeCalls).toHaveLength(1);
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
			adminPrincipalId: "owner-1",
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
	test("does not reap a retained mapping after a manual uncertain close across restart", async () => {
		const clock = new ManualTimers();
		clock.now = Date.now();
		const mappings = new SessionMappingStore();
		const retained = createMapping("turn-1");
		const scope = { principalId: retained.principalId!, chatId: retained.chatId };
		mappings.setScoped(scope, retained);
		mappings.beginOperationScoped(scope, {
			id: "manual-close-operation",
			kind: "close",
			ingressId: "manual-close-operation",
			detail: "manual-close-hash",
		});
		mappings.transitionOperationScoped(scope, "manual-close-operation", "uncertain", "manual-close-hash");
		let closeCalls = 0;
		const createReaper = () =>
			createGjcIdleSessionReaper({
				runner: { run: async () => ({ content: "done", model: "gjc" }) },
				mappings,
				adminPrincipalId: "owner-1",
				closeSession: async () => {
					closeCalls += 1;
					return { status: "closed" };
				},
				now: () => clock.now,
				setTimeout: (handler, timeoutMs) =>
					clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
				clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
			});
		const reaper = createReaper();
		await reaper.stop();
		const restarted = createReaper();
		clock.advance(DEFAULT_IDLE_SESSION_TIMEOUT_MS * 2);
		await flush();

		expect(closeCalls).toBe(0);
		await restarted.stop();
	});
	test("matches a persisted production close result for the retained mapping generation", async () => {
		const clock = new ManualTimers();
		clock.now = Date.now();
		const mappings = new SessionMappingStore();
		const retained = createMapping("turn-1");
		const scope = { principalId: retained.principalId!, chatId: retained.chatId };
		mappings.setScoped(scope, retained);
		const closeIngressId = "manual-close-operation";
		mappings.beginOperationScoped(scope, {
			id: closeIngressId,
			kind: "close",
			ingressId: closeIngressId,
			detail: "manual-close-hash",
		});
		mappings.completeOperationWithMappingScoped(scope, closeIngressId, "manual-close-hash", retained, "close");
		const persistedClose = mappings.operationScoped(scope, closeIngressId);
		expect(persistedClose?.result?.mapping.operationId).toBe(closeIngressId);
		expect(persistedClose?.result?.correlation?.mappingOperationId).toBe(retained.operationId);
		expect(mappings.getScoped(scope)?.operationId).toBe(retained.operationId);
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			adminPrincipalId: "owner-1",
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
			adminPrincipalId: "owner-1",
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
	test("rearms a retained close when later uncertain activity shares its timestamp", async () => {
		const clock = new ManualTimers();
		clock.now = DEFAULT_IDLE_SESSION_TIMEOUT_MS;
		const mappings = new MappingFixture();
		mappings.recordClose("manual-close", "complete");
		mappings.recordActivity("turn-interrupted", "uncertain", 0);
		let closeCalls = 0;
		const reaper = createGjcIdleSessionReaper({
			runner: { run: async () => ({ content: "done", model: "gjc" }) },
			mappings,
			adminPrincipalId: "owner-1",
			closeSession: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		clock.advance(0);
		await flush();
		expect(closeCalls).toBe(1);
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
			adminPrincipalId: "owner-1",
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

	test("stop rejects new runs and external closes", async () => {
		const harness = createHarness();
		const stopping = harness.reaper.stop();
		await expect(harness.reaper.runner.run(createInput())).rejects.toThrow("stopped");
		await expect(
			harness.reaper.closeSession(harness.mappings.mapping, {
				ingressId: "manual-close",
				ingressHash: "manual-close",
			}),
		).rejects.toThrow("stopped");
		await stopping;
	});
	test("stop prevents queued work from invoking the base runner or closer", async () => {
		let releaseFirst!: () => void;
		const firstDone = new Promise<void>(resolve => {
			releaseFirst = resolve;
		});
		let runCalls = 0;
		const harness = createHarness({
			run: async () => {
				runCalls += 1;
				await firstDone;
				return { content: "done", model: "gjc" };
			},
		});
		const first = harness.reaper.runner.run(createInput());
		await flush();
		const queuedRun = Promise.resolve(harness.reaper.runner.run({ ...createInput(), userMessageId: "turn-2" }));
		void queuedRun.catch(() => {});
		const queuedClose = harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "manual-close",
			ingressHash: "manual-close",
		});
		void queuedClose.catch(() => {});
		await flush();
		const stopping = harness.reaper.stop();
		await flush();

		expect(runCalls).toBe(1);
		expect(harness.closeCalls).toHaveLength(0);
		releaseFirst();
		await first;
		await expect(queuedRun).rejects.toThrow("stopped");
		await expect(queuedClose).rejects.toThrow("stopped");
		await stopping;
	});

	test("stop waits for an active streamed run to finish before stopping the base runner", async () => {
		let releaseSource!: () => void;
		let baseStopped = false;
		const sourceDone = new Promise<void>(resolve => {
			releaseSource = resolve;
		});
		const source = (async function* () {
			yield "chunk";
			await sourceDone;
		})();
		const harness = createHarness({
			stop: () => {
				baseStopped = true;
			},
			run: async () => ({ chunks: source, model: "gjc" }),
		});
		const result = await harness.reaper.runner.run(createInput());
		if (result.chunks === undefined) throw new Error("Expected streamed runner result.");
		const iterator = (result.chunks as AsyncIterable<string>)[Symbol.asyncIterator]();
		await iterator.next();
		const stopping = harness.reaper.stop();
		await flush();
		expect(baseStopped).toBe(false);
		releaseSource();
		await iterator.next();
		await stopping;
		expect(baseStopped).toBe(true);
	});
	test("stop abandons an unconsumed finite stream before stopping the base runner", async () => {
		let sourceAbandoned = 0;
		let baseStopped = false;
		const source = (async function* () {
			yield "first";
			yield "last";
		})();
		const harness = createHarness({
			run: async () => ({
				chunks: source,
				abandon: async () => {
					sourceAbandoned += 1;
				},
				model: "gjc",
			}),
			stop: () => {
				baseStopped = true;
			},
		});
		const result = await harness.reaper.runner.run(createInput());
		if (result.chunks === undefined) throw new Error("Expected streamed runner result.");

		await harness.reaper.stop();

		expect(sourceAbandoned).toBe(1);
		expect(baseStopped).toBe(true);
	});

	test("stop waits for an active external close before stopping the base runner", async () => {
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
		const pendingClose = harness.reaper.closeSession(harness.mappings.mapping, {
			ingressId: "manual-close",
			ingressHash: "manual-close",
		});
		await flush();
		expect(harness.closeCalls).toHaveLength(1);
		const stopping = harness.reaper.stop();
		await flush();
		expect(baseStopped).toBe(false);
		releaseClose();
		await pendingClose;
		await stopping;
		expect(baseStopped).toBe(true);
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
			adminPrincipalId: "owner-1",
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
	test("shares the pending shutdown with concurrent stop callers", async () => {
		let releaseStop!: () => void;
		const stopPending = new Promise<void>(resolve => {
			releaseStop = resolve;
		});
		let baseStops = 0;
		const harness = createHarness({
			stop: async () => {
				baseStops += 1;
				await stopPending;
			},
		});

		const first = harness.reaper.stop();
		await flush();
		const second = harness.reaper.stop();

		expect(second).toBe(first);
		expect(baseStops).toBe(1);
		releaseStop();
		await Promise.all([first, second]);
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
			adminPrincipalId: "owner-1",
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
		const secondResult = await second;
		if (secondResult.chunks !== undefined) await secondResult.abandon?.();
		expect(calls).toBe(2);
		await reaper.stop();
	});
	test("starts source abandonment and stream draining together", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		let first = true;
		let sourceAbandoned = false;
		let resolveDrainStarted!: () => void;
		const drainStarted = new Promise<void>(resolve => {
			resolveDrainStarted = resolve;
		});
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						if (first) {
							first = false;
							return { value: "first", done: false };
						}
						resolveDrainStarted();
						return { value: undefined, done: true };
					},
				};
			},
		};
		const reaper = createGjcIdleSessionReaper({
			runner: {
				run: async () => ({
					chunks: source,
					abandon: async () => {
						await drainStarted;
						sourceAbandoned = true;
					},
					model: "gjc",
				}),
			},
			mappings,
			adminPrincipalId: "owner-1",
			closeSession: async () => ({ status: "closed" }),
			now: () => clock.now,
			setTimeout: (handler, timeoutMs) =>
				clock.setTimeout(handler, timeoutMs) as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: timer => clock.clearTimeout(timer as unknown as number),
		});
		const result = await reaper.runner.run(createInput());
		if (result.chunks === undefined || result.abandon === undefined)
			throw new Error("Expected streamed runner result.");
		const iterator = (result.chunks as AsyncIterable<string>)[Symbol.asyncIterator]();
		await iterator.next();

		await result.abandon();

		expect(sourceAbandoned).toBe(true);
		await reaper.stop();
	});
	test("wraps primitive string chunk iterables", async () => {
		const harness = createHarness({
			run: async () => ({ chunks: "ok", model: "gjc" }),
		});
		const result = await harness.reaper.runner.run(createInput());
		if (result.chunks === undefined) throw new Error("Expected streamed runner result.");

		const chunks: string[] = [];
		for await (const chunk of result.chunks) chunks.push(chunk);

		expect(chunks).toEqual(["o", "k"]);
		await harness.reaper.stop();
	});
	test("wraps callable async chunk iterables", async () => {
		const chunks = Object.assign(() => undefined, {
			async *[Symbol.asyncIterator]() {
				yield "ok";
			},
		});
		const harness = createHarness({
			run: async () => ({ chunks, model: "gjc" }),
		});
		const result = await harness.reaper.runner.run(createInput());
		if (result.chunks === undefined) throw new Error("Expected streamed runner result.");

		const received: string[] = [];
		for await (const chunk of result.chunks) received.push(chunk);

		expect(received).toEqual(["ok"]);
		await harness.reaper.stop();
	});
	test("releases the chat gate when a handed-off stream is never read", async () => {
		const clock = new ManualTimers();
		const mappings = new MappingFixture();
		let calls = 0;
		let sourceAbandoned = 0;
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
					return {
						chunks: source,
						abandon: async () => {
							sourceAbandoned += 1;
						},
						model: "gjc",
					};
				},
			},
			mappings,
			adminPrincipalId: "owner-1",
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
		expect(sourceAbandoned).toBe(1);
		releaseSource();
		await abandoned;
		const secondResult = await second;
		if (secondResult.chunks !== undefined) await secondResult.abandon?.();
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
test("a linked-project projection failure does not stop the constructed reaper", async () => {
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
		const options = await buildAdapterServerOptions(
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
		);
		expect(options.checks).toContainEqual(
			expect.objectContaining({ name: "openwebui-project-projection", status: "degraded" }),
		);
		expect(stopCalls).toBe(0);
		await options.routes?.runner.stop?.();
		await options.runtimeLock.release();
		expect(stopCalls).toBe(1);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
test("a linked-project projection failure does not stop the base routing runner", async () => {
	const root = await mkdtemp(join(tmpdir(), "gjc-idle-reaper-no-close-init-"));
	const failure = new Error("projection startup failure");
	let stopCalls = 0;
	const turnRunner = new FakeGjcTurnRunner() as GjcSessionTurnRunner;
	Object.defineProperty(turnRunner, "withLifecycleClosePreflight", { value: undefined });
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
		const options = await buildAdapterServerOptions(
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
		);
		expect(options.checks).toContainEqual(
			expect.objectContaining({ name: "openwebui-project-projection", status: "degraded" }),
		);
		expect(stopCalls).toBe(0);
		await options.routes?.runner.stop?.();
		await options.runtimeLock.release();
		expect(stopCalls).toBe(1);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
