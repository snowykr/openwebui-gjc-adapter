import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { createManagedLifecycleEvidence, lifecyclePreparedAuthority } from "../src/gjc/managed-lifecycle-evidence";
import { ManagedOperationDeadline } from "../src/gjc/managed-operation-deadline";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import {
	type CreateManagedIdleReaperInput,
	createManagedIdleReaper,
	DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
	type ManagedIdleCloseIntent,
	type ManagedIdleGenerationRecord,
	type ManagedIdleGenerationStore,
	type ManagedIdlePreparedClose,
} from "../src/live/gjc-managed-idle-reaper";
import { FakeManagedSdkRuntime } from "./cli-fixtures";

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

// Synthetic public Router evidence for the isolated runtime boundary, not a production close producer.
const retirementEvidence = {
	source: "session_index",
	observedIndexSeq: 3,
	evidenceIndexSeq: 3,
	event: "session_closed",
} as const;

class Store implements ManagedIdleGenerationStore {
	records: ManagedIdleGenerationRecord[];
	prepared: ManagedIdleCloseIntent[] = [];
	retired: string[] = [];
	evicted: string[] = [];
	published: string[] = [];
	acknowledged: Array<{ key: string; sessionId: string }> = [];
	retirementEvidence: Readonly<Record<string, unknown>>[] = [];
	uncertain: string[] = [];
	prepare = true;

	constructor(records: ManagedIdleGenerationRecord[]) {
		this.records = records;
	}
	async active() {
		return this.records;
	}
	async prepareClose(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
	): Promise<false | ManagedIdlePreparedClose> {
		this.prepared.push(intent);
		if (!this.prepare) return false;
		const target = {
			sessionId: record.authority.sessionId,
			endpointGeneration: record.authority.generation,
			endpointIncarnation: "a".repeat(64),
		};
		const operation = { operationId: intent.key, requestKey: intent.key, payloadHash: "b".repeat(64) };
		return {
			...intent,
			target,
			operation,
			original: {
				id: intent.key,
				ingressId: intent.key,
				kind: "close",
				state: "pending",
				startedAt: new Date(intent.requestedAt).toISOString(),
				detail: operation.payloadHash,
				lifecycle: {
					...createManagedLifecycleEvidence({
						operation: "session.close",
						preparedAuthority: { ...lifecyclePreparedAuthority(record.authority), requestKey: intent.key },
						source: record.authority,
						target,
						payloadHash: operation.payloadHash,
					}),
					state: "closing",
					sourceProofRef: { operationId: "source", evidenceHash: "c".repeat(64) },
				},
			},
		};
	}
	async pendingRetirement(record: ManagedIdleGenerationRecord) {
		return this.prepared.find(intent => intent.authority === record.authority && this.retired.includes(intent.key));
	}
	async acknowledge(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent, sessionId: string) {
		this.acknowledged.push({ key: intent.key, sessionId });
	}
	async retire(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		evidence: Readonly<Record<string, unknown>>,
	) {
		this.retired.push(intent.key);
		this.retirementEvidence.push(evidence);
		this.records = this.records.map(candidate =>
			candidate === record ? { ...record, state: "closing" } : candidate,
		);
	}
	async markUncertain(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent, reason: string) {
		this.uncertain.push(`${intent.key}:${reason}`);
		this.records = this.records.map(candidate =>
			candidate === record ? { ...record, state: "uncertain" } : candidate,
		);
	}
	async evict(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.evicted.push(intent.key);
		this.records = this.records.filter(candidate => candidate.authority !== record.authority);
	}
	async publishRetired(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent) {
		this.published.push(intent.key);
	}
}

