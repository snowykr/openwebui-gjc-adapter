import { describe, expect, spyOn, test } from "bun:test";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { GjcTurnCancelledError } from "../src/gjc/turn-runner";
import {
	createManagedModelReaderFactory,
	ManagedModelReaderUnavailableError,
} from "../src/live/gjc-managed-model-reader";

const tenant: TenantSessionKey = {
	principalId: "principal-1",
	projectId: "project-1",
	canonicalWorkspace: "/workspace/project-1",
	chatId: "chat-1",
	sessionId: "session-1",
	generation: 7,
	leaseId: "lease-1",
	epoch: "epoch-1",
};

const temporary = {
	principalId: tenant.principalId,
	projectId: tenant.projectId,
	canonicalWorkspace: tenant.canonicalWorkspace,
	chatId: tenant.chatId,
	leaseId: tenant.leaseId,
	epoch: tenant.epoch,
	requestKey: "catalog-1",
	assertFence: async () => undefined,
};

const userContext = {
	principal: { role: "user" as const, userId: tenant.principalId },
	workspace: {
		userId: tenant.principalId,
		safeKey: "principal-1",
		root: tenant.canonicalWorkspace,
		sessionRoot: `${tenant.canonicalWorkspace}/.gjc/sessions`,
	},
	lease: { assertFence: async () => undefined },
};

