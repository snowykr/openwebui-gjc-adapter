import { describe, expect, test } from "bun:test";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import {
	type CreateManagedIdleReaperInput,
	createManagedIdleReaper,
	DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
	type ManagedIdleCloseIntent,
	type ManagedIdleGenerationRecord,
	type ManagedIdleGenerationStore,
} from "../src/live/gjc-managed-idle-reaper";

const authority = (principalId = "tenant-a", generation = 4): ManagedTurnAuthority => ({
	principalId,
	projectId: "project-a",
	canonicalWorkspace: `/work/${principalId}`,
	chatId: "chat-a",
	sessionId: "session-a",
	generation,
	leaseId: "lease-a",
	epoch: "epoch-a",
	requestKey: "normal-turn-key",
});

class Store implements ManagedIdleGenerationStore {
	records: ManagedIdleGenerationRecord[];
	prepared: ManagedIdleCloseIntent[] = [];
	retired: string[] = [];
	evicted: string[] = [];
	published: string[] = [];
	restored: string[] = [];
	uncertain: string[] = [];
	prepare = true;

	constructor(records: ManagedIdleGenerationRecord[]) {
		this.records = records;
	}
	async active() {
		return this.records;
	}
	async prepareClose(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.prepared.push(intent);
		return this.prepare;
	}
	async restoreActive(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.restored.push(intent.key);
	}
	async retire(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.retired.push(intent.key);
	}
	async markUncertain(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent, reason: string) {
		this.uncertain.push(`${intent.key}:${reason}`);
	}
	async evict(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.evicted.push(intent.key);
	}
	async publishRetired(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.published.push(intent.key);
	}
}

function harness(
	records: ManagedIdleGenerationRecord[],
	status = "retired",
	outcome: { ok: boolean; certainty?: string; result?: { sessionId: string } } = {
		ok: true,
		result: { sessionId: "session-a" },
	},
	overrides: Partial<CreateManagedIdleReaperInput> = {},
) {
	const store = new Store(records);
	const closeKeys: string[] = [];
	let reconciles = 0;
	let leases = 0;
	let admissions = 0;
	const reaper = createManagedIdleReaper({
		records: store,
		idleTimeoutMs: 10,
		now: () => 100,
		admission: {
			async acquire() {
				admissions += 1;
				return () => undefined;
			},
		},
		leases: {
			async acquire() {
				leases += 1;
				return { assertFence: async () => undefined, release: async () => undefined };
			},
		},
		runtime: {
			async closeLifecycleSession(request) {
				closeKeys.push(request.requestKey);
				return outcome;
			},
			async reconcile() {
				reconciles += 1;
			},
			async generationStatus() {
				return { status };
			},
		},
		...overrides,
	});
	return { reaper, store, closeKeys, counts: () => ({ reconciles, leases, admissions }) };
}

const active = (owner = "tenant-a", lastActivityAt = 0): ManagedIdleGenerationRecord => ({
	authority: authority(owner),
	lastActivityAt,
	state: "active",
});