function harness(
	records: ManagedIdleGenerationRecord[],
	status = "retired",
	outcome: { ok: boolean; operation?: string; certainty?: string; result?: { sessionId: string } } = {
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
			createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
			async closeLifecycleSession(request, operation, onOutcome) {
				closeKeys.push(request.requestKey);
				expect(operation.requestKey).toBe(request.requestKey);
				expect(request.target.endpointIncarnation).toBe("a".repeat(64));
				const result = { operation: "session.close", ...outcome };
				await onOutcome(result);
				return result;
			},
			async reconcile() {
				reconciles += 1;
			},
			async generationStatus() {
				return { status, ...(status === "retired" ? { evidence: retirementEvidence } : {}) };
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
	test.each(["close", "reconcile", "status"] as const)(
		"retains admission and lease through actual late %s settlement without late retirement",
		async phase => {
			const gate = deferred<void>();
			const entered = deferred<void>();
			const uncertain = deferred<void>();
			let releases = 0;
			let closes = 0;
			let statuses = 0;
			const subject = harness([active()], "retired", undefined, {
				closeTimeoutMs: 60,
				admission: {
					acquire: async () => () => {
						releases += 1;
					},
				},
				leases: {
					acquire: async () => ({
						assertFence: async () => undefined,
						release: async () => {
							releases += 1;
						},
					}),
				},
				runtime: {
					createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
					closeLifecycleSession: async (request, _operation, onOutcome) => {
						closes += 1;
						if (phase === "close") {
							entered.resolve();
							await gate.promise;
						}
						const outcome = {
							ok: true,
							operation: "session.close",
							result: { sessionId: request.target.sessionId },
						};
						await onOutcome(outcome);
						return outcome;
					},
					reconcile: async () => {
						if (phase === "reconcile") {
							entered.resolve();
							await gate.promise;
						}
					},
					generationStatus: async () => {
						statuses += 1;
						if (phase === "status") {
							entered.resolve();
							await gate.promise;
						}
						return { status: "retired", evidence: retirementEvidence };
					},
				},
			});
			const mark = subject.store.markUncertain.bind(subject.store);
			subject.store.markUncertain = async (...args) => {
				await mark(...args);
				uncertain.resolve();
			};
			let settled = false;
			const scan = subject.reaper.runOnce().finally(() => {
				settled = true;
			});
			void scan.catch(() => undefined);
			try {
				await entered.promise;
				await uncertain.promise;
				expect(settled).toBe(false);
				expect(releases).toBe(0);
				expect(subject.store.acknowledged).toHaveLength(phase === "close" ? 0 : 1);
				await subject.reaper.runOnce();
				expect(closes).toBe(1);
				let stopped = false;
				const stop = subject.reaper.stop().finally(() => {
					stopped = true;
				});
				void stop.catch(() => undefined);
				await Promise.resolve();
				expect(stopped).toBe(false);
				gate.resolve();
				await expect(scan).rejects.toMatchObject({ code: "timeout" });
				await expect(stop).rejects.toMatchObject({ code: "timeout" });
				expect(subject.store.acknowledged).toHaveLength(1);
				expect(subject.store.records[0]?.state).toBe("uncertain");
				expect(subject.store.retired).toEqual([]);
				expect(subject.store.evicted).toEqual([]);
				expect(subject.store.published).toEqual([]);
				expect(statuses).toBe(phase === "status" ? 1 : 0);
				expect(releases).toBe(2);
			} finally {
				gate.resolve();
				await scan.catch(() => undefined);
			}
		},
	);

	test.each(["active", "fence", "publication"] as const)(
		"bounds hanging %s within the single retirement budget and drains stop",
		async phase => {
			const never = new Promise<never>(() => {});
			const entered = deferred<void>();
			const stall = () => {
				entered.resolve();
				return never;
			};
			let closes = 0;
			let statuses = 0;
			let released = 0;
			const store = new Store([active()]);
			if (phase === "active") store.active = stall;
			if (phase === "publication") store.publishRetired = stall;
			const subject = harness([], "retired", undefined, {
				records: store,
				closeTimeoutMs: 60,
				admission: {
					acquire: async () => () => {
						released += 1;
					},
				},
				leases: {
					acquire: async () => ({
						assertFence: async () => {
							if (phase === "fence") await stall();
						},
						release: async () => {
							released += 1;
						},
					}),
				},
				runtime: {
					createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
					closeLifecycleSession: async (request, _operation, onOutcome) => {
						closes += 1;
						expect(request.timeoutMs).toBeGreaterThan(0);
						expect(request.timeoutMs).toBeLessThanOrEqual(60);
						const outcome = {
							ok: true,
							operation: "session.close",
							result: { sessionId: request.target.sessionId },
						};
						await onOutcome(outcome);
						return outcome;
					},
					reconcile: async () => {},
					generationStatus: async () => {
						statuses += 1;
						return { status: "retired", evidence: retirementEvidence };
					},
				},
			});
			const scan = subject.reaper.runOnce();
			void scan.catch(() => undefined);
			await entered.promise;
			const stop = subject.reaper.stop();
			void stop.catch(() => undefined);
			await expect(scan).rejects.toMatchObject({ code: "timeout" });
			await expect(stop).rejects.toMatchObject({ code: "timeout" });
			expect(store.evicted).toEqual([]);
			if (["active", "admission", "lease", "fence"].includes(phase)) expect(closes).toBe(0);
			if (["close", "reconcile"].includes(phase)) expect(statuses).toBe(0);
			if (["reconcile", "status", "publication"].includes(phase)) expect(store.acknowledged).toHaveLength(1);
			if (phase === "publication") {
				expect(store.retired).toHaveLength(1);
				expect(store.uncertain).toEqual([]);
			}
			if (["fence", "close", "reconcile", "status", "publication"].includes(phase)) expect(released).toBe(2);
		},
	);

	test.each([
		["admission", false],
		["lease", false],
		["admission", true],
		["lease", true],
	] as const)("owns late %s acquisition and cleanup through stop (release failure: %s)", async (phase, fails) => {
		const gate = deferred<void>();
		const entered = deferred<void>();
		const releaseEntered = deferred<void>();
		const releaseGate = deferred<void>();
		const expired = deferred<unknown>();
		const failure = new Error("late release failed");
		const fail = ManagedOperationDeadline.prototype.fail;
		const deadlineFailure = spyOn(ManagedOperationDeadline.prototype, "fail").mockImplementation(function (
			this: ManagedOperationDeadline,
			error,
		) {
			fail.call(this, error);
			if (error instanceof Error && "code" in error && error.code === "timeout") expired.resolve(error);
		});
		let closes = 0;
		let admissions = 0;
		let leases = 0;
		let admissionReleases = 0;
		let leaseReleases = 0;
		const subject = harness([active()], "retired", undefined, {
			closeTimeoutMs: 30,
			admission: {
				acquire: async () => {
					admissions += 1;
					if (phase === "admission") {
						entered.resolve();
						await gate.promise;
					}
					return () => {
						admissionReleases += 1;
						if (phase === "admission" && fails) throw failure;
					};
				},
			},
			leases: {
				acquire: async () => {
					leases += 1;
					entered.resolve();
					await gate.promise;
					return {
						assertFence: async () => {
							throw new Error("late fence");
						},
						release: async () => {
							leaseReleases += 1;
							releaseEntered.resolve();
							await releaseGate.promise;
							if (fails) throw failure;
						},
					};
				},
			},
			runtime: {
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async () => {
					closes += 1;
					throw new Error("late close");
				},
				reconcile: async () => {},
				generationStatus: async () => ({ status: "unknown" }),
			},
		});
		let settled = false;
		const scan = subject.reaper.runOnce().finally(() => {
			settled = true;
		});
		void scan.catch(() => undefined);
		let stopping: Promise<void> | undefined;
		try {
			await entered.promise;
			const timeout = await expired.promise;
			expect(settled).toBe(false);
			expect(admissionReleases).toBe(0);
			await subject.reaper.runOnce();
			expect(admissions).toBe(1);
			expect(leases).toBe(phase === "lease" ? 1 : 0);
			let stopped = false;
			stopping = subject.reaper.stop().finally(() => {
				stopped = true;
			});
			void stopping.catch(() => undefined);
			await Promise.resolve();
			expect(stopped).toBe(false);
			gate.resolve();
			if (phase === "lease") {
				await releaseEntered.promise;
				expect(settled).toBe(false);
				expect(stopped).toBe(false);
				expect(admissionReleases).toBe(0);
				releaseGate.resolve();
			}
			if (fails) {
				const error = await scan.catch(error => error);
				expect(error).toBeInstanceOf(AggregateError);
				expect(error.errors).toEqual([timeout, failure]);
				await expect(stopping).rejects.toBe(error);
				await expect(subject.reaper.stop()).rejects.toBe(error);
			} else {
				await expect(scan).rejects.toBe(timeout);
				await expect(stopping).rejects.toBe(timeout);
			}
			expect(admissionReleases).toBe(phase === "lease" && fails ? 0 : 1);
			expect(leaseReleases).toBe(phase === "lease" ? 1 : 0);
			expect(closes).toBe(0);
			expect(subject.store.prepared).toEqual([]);
		} finally {
			gate.resolve();
			releaseGate.resolve();
			await scan.catch(() => undefined);
			await stopping?.catch(() => undefined);
			deadlineFailure.mockRestore();
		}
	});

	test.each([false, true])("owns late close preparation and uncertainty persistence with failure=%s", async fails => {
		const entered = deferred<void>();
		const gate = deferred<void>();
		const expired = deferred<unknown>();
		const failure = new Error("late preparation persistence failed");
		const fail = ManagedOperationDeadline.prototype.fail;
		const timeoutSpy = spyOn(ManagedOperationDeadline.prototype, "fail").mockImplementation(function (
			this: ManagedOperationDeadline,
			error,
		) {
			fail.call(this, error);
			if (error instanceof Error && "code" in error && error.code === "timeout") expired.resolve(error);
		});
		let released = 0;
		const subject = harness([active()], "retired", undefined, {
			closeTimeoutMs: 30,
			leases: {
				acquire: async () => ({
					assertFence: async () => undefined,
					release: async () => {
						released += 1;
					},
				}),
			},
		});
		const prepare = subject.store.prepareClose.bind(subject.store);
		subject.store.prepareClose = async (record, request) => {
			entered.resolve();
			await gate.promise;
			return prepare(record, request);
		};
		if (fails)
			subject.store.markUncertain = async () => {
				throw failure;
			};
		let done = false;
		const scan = subject.reaper.runOnce().finally(() => {
			done = true;
		});
		void scan.catch(() => undefined);
		let stopping: Promise<void> | undefined;
		try {
			await entered.promise;
			const timeout = await expired.promise;
			expect(done).toBe(false);
			expect(released).toBe(0);
			stopping = subject.reaper.stop();
			void stopping.catch(() => undefined);
			gate.resolve();
			const error = await scan.catch(error => error);
			await expect(stopping).rejects.toBe(error);
			if (fails) {
				expect(error).toBeInstanceOf(AggregateError);
				expect(error.errors).toEqual([timeout, failure]);
				expect(released).toBe(0);
			} else {
				expect(error).toBe(timeout);
				expect(subject.store.uncertain).toHaveLength(1);
				expect(subject.store.records[0]?.state).toBe("uncertain");
				expect(released).toBe(1);
			}
			expect(subject.closeKeys).toEqual([]);
			expect(subject.store.retired).toEqual([]);
		} finally {
			gate.resolve();
			await scan.catch(() => undefined);
			await stopping?.catch(() => undefined);
			timeoutSpy.mockRestore();
		}
	});

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
			{ ok: true, operation: "session.delete", result: { sessionId: "session-a" } },
			{ ok: true, result: { sessionId: "replacement" } },
		]) {
			const subject = harness([active()], "retired", outcome);
			await expect(subject.reaper.runOnce()).rejects.toThrow("matching success and exact retirement");
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
		await expect(subject.reaper.runOnce()).rejects.toThrow("lease lost");
		expect(subject.closeKeys).toEqual([]);
		expect(subject.store.uncertain[0]).toContain("lease lost");
		expect(subject.store.evicted).toEqual([]);
		await subject.reaper.stop();
	});
	test("retires only eligible exact active generations before eviction and publication", async () => {
		const subject = harness([active(), active("tenant-b", 95), { ...active("tenant-c"), state: "uncertain" }]);
		await subject.reaper.runOnce();
		const identity =
			"tenant-a\u0000project-a\u0000/work/tenant-a\u0000chat-a\u0000session-a\u00004\u0000lease-a\u0000epoch-a";
		expect(subject.closeKeys).toEqual([`managed-idle-close:${createHash("sha256").update(identity).digest("hex")}`]);
		expect(subject.closeKeys[0]).toMatch(/^managed-idle-close:[a-f0-9]{64}$/);
		expect(subject.closeKeys[0]).not.toContain("\u0000");
		expect(subject.store.retired).toEqual(subject.closeKeys);
		expect(subject.store.acknowledged).toEqual([{ key: subject.closeKeys[0], sessionId: "session-a" }]);
		expect(subject.store.retirementEvidence).toEqual([retirementEvidence]);
		expect(subject.store.evicted).toEqual(subject.closeKeys);
		expect(subject.store.published).toEqual(subject.closeKeys);
		expect(subject.counts()).toEqual({ admissions: 1, leases: 1, reconciles: 1 });
	});

	test("retains retryable rejection as uncertain rather than treating its label as not-applied proof", async () => {
		const subject = harness([active()], "current", { ok: false, certainty: "retryable" });
		await expect(subject.reaper.runOnce()).rejects.toThrow("matching success and exact retirement");
		expect(subject.store.uncertain).toHaveLength(1);
		expect(subject.store.acknowledged).toEqual([]);
		expect(subject.counts().reconciles).toBe(0);
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toHaveLength(1);
		expect(subject.store.evicted).toEqual([]);
		await subject.reaper.stop();
	});

	test("retired status without public evidence retains the acknowledgement but cannot retire", async () => {
		const subject = harness([active()], "retired", undefined, {
			runtime: {
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async (request, _operation, onOutcome) => {
					const outcome = {
						ok: true,
						operation: "session.close",
						result: { sessionId: request.target.sessionId },
					};
					await onOutcome(outcome);
					return outcome;
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired" }),
			},
		});
		await expect(subject.reaper.runOnce()).rejects.toThrow("matching success and exact retirement");
		expect(subject.store.acknowledged).toEqual([{ key: subject.store.prepared[0]!.key, sessionId: "session-a" }]);
		expect(subject.store.uncertain).toHaveLength(1);
		expect(subject.store.retired).toEqual([]);
		expect(subject.store.evicted).toEqual([]);
		await subject.reaper.stop();
	});

	test.each(["reconcile", "generationStatus"] as const)(
		"acknowledges before %s and retains that receipt when observation fails",
		async phase => {
			const order: string[] = [];
			const failure = new Error(`${phase} failed`);
			const subject = harness([active()], "retired", undefined, {
				runtime: {
					createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
					closeLifecycleSession: async (request, _operation, onOutcome) => {
						order.push("close");
						const outcome = {
							ok: true,
							operation: "session.close",
							result: { sessionId: request.target.sessionId },
						};
						await onOutcome(outcome);
						return outcome;
					},
					reconcile: async () => {
						order.push("reconcile");
						if (phase === "reconcile") throw failure;
					},
					generationStatus: async () => {
						order.push("generationStatus");
						throw failure;
					},
				},
			});
			const acknowledge = subject.store.acknowledge.bind(subject.store);
			subject.store.acknowledge = async (record, intent, sessionId) => {
				await acknowledge(record, intent, sessionId);
				order.push("acknowledge");
			};
			await expect(subject.reaper.runOnce()).rejects.toBe(failure);
			expect(order).toEqual(
				phase === "reconcile"
					? ["close", "acknowledge", "reconcile"]
					: ["close", "acknowledge", "reconcile", "generationStatus"],
			);
			expect(subject.store.acknowledged).toHaveLength(1);
			expect(subject.store.uncertain).toHaveLength(1);
			expect(subject.store.retired).toEqual([]);
			await subject.reaper.runOnce();
			expect(order.filter(event => event === "close")).toHaveLength(1);
			await subject.reaper.stop();
		},
	);

	test("acknowledgement persistence failure prevents reconciliation and retirement", async () => {
		const failure = new Error("acknowledgement persistence failed");
		const subject = harness([active()]);
		subject.store.acknowledge = async () => {
			throw failure;
		};
		await expect(subject.reaper.runOnce()).rejects.toBe(failure);
		expect(subject.counts().reconciles).toBe(0);
		expect(subject.store.uncertain).toHaveLength(1);
		expect(subject.store.retired).toEqual([]);
		expect(subject.store.evicted).toEqual([]);
		await expect(subject.reaper.stop()).rejects.toBe(failure);
	});

	test("retains replaced, unknown, and lifecycle errors as uncertain", async () => {
		for (const status of ["replaced", "unknown"]) {
			const subject = harness([active()], status);
			await expect(subject.reaper.runOnce()).rejects.toThrow(`generation status is ${status}`);
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
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async (_request, _operation, onOutcome) => {
					closes += 1;
					signalCloseStarted();
					await pendingClose;
					const outcome = { ok: true, operation: "session.close", result: { sessionId: "session-a" } };
					await onOutcome(outcome);
					return outcome;
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired", evidence: retirementEvidence }),
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
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async () => {
					throw new Error("Blocked lease must not dispatch close");
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired", evidence: retirementEvidence }),
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
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async () => {
					throw new Error("transport failed");
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired", evidence: retirementEvidence }),
			},
		});
		await expect(failing.runOnce()).rejects.toThrow("transport failed");
		expect(failingStore.uncertain).toHaveLength(1);
		expect(failingStore.evicted).toEqual([]);
	});

	test.each(["evict", "publishRetired"] as const)(
		"retries failed %s without re-closing or weakening retirement",
		async phase => {
			const subject = harness([active()]);
			const failure = new Error(`${phase} failed`);
			const original = subject.store[phase].bind(subject.store);
			let fail = true;
			subject.store[phase] = async (record, intent) => {
				if (fail) throw failure;
				await original(record, intent);
			};
			await expect(subject.reaper.runOnce()).rejects.toBe(failure);
			expect(subject.store.retired).toHaveLength(1);
			expect(subject.store.records[0]?.state).toBe("closing");
			expect(subject.store.uncertain).toEqual([]);
			expect(subject.store.acknowledged).toHaveLength(1);
			fail = false;
			await subject.reaper.runOnce();
			expect(subject.closeKeys).toHaveLength(1);
			expect(subject.store.retired).toHaveLength(1);
			expect(subject.store.evicted).toEqual(subject.store.retired);
			expect(subject.store.records).toEqual([]);
			await subject.reaper.stop();
		},
	);

	test("preserves release failure after successful retirement and retains admission", async () => {
		const failure = new Error("lease release failed");
		let released = 0;
		const subject = harness([active()], "retired", undefined, {
			admission: {
				acquire: async () => () => {
					released += 1;
				},
			},
			leases: {
				acquire: async () => ({
					assertFence: async () => undefined,
					release: async () => {
						throw failure;
					},
				}),
			},
		});
		await expect(subject.reaper.runOnce()).rejects.toBe(failure);
		expect(released).toBe(0);
		expect(subject.store.evicted).toHaveLength(1);
		expect(subject.store.uncertain).toEqual([]);
		await subject.reaper.runOnce();
		expect(subject.closeKeys).toHaveLength(1);
		await expect(subject.reaper.stop()).rejects.toBe(failure);
	});

	test("revalidates the retirement receipt after publication and never evicts a changed authority", async () => {
		const subject = harness([active()]);
		subject.store.publishRetired = async () => {
			subject.store.pendingRetirement = async () => undefined;
		};
		await expect(subject.reaper.runOnce()).rejects.toThrow("receipt changed");
		expect(subject.store.retired).toHaveLength(1);
		expect(subject.store.evicted).toEqual([]);
		expect(subject.store.uncertain).toEqual([]);
		expect(subject.store.acknowledged).toHaveLength(1);
		await subject.reaper.stop();
	});

	test("aggregates original lifecycle and persistence failures without attempting guard release", async () => {
		const original = new Error("close failed");
		const persistence = new Error("uncertainty persistence failed");
		const lease = new Error("lease release failed");
		const admission = new Error("admission release failed");
		let releases = 0;
		const subject = harness([active()], "retired", undefined, {
			runtime: {
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async () => {
					throw original;
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired", evidence: retirementEvidence }),
			},
			leases: {
				acquire: async () => ({
					assertFence: async () => undefined,
					release: async () => {
						releases += 1;
						throw lease;
					},
				}),
			},
			admission: {
				acquire: async () => () => {
					releases += 1;
					throw admission;
				},
			},
		});
		subject.store.markUncertain = async () => {
			throw persistence;
		};
		await expect(subject.reaper.runOnce()).rejects.toMatchObject({
			errors: [original, persistence],
		});
		expect(releases).toBe(0);
		expect(subject.store.retired).toEqual([]);
		await expect(subject.reaper.stop()).rejects.toMatchObject({ errors: [original, persistence] });
	});

	test("retains polling active() failure in the typed channel and rejects stop with the original", async () => {
		let poll!: () => void;
		const failure = new Error("scan failed");
		const entered = deferred<void>();
		const subject = harness([], "retired", undefined, {
			pollIntervalMs: 10,
			setInterval: handler => {
				poll = handler;
				return { unref() {} } as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => undefined,
		});
		subject.store.active = async () => {
			entered.resolve();
			throw failure;
		};
		poll();
		await entered.promise;
		await expect(subject.reaper.stop()).rejects.toBe(failure);
		expect(subject.reaper.lastPollFailure).toEqual({ error: failure, at: 100 });
	});

	test("stop drains concurrent scans waiting on active() and rejects a late scan failure", async () => {
		const first = deferred<ManagedIdleGenerationRecord[]>();
		const second = deferred<ManagedIdleGenerationRecord[]>();
		const entered = deferred<void>();
		const subject = harness([]);
		let scans = 0;
		subject.store.active = async () => {
			scans += 1;
			if (scans === 2) entered.resolve();
			return scans === 1 ? first.promise : second.promise;
		};
		const scan1 = subject.reaper.runOnce();
		const scan2 = subject.reaper.runOnce();
		await entered.promise;
		let stopped = false;
		const failure = new Error("late scan failure");
		const stopping = subject.reaper.stop().finally(() => {
			stopped = true;
		});
		void scan2.catch(() => undefined);
		void stopping.catch(() => undefined);
		first.resolve([active()]);
		await scan1;
		expect(stopped).toBe(false);
		second.reject(failure);
		await expect(scan2).rejects.toBe(failure);
		await expect(stopping).rejects.toBe(failure);
		expect(subject.counts().admissions).toBe(0);
		expect(subject.closeKeys).toEqual([]);
	});

	test("a scan drains another generation's pending close before surfacing an admission failure", async () => {
		const gate = deferred<void>();
		const started = deferred<void>();
		const failure = new Error("tenant admission failed");
		const subject = harness([active("tenant-a"), active("tenant-b")], "retired", undefined, {
			admission: {
				acquire: async key => {
					if (key.principalId === "tenant-a") throw failure;
					return () => undefined;
				},
			},
			runtime: {
				createProducerScope: () => new FakeManagedSdkRuntime().createProducerScope(),
				closeLifecycleSession: async (request, _operation, onOutcome) => {
					started.resolve();
					await gate.promise;
					const outcome = {
						ok: true,
						operation: "session.close",
						result: { sessionId: request.target.sessionId },
					};
					await onOutcome(outcome);
					return outcome;
				},
				reconcile: async () => undefined,
				generationStatus: async () => ({ status: "retired", evidence: retirementEvidence }),
			},
		});
		let finished = false;
		const scan = subject.reaper.runOnce().finally(() => {
			finished = true;
		});
		void scan.catch(() => undefined);
		await started.promise;
		expect(finished).toBe(false);
		const stopping = subject.reaper.stop();
		void stopping.catch(() => undefined);
		gate.resolve();
		await expect(scan).rejects.toBe(failure);
		await expect(stopping).rejects.toBe(failure);
		expect(subject.store.evicted).toHaveLength(1);
	});
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}