describe("managed model reader", () => {
	test.each(["success", "fence-failure", "cancelled"] as const)(
		"retains original existing-reader scope and callbacks after caller mutation with %s",
		async mode => {
			const fake = new FakeRuntime();
			const entered = Promise.withResolvers<void>(),
				released = Promise.withResolvers<void>();
			const controller = new AbortController();
			let originalChecks = 0,
				replacementChecks = 0;
			class Lease {
				#owned = true;
				async assertFence() {
					expect(this.#owned).toBe(true);
					originalChecks += 1;
					if (originalChecks === 2) {
						entered.resolve();
						await released.promise;
					}
					if (mode === "fence-failure" && originalChecks > 1) throw new Error("original fence revoked");
				}
			}
			const lease = new Lease();
			const context = {
				...userContext,
				principal: { ...userContext.principal },
				workspace: { ...userContext.workspace },
				lease,
				signal: controller.signal,
			};
			const resolved = { tenant: { ...tenant } };
			const input = { runtime: fake.runtime, timeoutMs: 1000, resolveAttachment: async () => resolved };
			const pending = createManagedModelReaderFactory(input)(context);
			const observed = pending.catch(error => error);
			await entered.promise;
			const replacement = async () => {
				replacementChecks += 1;
			};
			Object.assign(input, { resolveAttachment: replacement, runtime: new FakeRuntime().runtime, timeoutMs: 60000 });
			Object.assign(context.principal, { userId: "foreign" });
			Object.assign(context.workspace, { userId: "foreign", root: "/foreign" });
			Object.assign(context, { signal: new AbortController().signal, lease: { assertFence: replacement } });
			Object.assign(lease, { assertFence: replacement });
			Object.assign(resolved.tenant, { principalId: "foreign", canonicalWorkspace: "/foreign", generation: 99 });
			if (mode === "cancelled") controller.abort();
			released.resolve();
			const outcome = await observed;
			if (mode === "success") {
				expect(await outcome.getAvailableModels()).toHaveLength(1);
				await outcome.stop();
				expect(fake.acquired).toEqual([tenant]);
				expect(originalChecks).toBeGreaterThan(2);
			} else {
				expect(outcome).toBeInstanceOf(
					mode === "cancelled" ? GjcTurnCancelledError : ManagedModelReaderUnavailableError,
				);
				expect(fake.acquired).toHaveLength(0);
			}
			expect(replacementChecks).toBe(0);
		},
	);

	test("retains original temporary authority and fence after caller mutation", async () => {
		const fake = new FakeRuntime();
		const entered = Promise.withResolvers<void>(),
			released = Promise.withResolvers<void>();
		let checks = 0,
			replacementChecks = 0;
		const original = {
			...temporary,
			assertFence: async () => {
				checks += 1;
				if (checks === 1) {
					entered.resolve();
					await released.promise;
				}
			},
		};
		const input = { runtime: fake.runtime, timeoutMs: 1000, temporary: original };
		const pending = createManagedModelReaderFactory(input)();
		await entered.promise;
		Object.assign(original, {
			principalId: "foreign",
			canonicalWorkspace: "/foreign",
			requestKey: "replacement",
			assertFence: async () => {
				replacementChecks += 1;
			},
		});
		Object.assign(input, { temporary: { ...original }, runtime: new FakeRuntime().runtime });
		released.resolve();
		const reader = await pending;
		expect(await reader.getAvailableModels()).toHaveLength(1);
		await reader.stop();
		expect(fake.created?.requestKey).toBe(temporary.requestKey);
		expect(fake.registered[0]?.principalId).toBe(tenant.principalId);
		expect(checks).toBeGreaterThan(1);
		expect(replacementChecks).toBe(0);
	});

	test.each(["context", "resolver", "reconcile", "acquire"] as const)(
		"bounds existing-reader %s admission without later work after release",
		async phase => {
			const fake = new FakeRuntime();
			const effects: string[] = [];
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			const effect = async (name: string) => {
				effects.push(name);
				if (name === phase) await gate;
			};
			const reconcile = spyOn(fake, "reconcile").mockImplementation(async () => effect("reconcile"));
			const acquire = spyOn(fake, "acquireAttachment").mockImplementation(async () => {
				await effect("acquire");
				return { tenant, generation: tenant.generation, isCurrent: () => true };
			});
			try {
				await expect(
					createManagedModelReaderFactory({
						runtime: fake.runtime,
						timeoutMs: 50,
						resolveAttachment: async () => {
							await effect("resolver");
							return { tenant };
						},
					})({ ...userContext, lease: { assertFence: () => effect("context") } }),
				).rejects.toThrow();
				const beforeRelease = [...effects];
				release();
				await new Promise(resolve => setTimeout(resolve, 0));
				expect(effects).toEqual(beforeRelease);
				expect(effects.at(-1)).toBe(phase);
				expect(fake.requests).toEqual([]);
				expect(fake.created).toBeUndefined();
			} finally {
				release();
				reconcile.mockRestore();
				acquire.mockRestore();
			}
		},
	);

	test.each(["existing", "temporary"] as const)(
		"%s acquisition, multiple queries and stop consume one lifetime budget",
		async kind => {
			const fake = new FakeRuntime();
			let now = Date.now();
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			let spent = false;
			const spendAdmission = async () => {
				if (!spent) {
					now += 400;
					spent = true;
				}
			};
			fake.queryHandler = async frame => {
				now += 300;
				return { type: "query_response", ok: true, page: { items: [frame.query], complete: true } };
			};
			try {
				const reader = await createManagedModelReaderFactory({
					runtime: fake.runtime,
					timeoutMs: 1_000,
					...(kind === "existing"
						? {
								resolveAttachment: async () => {
									await spendAdmission();
									return { tenant };
								},
							}
						: { temporary: { ...temporary, assertFence: spendAdmission } }),
				})();
				expect(await reader.getAvailableModels()).toEqual(["models.list/current"]);
				const error = await reader.getActiveProviders().catch(error => error);
				expect(kind === "temporary" ? error.errors[0].code : error.code).toBe("timeout");
				expect(fake.requestTimeouts).toEqual([600, 300]);
				await expect(reader.stop()).rejects.toMatchObject({ code: "timeout" });
				expect(fake.closed).toBeUndefined();
				if (kind === "temporary") {
					expect(fake.createTimeoutMs).toBe(600);
					expect(fake.registrationTimeouts).toEqual([600]);
				} else expect(fake.reconcileTimeouts).toEqual([600]);
				expect(fake.acquisitionTimeouts).toEqual([600]);
			} finally {
				clock.mockRestore();
			}
		},
	);

	test.each(["create", "register", "close"] as const)(
		"temporary %s timeout starts no later effect or renewed cleanup",
		async phase => {
			const fake = new FakeRuntime();
			let release!: () => void;
			const gate = new Promise<void>(resolve => {
				release = resolve;
			});
			if (phase === "create") fake.createGate = gate;
			if (phase === "close") fake.closeGate = gate;
			const register =
				phase === "register"
					? spyOn(fake, "registerLifecycleTenant").mockImplementation(async key => {
							await gate;
							return { tenant: key, generation: key.generation, isCurrent: () => true };
						})
					: undefined;
			try {
				const creation = createManagedModelReaderFactory({ runtime: fake.runtime, timeoutMs: 50, temporary })();
				if (phase === "close") {
					const reader = await creation;
					const failure = await Promise.resolve(reader.stop()).catch(error => error);
					expect(failure).toBeInstanceOf(AggregateError);
					await expect(reader.stop()).rejects.toBe(failure);
				} else await expect(creation).rejects.toThrow();
				release();
				await new Promise(resolve => setTimeout(resolve, 0));
				expect(fake.createCalls).toBe(1);
				expect(fake.requests).toEqual([]);
				expect(fake.statusKeys).toEqual([]);
				expect(fake.unregistered).toEqual([]);
				if (phase !== "close") expect(fake.closed).toBeUndefined();
			} finally {
				release();
				register?.mockRestore();
			}
		},
	);

	test("expired temporary fence cannot start its second lease check", async () => {
		const fake = new FakeRuntime();
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let contextChecks = 0;
		try {
			await expect(
				createManagedModelReaderFactory({
					runtime: fake.runtime,
					timeoutMs: 100,
					temporary: {
						...temporary,
						assertFence: async () => {
							now += 100;
						},
					},
				})({
					...userContext,
					lease: {
						assertFence: async () => {
							contextChecks += 1;
						},
					},
				}),
			).rejects.toMatchObject({ code: "timeout" });
			expect(contextChecks).toBe(1);
			expect(fake.createCalls).toBe(0);
		} finally {
			clock.mockRestore();
		}
	});

	test.each([0, -1, 1.5, Infinity, 2_147_483_648])(
		"rejects invalid catalog lifetime %s before admission",
		async timeoutMs => {
			const fake = new FakeRuntime();
			let resolved = false;
			await expect(
				createManagedModelReaderFactory({
					runtime: fake.runtime,
					timeoutMs,
					resolveAttachment: async () => {
						resolved = true;
						return { tenant };
					},
				})(),
			).rejects.toThrow("positive finite timer-safe integer");
			expect(resolved).toBe(false);
			expect(fake.reconciles).toBe(0);
		},
	);

	test("collects complete model and provider pages with exact cursors", async () => {
		const fake = new FakeRuntime();
		fake.queryHandler = async frame => ({
			type: "query_response",
			ok: true,
			page: {
				items: [`${frame.query}:${frame.cursor ?? "first"}`],
				complete: frame.cursor !== undefined,
				...(frame.cursor === undefined ? { continuationCursor: "second" } : {}),
			},
		});
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			resolveAttachment: async () => ({ tenant }),
		})(userContext);
		try {
			expect(await reader.getAvailableModels()).toEqual(["models.list/current:first", "models.list/current:second"]);
			expect(await reader.getActiveProviders()).toEqual([
				"providers.list/active:first",
				"providers.list/active:second",
			]);
			expect(fake.requests.map(frame => frame.cursor)).toEqual([undefined, "second", undefined, "second"]);
		} finally {
			await reader.stop();
		}
	});

	test.each(["missing-cursor", "repeat-cursor", "page-bound", "item-bound"] as const)(
		"rejects %s instead of returning an incomplete catalog",
		async mode => {
			const fake = new FakeRuntime();
			fake.queryHandler = async () => ({
				type: "query_response",
				ok: true,
				page: {
					items: mode === "item-bound" ? Array.from({ length: 100_001 }, () => "item") : [],
					complete: mode === "item-bound",
					...(mode === "repeat-cursor"
						? { continuationCursor: "same" }
						: mode === "page-bound"
							? { continuationCursor: String(fake.requests.length) }
							: {}),
				},
			});
			const reader = await createManagedModelReaderFactory({
				runtime: fake.runtime,
				resolveAttachment: async () => ({ tenant }),
			})(userContext);
			try {
				await expect(reader.getAvailableModels()).rejects.toThrow(
					mode === "missing-cursor"
						? "incomplete"
						: mode === "repeat-cursor"
							? "repeated"
							: mode === "page-bound"
								? "page bound"
								: "item bound",
				);
				expect(fake.requests.length).toBe(mode === "page-bound" ? 256 : mode === "repeat-cursor" ? 2 : 1);
			} finally {
				await reader.stop();
			}
		},
	);

	test("catalog pages and cleanup cannot renew an expired query budget", async () => {
		const fake = new FakeRuntime();
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			timeoutMs: 1_000,
			temporary,
		})();
		fake.queryHandler = async () => {
			now += 600;
			return {
				type: "query_response",
				ok: true,
				page: { items: [], complete: false, continuationCursor: String(fake.requests.length) },
			};
		};
		try {
			const failure = await reader.getAvailableModels().catch(error => error);
			expect(failure).toBeInstanceOf(AggregateError);
			expect(failure.errors[0].code).toBe("timeout");
			expect(fake.requestTimeouts).toEqual([1_000, 400]);
			expect(fake.closed).toBeUndefined();
			await expect(reader.stop()).rejects.toMatchObject({ code: "timeout" });
			await expect(reader.stop()).rejects.toMatchObject({ code: "timeout" });
		} finally {
			clock.mockRestore();
		}
	});

	test("a hanging catalog lease check cannot dispatch a late query or renewed cleanup", async () => {
		const fake = new FakeRuntime();
		let blocked = false;
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			timeoutMs: 50,
			temporary: {
				...temporary,
				assertFence: async () => {
					if (blocked) await gate;
				},
			},
		})();
		blocked = true;
		const error = await reader.getAvailableModels().catch(error => error);
		expect(error).toBeInstanceOf(AggregateError);
		expect(error.errors[0].code).toBe("timeout");
		release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toEqual([]);
		expect(fake.closed).toBeUndefined();
		await expect(reader.stop()).rejects.toMatchObject({ code: "timeout" });
	});

	test("stopped reader rejects new and already-admitted queries without another request", async () => {
		const fake = new FakeRuntime();
		let resolve!: (value: Record<string, unknown>) => void;
		const gate = new Promise<Record<string, unknown>>(done => {
			resolve = done;
		});
		let entered!: () => void;
		const admission = new Promise<void>(done => {
			entered = done;
		});
		fake.queryHandler = async () => {
			entered();
			return gate;
		};
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			resolveAttachment: async () => ({ tenant }),
		})(userContext);
		const pending = reader.getAvailableModels().catch(error => error);
		await admission;
		await reader.stop();
		resolve({ type: "query_response", ok: true, page: { items: ["not-visible"], complete: true } });
		expect(await pending).toMatchObject({ code: "operation_closed" });
		await expect(reader.getActiveProviders()).rejects.toThrow("stopped");
		expect(fake.requests).toHaveLength(1);
	});

	test("queries models, providers, and state through one exact existing Router attachment", async () => {
		const fake = new FakeRuntime();
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			resolveAttachment: async () => ({ tenant }),
		})(userContext);

		await expect(reader.getAvailableModels()).resolves.toEqual([{ provider: "openai", id: "gpt-5" }]);
		await expect(reader.getActiveProviders()).resolves.toEqual([
			{ provider: "openai", connectionKind: "credentialless" },
		]);
		await expect(reader.getState()).resolves.toEqual({ model: { provider: "openai", id: "gpt-5" } });
		expect(fake.reconciles).toBe(1);
		expect(fake.requests.map(frame => frame.query)).toEqual([
			"models.list/current",
			"providers.list/active",
			"session.state",
		]);
		expect(JSON.stringify(fake)).not.toMatch(/token|password/i);
	});

	test("creates an isolated catalog lifecycle, acquires its exact generation, and proves retirement on stop", async () => {
		const fake = new FakeRuntime();
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			timeoutMs: 250,
			temporary,
		})();
		await reader.stop();

		expect(fake.created).toMatchObject({
			capability: "session.create",
			target: { kind: "existing_path", path: temporary.canonicalWorkspace },
		});
		expect(fake.created).not.toHaveProperty("timeoutMs");
		expect(fake.created).not.toHaveProperty("readinessTimeoutMs");
		expect(fake.createTimeoutMs).toBeGreaterThan(0);
		expect(fake.createTimeoutMs).toBeLessThanOrEqual(250);
		expect(fake.preparedCreates).toEqual([
			expect.objectContaining({
				principalId: temporary.principalId,
				projectId: temporary.projectId,
				canonicalWorkspace: temporary.canonicalWorkspace,
				chatId: temporary.chatId,
				leaseId: temporary.leaseId,
				epoch: temporary.epoch,
				requestKey: temporary.requestKey,
			}),
		]);
		expect(fake.registered).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
		expect(fake.closed).toMatchObject({
			tenant: { ...tenant, sessionId: "catalog-session", generation: 11 },
			capability: "session.close",
			target: { sessionId: "catalog-session", endpointGeneration: 11 },
		});
		expect(fake.statusKeys).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
		expect(fake.unregistered).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
	});

	test("does not create a catalog session with substituted prepared authority", async () => {
		for (const change of [
			{ principalId: "foreign" },
			{ projectId: "foreign" },
			{ canonicalWorkspace: "/foreign" },
			{ chatId: "foreign" },
			{ leaseId: "foreign" },
			{ epoch: "foreign" },
			{ requestKey: "foreign" },
		]) {
			const fake = new FakeRuntime();
			await expect(
				createManagedModelReaderFactory({ runtime: fake.runtime, temporary: { ...temporary, ...change } })(),
			).rejects.toThrow("prepared authority");
			expect(fake.createCalls).toBe(0);
			expect(fake.created).toBeUndefined();
		}
	});

	test.each(["failed", "foreign"] as const)(
		"rejects %s close acknowledgement despite positive retirement",
		async mode => {
			const fake = new FakeRuntime();
			fake.closeOutcome =
				mode === "failed"
					? {
							ok: false,
							operation: "session.close",
							certainty: "uncertain",
							error: { code: "failed", message: "close failed" },
						}
					: { ok: true, operation: "session.close", result: { sessionId: "foreign-session" } };
			const reader = await createManagedModelReaderFactory({ runtime: fake.runtime, temporary })();
			await expect(reader.stop()).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
			await expect(reader.stop()).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
			expect(fake.statusKeys).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
			expect(fake.unregistered).toEqual([]);
		},
	);

	test("fails closed before dispatch and cleans a late-created temporary session after cancellation", async () => {
		const fake = new FakeRuntime();
		const controller = new AbortController();
		controller.abort();
		await expect(
			createManagedModelReaderFactory({ runtime: fake.runtime, temporary })(undefined, controller.signal),
		).rejects.toBeInstanceOf(GjcTurnCancelledError);
		expect(fake.created).toBeUndefined();

		let release!: () => void;
		fake.createGate = new Promise<void>(resolve => {
			release = resolve;
		});
		const lateController = new AbortController();
		const late = createManagedModelReaderFactory({ runtime: fake.runtime, temporary })(
			undefined,
			lateController.signal,
		);
		for (let attempt = 0; attempt < 20 && fake.createCalls < 1; attempt++) await Bun.sleep(1);
		expect(fake.createCalls).toBe(1);
		lateController.abort();
		release();
		await expect(late).rejects.toBeInstanceOf(GjcTurnCancelledError);
		await fake.closeObserved;
		expect(fake.closed).toBeDefined();
	});

	test("cancellation waits for admitted creation and preserves cleanup failure", async () => {
		const fake = new FakeRuntime();
		let releaseCreation!: () => void;
		let releaseClose!: () => void;
		fake.createGate = new Promise<void>(resolve => {
			releaseCreation = resolve;
		});
		fake.closeGate = new Promise<void>(resolve => {
			releaseClose = resolve;
		});
		fake.closeOutcome = {
			ok: false,
			operation: "session.close",
			certainty: "uncertain",
			error: { code: "failed", message: "denied" },
		};
		const controller = new AbortController();
		let settled = false;
		const pending = createManagedModelReaderFactory({ runtime: fake.runtime, timeoutMs: 1_000, temporary })(
			undefined,
			controller.signal,
		)
			.catch(error => error)
			.finally(() => {
				settled = true;
			});
		try {
			for (let attempt = 0; attempt < 20 && fake.createCalls < 1; attempt++) await Bun.sleep(1);
			expect(fake.createCalls).toBe(1);
			controller.abort();
			releaseCreation();
			await fake.closeObserved;
			expect(settled).toBe(false);
			releaseClose();
			const error = await pending;
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors[0]).toBeInstanceOf(GjcTurnCancelledError);
			expect(error.errors[1]).toBeInstanceOf(ManagedModelReaderUnavailableError);
			expect(fake.registered).toEqual([]);
			expect(fake.unregistered).toEqual([]);
			expect(fake.requests).toEqual([]);
		} finally {
			releaseCreation();
			releaseClose();
			await pending;
		}
	});

	test("cleans up after query failure and rejects replaced or unknown retirement proof", async () => {
		const fake = new FakeRuntime();
		fake.queryFailure = new Error("query unavailable");
		const reader = await createManagedModelReaderFactory({ runtime: fake.runtime, temporary })();
		await expect(reader.getAvailableModels()).rejects.toThrow("query unavailable");
		expect(fake.closed).toBeDefined();

		for (const status of ["replaced", "unknown"] as const) {
			const uncertain = new FakeRuntime();
			uncertain.status = status;
			const temporaryReader = await createManagedModelReaderFactory({ runtime: uncertain.runtime, temporary })();
			await expect(temporaryReader.stop()).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
		}
	});

	test("rejects tenant mismatch before every query dispatch", async () => {
		const fake = new FakeRuntime();
		fake.rejectTenant = true;
		await expect(
			createManagedModelReaderFactory({ runtime: fake.runtime, resolveAttachment: async () => ({ tenant }) })(),
		).rejects.toThrow("tenant mismatch");
		expect(fake.requests).toHaveLength(0);
	});

	test("keeps fixture capabilities stable and revokes them when tenant authority is lost", async () => {
		const fake = new FakeRuntime();
		const acquired = await fake.acquireAttachment(tenant);
		expect(await fake.acquireAttachment({ ...tenant })).toBe(acquired);
		expect(acquired).not.toHaveProperty("attachment");
		expect(acquired).not.toHaveProperty("send");
		fake.rejectTenant = true;
		expect(acquired.isCurrent()).toBe(false);
		await expect(fake.request(acquired, { query: "session.state" })).rejects.toThrow("tenant mismatch");
		fake.rejectTenant = false;
		fake.unregisterTenant(tenant);
		expect(acquired.isCurrent()).toBe(false);
		const replacement = await fake.registerLifecycleTenant({ ...tenant });
		expect(replacement).not.toBe(acquired);
		expect(replacement.isCurrent()).toBe(true);
		expect(acquired.isCurrent()).toBe(false);
		await fake.generationStatus(tenant);
		expect(replacement.isCurrent()).toBe(false);
	});

	test("requires the normal-user workspace and lease fence to match managed tenant authority", async () => {
		const fake = new FakeRuntime();
		let fenceCalls = 0;
		const context = {
			...userContext,
			lease: {
				assertFence: async () => {
					fenceCalls += 1;
				},
			},
		};
		await createManagedModelReaderFactory({ runtime: fake.runtime, resolveAttachment: async () => ({ tenant }) })(
			context,
		);
		expect(fenceCalls).toBe(2);
		await expect(
			createManagedModelReaderFactory({ runtime: fake.runtime, resolveAttachment: async () => ({ tenant }) })({
				...userContext,
				workspace: { ...userContext.workspace, root: "/other-workspace" },
			}),
		).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
	});
});