describe("managed idle reaper", () => {
	test("polls at the configured interval but waits the full idle threshold and clears once on stop", async () => {
		let now = DEFAULT_MANAGED_IDLE_TIMEOUT_MS - 1;
		let poll!: () => void;
		const cleared: unknown[] = [];
		const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
		const subject = harness([active()], "retired", undefined, {
			idleTimeoutMs: DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
			now: () => now,
			pollIntervalMs: 25,
			setInterval(handler, delay) {
				expect(delay).toBe(25);
				poll = handler;
				return timer;
			},
			clearInterval(value) {
				cleared.push(value);
			},
		});
		poll();
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toEqual([]);
		now += 1;
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toHaveLength(1);
		await Promise.all([subject.reaper.stop(), subject.reaper.stop()]);
		poll();
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toHaveLength(1);
		expect(cleared).toEqual([timer]);
	});
	test("rejects invalid timer configuration without installing a poller", () => {
		let installed = 0;
		for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			for (const field of ["idleTimeoutMs", "pollIntervalMs"] as const)
				expect(() =>
					harness([], "retired", undefined, {
						[field]: value,
						setInterval() {
							installed += 1;
							throw new Error("unexpected poll");
						},
					}),
				).toThrow("positive safe integer");
		}
		expect(installed).toBe(0);
	});
	test("requires matching successful close acknowledgement as well as positive retirement", async () => {
		for (const outcome of [
			{ ok: false, certainty: "retryable" },
			{ ok: true },
			{ ok: true, result: { sessionId: "replacement" } },
		]) {
			const subject = harness([active()], "retired", outcome);
			await subject.reaper.runOnce();
			expect(subject.store.uncertain).toHaveLength(1);
			expect(subject.store.retired).toEqual([]);
			expect(subject.store.evicted).toEqual([]);
			await subject.reaper.stop();
		}
	});
	test("does not close a pending turn or stream, closing record, or uncertain generation", async () => {
		const subject = harness(
			["inflight", "closing", "uncertain"].map(state => ({ ...active(), state }) as ManagedIdleGenerationRecord),
		);
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toEqual([]);
		expect(subject.counts()).toEqual({ admissions: 0, leases: 0, reconciles: 0 });
		await subject.reaper.stop();
	});
	test("rechecks stale generation evidence after admission and releases both guards", async () => {
		let releasedAdmission = 0;
		let releasedLease = 0;
		const subject = harness([active()], "retired", undefined, {
			admission: {
				acquire: async () => () => {
					releasedAdmission += 1;
				},
			},
			leases: {
				acquire: async () => ({
					assertFence: async () => undefined,
					release: async () => {
						releasedLease += 1;
					},
				}),
			},
		});
		subject.store.prepare = false;
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toEqual([]);
		expect([releasedAdmission, releasedLease]).toEqual([1, 1]);
		await subject.reaper.stop();
	});
	test("stop fences a queued admission before lease acquisition or mutation", async () => {
		let release!: (release: () => void) => void;
		const admission = new Promise<() => void>(resolve => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>(resolve => {
			entered = resolve;
		});
		let released = 0;
		const subject = harness([active()], "retired", undefined, {
			admission: {
				acquire: async () => {
					entered();
					return admission;
				},
			},
		});
		const scan = subject.reaper.runOnce();
		await ready;
		let stopped = false;
		const stopping = subject.reaper.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		release(() => {
			released += 1;
		});
		await Promise.all([scan, stopping]);
		expect(subject.closeKeys).toEqual([]);
		expect(subject.counts().leases).toBe(0);
		expect(released).toBe(1);
	});
	test("fence loss after prepare retains uncertainty and never dispatches close", async () => {
		let checks = 0;
		const subject = harness([active()], "retired", undefined, {
			leases: {
				acquire: async () => ({
					assertFence: async () => {
						if (++checks === 2) throw new Error("lease lost");
					},
					release: async () => undefined,
				}),
			},
		});
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toEqual([]);
		expect(subject.store.uncertain[0]).toContain("lease lost");
		expect(subject.store.evicted).toEqual([]);
		await subject.reaper.stop();
	});
	test("retires only eligible exact active generations before eviction and publication", async () => {
		const subject = harness([active(), active("tenant-b", 95), { ...active("tenant-c"), state: "uncertain" }]);
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toEqual([
			"managed-idle-close:tenant-a\u0000project-a\u0000/work/tenant-a\u0000chat-a\u0000session-a\u00004\u0000lease-a\u0000epoch-a",
		]);
		expect(subject.store.retired).toEqual(subject.closeKeys);
		expect(subject.store.evicted).toEqual(subject.closeKeys);
		expect(subject.store.published).toEqual(subject.closeKeys);
		expect(subject.counts()).toEqual({ admissions: 1, leases: 1, reconciles: 1 });
	});

	test("restores current only after an explicit retryable not-applied close", async () => {
		const subject = harness([active()], "current", { ok: false, certainty: "retryable" });
		await subject.reaper.runOnce();
		expect(subject.store.restored).toEqual(subject.closeKeys);
		expect(subject.store.uncertain).toEqual([]);
		expect(subject.store.evicted).toEqual([]);
	});

	test("retains replaced, unknown, and lifecycle errors as uncertain", async () => {
		for (const status of ["replaced", "unknown"]) {
			const subject = harness([active()], status);
			await subject.reaper.runOnce();
			expect(subject.store.uncertain).toHaveLength(1);
			expect(subject.store.evicted).toEqual([]);
		}
	});

	test("does not double-close concurrent scans and drains without stopping the process runtime", async () => {
		let resolveClose!: () => void;
		const pendingClose = new Promise<void>(resolve => (resolveClose = resolve));
		let signalCloseStarted!: () => void;
		const closeStarted = new Promise<void>(resolve => (signalCloseStarted = resolve));
		const store = new Store([active()]);
		let closes = 0;
		const reaper = createManagedIdleReaper({
			records: store,
			idleTimeoutMs: 1,
			now: () => 10,
			admission: { acquire: async () => () => undefined },
			leases: { acquire: async () => ({ assertFence: async () => undefined, release: async () => undefined }) },
			runtime: {
				closeLifecycleSession: async () => {
					closes += 1;
					signalCloseStarted();
					await pendingClose;
					return { ok: true, result: { sessionId: "session-a" } };
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired" }),
			},
		});
		const first = reaper.runOnce();
		await closeStarted;
		await reaper.runOnce();
		expect(closes).toBe(1);
		const stopped = reaper.stop();
		resolveClose();
		await Promise.all([first, stopped]);
		expect(store.evicted).toHaveLength(1);
	});

	test("uses tenant-scoped admission and lease keys without any user-file operations", async () => {
		const subject = harness([active("tenant-a"), active("tenant-b")]);
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toHaveLength(2);
		expect(subject.closeKeys[0]).not.toBe(subject.closeKeys[1]);
		expect(subject.store.prepared).toHaveLength(2);
	});

	test("skips a generation while its tenant lease is active and retains lifecycle failures as uncertain", async () => {
		const blockedStore = new Store([active()]);
		const blocked = createManagedIdleReaper({
			records: blockedStore,
			idleTimeoutMs: 1,
			now: () => 10,
			admission: { acquire: async () => () => undefined },
			leases: { acquire: async () => undefined },
			runtime: {
				closeLifecycleSession: async () => ({ ok: true, result: { sessionId: "session-a" } }),
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired" }),
			},
		});
		await blocked.runOnce();
		expect(blockedStore.prepared).toEqual([]);

		const failingStore = new Store([active()]);
		const failing = createManagedIdleReaper({
			records: failingStore,
			idleTimeoutMs: 1,
			now: () => 10,
			admission: { acquire: async () => () => undefined },
			leases: { acquire: async () => ({ assertFence: async () => undefined, release: async () => undefined }) },
			runtime: {
				closeLifecycleSession: async () => {
					throw new Error("transport failed");
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired" }),
			},
		});
		await failing.runOnce();
		expect(failingStore.uncertain).toHaveLength(1);
		expect(failingStore.evicted).toEqual([]);
	});
});
