import { describe, expect, test } from "bun:test";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import {
	createManagedIdleReaper,
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
	outcome: { ok: boolean; certainty?: string } = { ok: true },
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
	});
	return { reaper, store, closeKeys, counts: () => ({ reconciles, leases, admissions }) };
}

const active = (owner = "tenant-a", lastActivityAt = 0): ManagedIdleGenerationRecord => ({
	authority: authority(owner),
	lastActivityAt,
	state: "active",
});

describe("managed idle reaper", () => {
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
					return { ok: true };
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
				closeLifecycleSession: async () => ({ ok: true }),
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
