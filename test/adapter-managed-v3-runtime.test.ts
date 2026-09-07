import { describe, expect, spyOn, test } from "bun:test";
import { startActiveManagedRuntime } from "../src/adapter-managed-v3-runtime";
import { ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type { SessionMapping } from "../src/gjc/session-mapping-store";
import type { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

function mapping(overrides: Partial<SessionMapping> = {}): SessionMapping {
	const authority = {
		principalId: "principal-1",
		projectId: "project-1",
		canonicalWorkspace: "/workspace/project-1",
		chatId: "chat-1",
		sessionId: "session-1",
		generation: 7,
		leaseId: "lease-1",
		epoch: "epoch-1",
		requestKey: "request-1",
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	};
	return {
		principalId: authority.principalId,
		chatId: authority.chatId,
		projectId: authority.projectId,
		sessionId: authority.sessionId,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "operation-1",
		managedAuthority: authority,
		...overrides,
	};
}

function store(mappings: readonly SessionMapping[]): SessionV3FileBackedMappingStore {
	return {
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		assertServingReady() {},
		*mappingRecordsIterable() {
			yield* mappings;
		},
	} as unknown as SessionV3FileBackedMappingStore;
}

function runtime(status: "current" | "replaced" | "unknown" = "current", current = true) {
	const calls: string[] = [];
	const registrations: TenantSessionKey[] = [];
	const attachment = { isCurrent: () => current };
	const accounting = new ManagedSdkRuntime({
		agentDir: "/unused-accounting-fixture",
		deps: {
			createRouter: () =>
				new Proxy(
					{},
					{
						get: () => {
							throw new Error("Accounting Router is not available.");
						},
					},
				) as never,
			createLifecycleService: () =>
				new Proxy(
					{},
					{
						get: () => {
							throw new Error("Accounting lifecycle is not available.");
						},
					},
				) as never,
		},
	});
	const fake = {
		createProducerScope: () => accounting.createProducerScope(),
		async start() {
			calls.push("start");
		},
		registerTenant(key: TenantSessionKey) {
			calls.push(`register:${key.chatId}`);
			registrations.push(key);
		},
		async reconcile() {
			calls.push("reconcile");
		},
		async acquireAttachment(key: TenantSessionKey) {
			calls.push(`acquire:${key.chatId}`);
			return { tenant: key, generation: key.generation, isCurrent: attachment.isCurrent };
		},
		async generationStatus() {
			calls.push("status");
			return { status };
		},
		async dispose() {
			calls.push("dispose");
		},
	};
	return { runtime: fake as unknown as ManagedSdkRuntime, calls, registrations };
}

describe("startActiveManagedRuntime", () => {
	test.each([false, true])(
		"actual runtime disposal retains entered external startup fence with rejection=%s",
		async rejected => {
			const entered = Promise.withResolvers<void>();
			const fence = Promise.withResolvers<boolean>();
			let stops = 0;
			const attachment = { sessionId: "session-1", generation: 7, isCurrent: () => true };
			const runtime = new ManagedSdkRuntime({
				agentDir: "/unused-startup-fixture",
				deps: {
					tenantFence: async () => true,
					createRouter: () =>
						({
							start: async () => {},
							reconcile: async () => {},
							attachment: () => attachment,
							generationStatus: async () => ({ status: "current" }),
							stop: async () => {
								stops++;
							},
						}) as never,
					createLifecycleService: () => ({}) as never,
				},
			});
			const pending = startActiveManagedRuntime({
				runtime,
				mappings: store([mapping()]),
				turnTimeoutMs: 50,
				liveTenantFence: async () => {
					entered.resolve();
					return fence.promise;
				},
			}).catch(error => error);
			await Promise.race([
				entered.promise,
				pending.then(error => {
					throw error;
				}),
			]);
			expect(await pending).toMatchObject({ code: "timeout" });
			let disposed = false;
			const disposal = runtime.dispose().then(() => {
				disposed = true;
			});
			try {
				await Bun.sleep(20);
				expect(disposed).toBe(false);
			} finally {
				if (rejected) fence.reject(new Error("late external fence failure"));
				else fence.resolve(true);
				await disposal;
			}
			expect(stops).toBe(1);
			expect(runtime.state).toBe("stopped");
		},
	);

	test("passes remaining startup budget into each runtime proof boundary", async () => {
		const fake = runtime();
		const startTime = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(startTime);
		const budgets: unknown[] = [];
		Object.assign(fake.runtime, {
			start: async () => {
				clock.mockReturnValue(startTime + 100);
			},
			reconcile: async (timeoutMs?: number) => {
				budgets.push(timeoutMs);
				clock.mockReturnValue(startTime + 200);
			},
			acquireAttachment: async (key: TenantSessionKey, timeoutMs?: number) => {
				budgets.push(timeoutMs);
				clock.mockReturnValue(startTime + 300);
				return { tenant: key, generation: key.generation, isCurrent: () => true };
			},
			generationStatus: async (_key: TenantSessionKey, timeoutMs?: number) => {
				budgets.push(timeoutMs);
				return { status: "current" };
			},
		});
		try {
			const active = await startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				turnTimeoutMs: 1000,
				liveTenantFence: () => true,
			});
			expect(budgets).toEqual([900, 800, 700]);
			await active.dispose();
		} finally {
			clock.mockRestore();
		}
	});

	test.each(["start", "reconcile", "acquireAttachment", "generationStatus", "liveTenantFence"] as const)(
		"one startup budget bounds hanging %s and prevents late proof publication",
		async phase => {
			const fake = runtime();
			let release!: (value: unknown) => void;
			const pending = new Promise(resolve => {
				release = resolve;
			});
			if (phase !== "liveTenantFence")
				Object.assign(fake.runtime, {
					[phase]: () => {
						fake.calls.push(`hanging:${phase}`);
						return pending;
					},
				});
			const options = {
				mappings: store([mapping()]),
				runtime: fake.runtime,
				turnTimeoutMs: 80,
				liveTenantFence: phase === "liveTenantFence" ? () => pending.then(() => true) : () => true,
			};
			await expect(startActiveManagedRuntime(options)).rejects.toMatchObject({ code: "timeout" });
			expect(fake.calls.filter(call => call === "dispose")).toHaveLength(1);
			const calls = [...fake.calls];
			release({ status: "current", generation: 7, isCurrent: () => true });
			await Promise.resolve();
			await Promise.resolve();
			expect(fake.calls).toEqual(calls);
			if (phase === "start") expect(fake.registrations).toEqual([]);
		},
	);

	test("startup cleanup does not renew the expired operation budget", async () => {
		const fake = runtime("unknown");
		Object.assign(fake.runtime, {
			dispose: () => {
				fake.calls.push("dispose");
				return new Promise(() => {});
			},
		});
		let failure: unknown;
		try {
			await startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				turnTimeoutMs: 60,
				liveTenantFence: () => true,
			});
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof AggregateError)) throw new Error("Missing startup and cleanup failure evidence.");
		expect(failure.errors[0].message).toContain("requires recovery");
		expect(failure.errors[1].code).toBe("timeout");
		expect(fake.calls.filter(call => call === "dispose")).toHaveLength(1);
	});

	test("successive startup phases consume one budget rather than renewing it", async () => {
		const fake = runtime();
		const delay = (phase: string) => async () => {
			fake.calls.push(phase);
			await Bun.sleep(200);
		};
		Object.assign(fake.runtime, {
			start: delay("start"),
			reconcile: delay("reconcile"),
			acquireAttachment: async () => {
				await delay("acquire")();
				return { generation: 7, isCurrent: () => true };
			},
		});
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				turnTimeoutMs: 500,
				liveTenantFence: () => true,
			}),
		).rejects.toMatchObject({ code: "timeout" });
		expect(fake.calls).toEqual(["start", "register:chat-1", "reconcile", "acquire", "dispose"]);
	});

	test("rejects unresolved historical roots before public runtime effects", () => {
		const fake = runtime();
		const mappings = store([]);
		mappings.assertServingReady = () => {
			throw new Error("Unbound staged history.");
		};
		expect(() => startActiveManagedRuntime({ runtime: fake.runtime, mappings, liveTenantFence: () => true })).toThrow(
			"Unbound staged history",
		);
		expect(fake.calls).toEqual([]);
	});

	test("passes the configured budget into managed operations and rejects changed startup budgets", async () => {
		const fake = runtime();
		const timeouts: number[] = [];
		Object.assign(fake.runtime, {
			async request(_attachment: unknown, _frame: unknown, options: { timeoutMs: number }) {
				timeouts.push(options.timeoutMs);
				return await new Promise(() => {});
			},
		});
		const options = { runtime: fake.runtime, mappings: store([]), liveTenantFence: () => true, turnTimeoutMs: 35 };
		const active = await startActiveManagedRuntime(options);
		await expect(
			active.runner.operations.query(mapping().managedAuthority!, "models.list/current"),
		).rejects.toMatchObject({ code: "timeout" });
		expect(timeouts).toHaveLength(1);
		expect(timeouts[0]).toBeGreaterThan(0);
		expect(timeouts[0]).toBeLessThanOrEqual(35);
		await expect(startActiveManagedRuntime({ ...options, turnTimeoutMs: 40 })).rejects.toThrow(
			"different startup dependencies",
		);
		await active.dispose();
	});
	test("rejects invalid budgets before runtime startup effects", () => {
		for (const turnTimeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
			const fake = runtime();
			expect(() =>
				startActiveManagedRuntime({
					runtime: fake.runtime,
					mappings: store([]),
					liveTenantFence: () => true,
					turnTimeoutMs,
				}),
			).toThrow("turnTimeoutMs");
			expect(fake.calls).toEqual([]);
		}
	});
	test("starts once and exposes only a reconciled, fenced direct V3 runtime", async () => {
		const fake = runtime();
		const fenceKeys: TenantSessionKey[] = [];
		const options = {
			mappings: store([mapping()]),
			runtime: fake.runtime,
			liveTenantFence: async (key: TenantSessionKey) => {
				fenceKeys.push(key);
				return true;
			},
		};
		const [first, second] = await Promise.all([
			startActiveManagedRuntime(options),
			startActiveManagedRuntime(options),
		]);
		expect(first).toBe(second);
		expect(fake.calls).toEqual(["start", "register:chat-1", "reconcile", "acquire:chat-1", "status"]);
		expect(fenceKeys).toHaveLength(1);
		await first.dispose();
		await first.dispose();
		expect(fake.calls.filter(call => call === "dispose")).toHaveLength(1);
	});

	test("registers and reconciles every distinct tenant before publishing dependencies", async () => {
		const fake = runtime();
		const second = mapping({
			principalId: "principal-2",
			chatId: "chat-2",
			projectId: "project-2",
			sessionId: "session-2",
			managedAuthority: {
				...mapping().managedAuthority!,
				principalId: "principal-2",
				chatId: "chat-2",
				projectId: "project-2",
				sessionId: "session-2",
			},
		});
		const active = await startActiveManagedRuntime({
			mappings: store([mapping(), second]),
			runtime: fake.runtime,
			liveTenantFence: () => true,
		});
		expect(fake.registrations.map(key => key.chatId)).toEqual(["chat-1", "chat-2"]);
		expect(fake.calls.filter(call => call === "reconcile")).toHaveLength(2);
		await active.dispose();
	});

	test.each(["replaced", "unknown"] as const)("fails closed for a %s generation", async status => {
		const fake = runtime(status);
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("requires recovery");
		expect(fake.calls).toContain("dispose");
	});

	test("fails closed for a stale attachment after reconciliation", async () => {
		const fake = runtime("current", false);
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("attachment is stale");
		expect(fake.calls).toContain("dispose");
	});

	test("fails closed when the external live lease/epoch fence is lost", async () => {
		const fake = runtime();
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => false,
			}),
		).rejects.toThrow("fence was lost");
		expect(fake.calls).toContain("dispose");
	});

	test("rejects duplicate canonical mapping identities", async () => {
		const fake = runtime();
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping(), mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("Duplicate or conflicting");
		expect(fake.calls).toContain("dispose");
	});

	test("rejects legacy attachment evidence before it can become a dependency", async () => {
		const fake = runtime();
		await expect(
			startActiveManagedRuntime({
				mappings: store([
					mapping({
						attachment: {
							descriptorPath: "/private/legacy.json",
							descriptorStat: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
							payloadDigest: "digest",
							generation: 7,
							expectedSessionId: "session-1",
							expectedCwd: "/workspace/project-1",
						},
					}),
				]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("legacy attachment");
		expect(fake.calls).toContain("dispose");
	});

	test("retains inert projection paths without using them for tenant authority", async () => {
		const fake = runtime();
		const active = await startActiveManagedRuntime({
			runtime: fake.runtime,
			mappings: store([mapping({ sessionFile: "/inert/history.jsonl", activeLeaf: "old-leaf" })]),
			liveTenantFence: () => true,
		});
		expect(fake.registrations).toHaveLength(1);
		expect(Object.hasOwn(fake.registrations[0]!, "sessionFile")).toBe(false);
		expect(fake.registrations[0]!.generation).toBe(7);
		await active.dispose();
	});

	test("disposes the process-owned runtime when a provisional generation cannot be proven current", async () => {
		const fake = runtime("unknown");
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("provisional");
		expect(fake.calls.at(-1)).toBe("dispose");
	});
});