class FakeRuntime {
	private closeResolve: () => void = () => undefined;
	readonly closeObserved = new Promise<void>(resolve => {
		this.closeResolve = resolve;
	});
	readonly #attachments = new Map<string, ManagedSdkAttachment>();
	readonly #tenants = new Set<string>([tenantIdentity(tenant)]);
	readonly #retired = new Set<string>();
	readonly requests: Record<string, unknown>[] = [];
	readonly acquired: TenantSessionKey[] = [];
	readonly registered: TenantSessionKey[] = [];
	readonly unregistered: TenantSessionKey[] = [];
	readonly statusKeys: TenantSessionKey[] = [];
	readonly preparedCreates: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[0][] = [];
	created: Record<string, unknown> | undefined;
	createTimeoutMs: number | undefined;
	createCalls = 0;
	closed: Record<string, unknown> | undefined;
	closeOutcome: Awaited<ReturnType<ManagedSdkRuntime["closeLifecycleSession"]>> | undefined;
	reconciles = 0;
	status: "retired" | "replaced" | "unknown" = "retired";
	rejectTenant = false;
	queryFailure: Error | undefined;
	queryHandler: ((frame: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
	readonly requestTimeouts: (number | undefined)[] = [];
	readonly reconcileTimeouts: (number | undefined)[] = [];
	readonly acquisitionTimeouts: (number | undefined)[] = [];
	readonly registrationTimeouts: (number | undefined)[] = [];
	createGate: Promise<void> | undefined;
	closeGate: Promise<void> | undefined;

	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile(timeoutMs?: number) {
		this.reconcileTimeouts.push(timeoutMs);
		this.reconciles += 1;
	}
	async acquireAttachment(key: TenantSessionKey, timeoutMs?: number) {
		this.acquisitionTimeouts.push(timeoutMs);
		const identity = tenantIdentity(key);
		if (this.rejectTenant || !this.#tenants.has(identity) || this.#retired.has(identity))
			throw new Error("tenant mismatch");
		this.acquired.push(key);
		let token = this.#attachments.get(identity);
		if (token === undefined) {
			const issued: ManagedSdkAttachment = Object.freeze({
				tenant: Object.freeze({ ...key }),
				generation: key.generation,
				isCurrent: () =>
					!this.rejectTenant &&
					!this.#retired.has(identity) &&
					this.#tenants.has(identity) &&
					this.#attachments.get(identity) === issued,
			});
			token = issued;
			this.#attachments.set(identity, token);
		}
		return token;
	}
	async request(
		attachment: ManagedSdkAttachment,
		frame: Record<string, unknown>,
		options?: { timeoutMs?: number; beforeDispatch?: () => void },
	) {
		options?.beforeDispatch?.();
		if (this.#attachments.get(tenantIdentity(attachment.tenant)) !== attachment || !attachment.isCurrent())
			throw new Error("tenant mismatch");
		this.requests.push(frame);
		this.requestTimeouts.push(options?.timeoutMs);
		if (this.queryFailure !== undefined) throw this.queryFailure;
		if (this.queryHandler !== undefined) return this.queryHandler(frame);
		if (frame.query === "models.list/current")
			return {
				type: "query_response",
				ok: true,
				page: { items: [{ provider: "openai", id: "gpt-5" }], complete: true },
			};
		if (frame.query === "providers.list/active")
			return {
				type: "query_response",
				ok: true,
				page: { items: [{ provider: "openai", connectionKind: "credentialless" }], complete: true },
			};
		return {
			type: "query_response",
			ok: true,
			page: { items: [{ model: { provider: "openai", id: "gpt-5" } }], complete: true },
		};
	}
	async createPreparedExternalLifecycleSession(
		authority: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[0],
		request: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[1],
		timeoutMs?: number,
		onOutcome?: (outcome: unknown) => void | Promise<void>,
	) {
		if (
			this.rejectTenant ||
			!["principalId", "projectId", "canonicalWorkspace", "chatId", "leaseId", "epoch", "requestKey"].every(
				field => Reflect.get(authority, field) === Reflect.get(temporary, field),
			)
		)
			throw new Error("Fixture prepared authority does not match the catalog tenant.");
		if (
			request.actor.id !== authority.principalId ||
			request.requestKey !== authority.requestKey ||
			request.capability !== "session.create" ||
			request.target.kind !== "existing_path" ||
			request.target.path !== authority.canonicalWorkspace
		)
			throw new Error("Fixture lifecycle request does not match prepared authority.");
		this.preparedCreates.push(authority);
		this.createCalls += 1;
		this.created = request;
		this.createTimeoutMs = timeoutMs;
		await this.createGate;
		const outcome = { ok: true, result: { sessionId: "catalog-session", endpointGeneration: 11 } };
		await onOutcome?.(outcome);
		return outcome;
	}
	async registerLifecycleTenant(key: TenantSessionKey, timeoutMs?: number) {
		this.registrationTimeouts.push(timeoutMs);
		if (this.rejectTenant) throw new Error("tenant mismatch");
		this.registered.push(key);
		this.#tenants.add(tenantIdentity(key));
		return this.acquireAttachment(key, timeoutMs);
	}
	async closeLifecycleSession(
		request: NonNullable<Parameters<ManagedSdkRuntime["closeLifecycleSession"]>[1]> & {
			readonly tenant: TenantSessionKey;
		},
	): ReturnType<ManagedSdkRuntime["closeLifecycleSession"]> {
		const expected = { ...tenant, sessionId: "catalog-session", generation: 11 };
		if (
			request.tenant === undefined ||
			tenantIdentity(request.tenant) !== tenantIdentity(expected) ||
			request.target.sessionId !== expected.sessionId ||
			request.target.endpointGeneration !== expected.generation ||
			request.actor.id !== expected.principalId ||
			request.capability !== "session.close"
		)
			throw new Error("Fixture close requires exact catalog tenant and generation authority.");
		this.closed = request;
		this.closeResolve();
		await this.closeGate;
		return (
			this.closeOutcome ?? { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } }
		);
	}
	async generationStatus(key: TenantSessionKey) {
		this.statusKeys.push(key);
		if (this.status === "retired" || this.status === "replaced") this.#retired.add(tenantIdentity(key));
		return { status: this.status };
	}
	unregisterTenant(key: TenantSessionKey) {
		this.unregistered.push(key);
		const identity = tenantIdentity(key);
		this.#tenants.delete(identity);
		this.#attachments.delete(identity);
	}
}

function tenantIdentity(key: TenantSessionKey): string {
	return JSON.stringify([
		key.principalId,
		key.projectId,
		key.canonicalWorkspace,
		key.chatId,
		key.sessionId,
		key.generation,
		key.leaseId,
		key.epoch,
	]);
}
