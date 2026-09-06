import { describe, expect, spyOn, test } from "bun:test";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import { type ManagedSdkAttachment, ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import { createManagedSuccessorFlow, ManagedSuccessorUncertainError } from "../src/live/gjc-managed-successor";

const source: ManagedTurnAuthority = {
	principalId: "user-a",
	projectId: "project-a",
	canonicalWorkspace: "/workspace/a",
	chatId: "chat-a",
	sessionId: "source-session",
	generation: 4,
	leaseId: "lease-a",
	epoch: "epoch-a",
	requestKey: "branch-message-7",
};
const successor = { sessionId: "forked-session", endpointGeneration: 9 };
const target = {
	principalId: source.principalId,
	projectId: source.projectId,
	canonicalWorkspace: source.canonicalWorkspace,
	chatId: source.chatId,
	leaseId: source.leaseId,
	epoch: source.epoch,
	requestKey: source.requestKey,
};

type LifecycleService = ReturnType<typeof lifecycle.createSessionLifecycleService>;
type ForkRequest = Parameters<LifecycleService["fork"]>[0];
type ForkOutcome = Awaited<ReturnType<LifecycleService["fork"]>>;
type CloseRequest = Parameters<LifecycleService["close"]>[0];
type CloseOutcome = Awaited<ReturnType<LifecycleService["close"]>>;
const sourceTenant: TenantSessionKey = {
	principalId: source.principalId,
	projectId: source.projectId,
	canonicalWorkspace: source.canonicalWorkspace,
	chatId: source.chatId,
	leaseId: source.leaseId,
	epoch: source.epoch,
	sessionId: source.sessionId,
	generation: source.generation,
};
const successorAuthority: ManagedTurnAuthority = {
	...source,
	sessionId: successor.sessionId,
	generation: successor.endpointGeneration,
};

describe("managed successor with an explicit runtime boundary fake", () => {
	test.each([
		"reconcile",
		"acquire:source-session:4",
		"invoking",
		"fork",
		"acknowledge",
		"register",
		"adopt",
		"status:forked-session:9",
		"publish",
		"close",
	] as const)("a hanging %s cannot renew the successor budget or start later effects", async phase => {
		const fake = new FakeRuntime();
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let entered!: () => void;
		const admission = new Promise<void>(resolve => {
			entered = resolve;
		});
		const wait = async (current: string) => {
			if (current === phase) {
				entered();
				await gate;
			}
		};
		fake.afterPhase = wait;
		const pending = createManagedSuccessorFlow(fake.runtime, 100)
			.fork({
				source,
				target,
				...(phase === "adopt"
					? {
							lifecycleOperation: {
								operationId: "branch",
								requestKey: source.requestKey,
								payloadHash: "a".repeat(64),
							},
						}
					: {}),
				onInvoking: () => wait("invoking"),
				onAcknowledged: () => wait("acknowledge"),
				publish: async () => {
					if (phase === "close") throw new Error("publication failed");
					await wait("publish");
				},
			})
			.catch(error => error);
		await admission;
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		if (phase === "reconcile" || phase === "acquire:source-session:4" || phase === "invoking") {
			expect(error.code).toBe("timeout");
			expect(fake.forks).toHaveLength(0);
		} else expect(error).toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(fake.closeTargets).toHaveLength(phase === "close" ? 1 : 0);
		expect(fake.unregistered).toEqual([]);
		const effects = [...fake.order];
		release();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.order).toEqual(effects);
	});

	test("source admission and target proof spend one budget before publication or cleanup", async () => {
		const fake = new FakeRuntime();
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		fake.afterPhase = async () => {
			now += 200;
		};
		let published = false;
		try {
			const error = await createManagedSuccessorFlow(fake.runtime, 1_000)
				.fork({
					source,
					target,
					onAcknowledged: () => {
						now += 200;
					},
					publish: () => {
						published = true;
					},
				})
				.catch(error => error);
			expect(error).toBeInstanceOf(ManagedSuccessorUncertainError);
			expect(error.acknowledgedAuthority).toEqual(successorAuthority);
			expect(fake.forks[0]!.timeoutMs).toBe(600);
			expect(published).toBe(false);
			expect(fake.closeTargets).toEqual([]);
			expect(fake.order).not.toContain("status:forked-session:9");
		} finally {
			clock.mockRestore();
		}
	});

	test.each([0, -1, 1.5, Infinity, 2_147_483_648])(
		"invalid successor budget %s rejects before source admission",
		async timeoutMs => {
			const fake = new FakeRuntime();
			await expect(
				createManagedSuccessorFlow(fake.runtime).fork({ source, target, timeoutMs, publish: () => undefined }),
			).rejects.toBeInstanceOf(TypeError);
			expect(fake.order).toEqual([]);
		},
	);

	test("forks with stable actor/request key/hash and publishes only after target proof", async () => {
		const fake = new FakeRuntime();
		const published: string[] = [];
		const result = await createManagedSuccessorFlow(fake.runtime).fork({
			source,
			target,
			onAcknowledged: authority => {
				expect(authority).toEqual(successorAuthority);
				fake.order.push("acknowledged");
			},
			publish: successor => {
				published.push(successor.tenant.sessionId);
				fake.order.push("publish");
			},
		});
		expect(result.successor.tenant).toMatchObject({
			sessionId: successor.sessionId,
			generation: successor.endpointGeneration,
		});
		expect(result.successor).not.toHaveProperty("descriptorPath");
		expect(result.successor).not.toHaveProperty("tmuxPane");
		expect(result.successor).not.toHaveProperty("tmuxOwnershipTag");
		expect(JSON.stringify(result)).not.toMatch(/descriptor|tmux|sessionFile/i);
		expect(published).toEqual([successor.sessionId]);
		expect(fake.order).toEqual([
			"reconcile",
			"acquire:source-session:4",
			"fork",
			"acknowledged",
			"register:forked-session:9",
			"reconcile",
			"acquire:forked-session:9",
			"status:forked-session:9",
			"publish",
		]);
		expect(fake.forks[0]).toEqual({
			actor: { namespace: "openwebui-gjc-adapter", id: source.principalId },
			capability: "session.fork",
			requestKey: source.requestKey,
			target: {
				sourceSessionId: source.sessionId,
				cwd: target.canonicalWorkspace,
			},
			timeoutMs: expect.any(Number),
		});
		expect(fake.forks[0]!.timeoutMs).toBeGreaterThan(0);
		expect(fake.forks[0]!.timeoutMs).toBeLessThanOrEqual(30_000);
	});

	test("keeps repeated same-key request payloads identical without sending the local operation hash", async () => {
		const fake = new FakeRuntime();
		const flow = createManagedSuccessorFlow(fake.runtime);
		const first = await flow.fork({ source, target, publish: () => undefined });
		const second = await flow.fork({ source, target, publish: () => undefined });
		expect(first.operationHash).toBe(second.operationHash);
		expect(fake.forks.map(request => request.requestKey)).toEqual([source.requestKey, source.requestKey]);
		const { timeoutMs: firstBudget, ...firstRequest } = fake.forks[0]!;
		const { timeoutMs: secondBudget, ...secondRequest } = fake.forks[1]!;
		expect(secondRequest).toEqual(firstRequest);
		for (const budget of [firstBudget, secondBudget]) {
			expect(budget).toBeGreaterThan(0);
			expect(budget).toBeLessThanOrEqual(30_000);
		}
		expect(fake.forks[0]?.target).not.toHaveProperty("operationHash");
		expect(fake.forks[0]?.target).not.toHaveProperty("sourceGeneration");
	});

	test("returns stable opaque fixture capabilities and invalidates them on lease loss and retirement", async () => {
		const fake = new FakeRuntime();
		const original = await fake.acquireAttachment(sourceTenant);
		expect(await fake.acquireAttachment({ ...sourceTenant })).toBe(original);
		expect(original).not.toHaveProperty("attachment");
		expect(original).not.toHaveProperty("send");
		fake.sourceFence = false;
		expect(original.isCurrent()).toBe(false);
		await expect(fake.acquireAttachment({ ...sourceTenant, leaseId: "foreign" })).rejects.toThrow();
		fake.registerTenant(successorAuthority);
		const next = await fake.acquireAttachment(successorAuthority);
		expect(await fake.acquireAttachment({ ...successorAuthority })).toBe(next);
		fake.targetStatus = "retired";
		expect(next.isCurrent()).toBe(false);
		fake.unregisterTenant(successorAuthority);
		expect(next.isCurrent()).toBe(false);
	});

	test("uses a new matching ingress key without changing the source tenant", async () => {
		const fake = new FakeRuntime();
		const flow = createManagedSuccessorFlow(fake.runtime);
		const first = await flow.fork({ source, target, publish: () => undefined });
		const second = await flow.fork({
			source: { ...source, requestKey: "branch-message-8" },
			target: { ...target, requestKey: "branch-message-8" },
			publish: () => undefined,
		});
		expect(second.operationHash).not.toBe(first.operationHash);
		expect(fake.forks.map(request => request.requestKey)).toEqual([source.requestKey, "branch-message-8"]);
	});

	test("does not publish stale or replaced target generations and retires the failed successor", async () => {
		const fake = new FakeRuntime();
		fake.targetStatus = "replaced";
		let published = false;
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target,
				publish: () => {
					published = true;
				},
			}),
		).rejects.toThrow("Managed successor target attachment is not current.");
		expect(published).toBeFalse();
		expect(fake.order).toContain("close");
		expect(fake.closeTargets).toEqual([successor]);
		expect(fake.unregistered).toEqual([
			{ ...sourceTenant, sessionId: successor.sessionId, generation: successor.endpointGeneration },
		]);
	});

	test("does not invoke a pre-cancelled fork", async () => {
		const fake = new FakeRuntime();
		const controller = new AbortController();
		controller.abort();
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target,
				signal: controller.signal,
				publish: () => undefined,
			}),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(fake.forks).toHaveLength(0);
		expect(fake.closeTargets).toHaveLength(0);
	});

	test("rejects a foreign target authority before invoking the public lifecycle", async () => {
		const fake = new FakeRuntime();
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target: { ...target, principalId: "user-b" },
				publish: () => undefined,
			}),
		).rejects.toThrow("tenant authority boundary");
		expect(fake.forks).toHaveLength(0);
		expect(fake.order).toEqual([]);
	});

	test("fails closed when the source tenant fence cannot be reacquired", async () => {
		const fake = new FakeRuntime();
		fake.sourceFence = false;
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({ source, target, publish: () => undefined }),
		).rejects.toThrow("source fence");
		expect(fake.forks).toHaveLength(0);
		expect(fake.closeTargets).toHaveLength(0);
	});

	test("rejects a target request key that differs from the current source ingress", async () => {
		const fake = new FakeRuntime();
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target: { ...target, requestKey: "different-ingress" },
				publish: () => undefined,
			}),
		).rejects.toThrow("request authority changed");
		expect(fake.order).toEqual([]);
	});

	test("treats cancellation after invocation as uncertain until cleanup proves retirement", async () => {
		const fake = new FakeRuntime();
		const controller = new AbortController();
		fake.afterFork = () => controller.abort();
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target,
				signal: controller.signal,
				onAcknowledged: authority => {
					expect(authority).toEqual(successorAuthority);
					fake.order.push("acknowledged");
				},
				publish: () => undefined,
			}),
		).rejects.toMatchObject({
			name: "ManagedSuccessorUncertainError",
			message: "Managed successor invocation outcome is uncertain after cleanup.",
			cause: { code: "gjc_turn_cancelled" },
		});
		expect(fake.order).toContain("close");
		expect(fake.order.indexOf("acknowledged")).toBeLessThan(fake.order.indexOf("close"));
		expect(fake.order.filter(entry => entry === "status:forked-session:9").length).toBe(1);
		expect(fake.unregistered).toHaveLength(1);
	});

	test("treats a lifecycle timeout without returned target identity as uncertain without guessed cleanup", async () => {
		const fake = new FakeRuntime();
		fake.forkFailure = new Error("fork timeout");
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({ source, target, publish: () => undefined }),
		).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(fake.order).not.toContain("close");
		expect(fake.closeTargets).toEqual([]);
	});

	test("reports ambiguous cleanup when exact target retirement is not proven", async () => {
		const fake = new FakeRuntime();
		fake.targetStatus = "unknown";
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({ source, target, publish: () => undefined }),
		).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(fake.order).toContain("close");
		expect(fake.order).toContain("status:forked-session:9");
		expect(fake.unregistered).toEqual([]);
	});

	test("retains the exact persistence error and acknowledged identity without subsequent effects", async () => {
		const fake = new FakeRuntime();
		const failure = new Error("authority fsync failed");
		const error = await createManagedSuccessorFlow(fake.runtime)
			.fork({
				source,
				target,
				onAcknowledged: async authority => {
					expect(authority).toEqual(successorAuthority);
					throw failure;
				},
				publish: () => {
					throw new Error("Publication must not run.");
				},
			})
			.catch(error => error);
		expect(error).toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(error.cause).toBe(failure);
		expect(error.acknowledgedAuthority).toEqual(successorAuthority);
		expect(fake.order).toEqual(["reconcile", "acquire:source-session:4", "fork"]);
		expect(fake.unregistered).toEqual([]);
	});

	test.each(["failed", "foreign"] as const)(
		"rejects %s cleanup acknowledgement even with retired status",
		async mode => {
			const fake = new FakeRuntime();
			const failure = new Error("publication failed");
			fake.closeOutcome =
				mode === "failed"
					? {
							ok: false,
							operation: "session.close",
							certainty: "uncertain",
							error: { code: "failed", message: "failed" },
						}
					: { ok: true, operation: "session.close", result: { sessionId: "foreign" } };
			const error = await createManagedSuccessorFlow(fake.runtime)
				.fork({
					source,
					target,
					publish: () => {
						throw failure;
					},
				})
				.catch(error => error);
			expect(error).toBeInstanceOf(ManagedSuccessorUncertainError);
			expect(error.cause).toBeInstanceOf(AggregateError);
			expect(error.cause.errors[0]).toBe(failure);
			expect(error.cause.errors[1].message).toContain("matching successful close acknowledgement");
			expect(error.cause.errors.some((cause: unknown) => cause instanceof TypeError)).toBe(false);
			expect(fake.targetStatus).toBe("retired");
			expect(fake.unregistered).toEqual([]);
		},
	);

	test("preserves the original publication failure after matching acknowledged retirement", async () => {
		const fake = new FakeRuntime();
		const failure = new Error("publication failed");
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target,
				publish: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(fake.unregistered).toHaveLength(1);
		expect(fake.registered.size).toBe(0);
	});

	test("derives successor tenancy from the authorized target rather than lifecycle metadata", async () => {
		const fake = new FakeRuntime();
		fake.successorPrincipalId = "user-b";
		const result = await createManagedSuccessorFlow(fake.runtime).fork({
			source,
			target,
			publish: () => undefined,
		});
		expect(result.successor.tenant.principalId).toBe(source.principalId);
	});
});

describe("managed successor through real runtime admission", () => {
	test("dispatches a public typed fork under exact tenant admission and acknowledges before target proof", async () => {
		const f = await runtimeFixture();
		try {
			const result = await createManagedSuccessorFlow(f.runtime).fork({
				source,
				target,
				onAcknowledged: authority => {
					expect(authority).toEqual(successorAuthority);
					f.order.push("acknowledged");
				},
				publish: () => {
					f.order.push("publish");
				},
			});
			expect(result.managedAuthority).toEqual(successorAuthority);
			expect(f.forks).toMatchObject([
				{
					actor: { namespace: "openwebui-gjc-adapter", id: source.principalId },
					capability: "session.fork",
					requestKey: source.requestKey,
					target: { sourceSessionId: source.sessionId, cwd: source.canonicalWorkspace },
				},
			]);
			expect(f.forks[0]!.timeoutMs).toBeGreaterThan(0);
			expect(f.forks[0]!.timeoutMs).toBeLessThanOrEqual(30_000);
			expect(f.fenced).toContainEqual(sourceTenant);
			expect(f.order.indexOf("acknowledged")).toBeLessThan(f.order.indexOf("attachment:forked-session"));
			expect(f.order.at(-1)).toBe("publish");
		} finally {
			await f.runtime.dispose();
		}
	});

	test("does not dispatch after the exact source tenant fence is lost", async () => {
		const f = await runtimeFixture();
		try {
			f.allowed = false;
			await expect(
				createManagedSuccessorFlow(f.runtime).fork({ source, target, publish: () => undefined }),
			).rejects.toThrow();
			expect(f.forks).toEqual([]);
			expect(f.closes).toEqual([]);
		} finally {
			await f.runtime.dispose();
		}
	});

	test("waits for durable acknowledgement and retains its failure before target registration", async () => {
		const f = await runtimeFixture();
		let entered!: () => void;
		const acknowledgementEntered = new Promise<void>(resolve => {
			entered = resolve;
		});
		let rejectPersistence!: (reason: Error) => void;
		const persistence = new Promise<void>((_resolve, reject) => {
			rejectPersistence = reject;
		});
		const failure = new Error("authority fsync failed");
		try {
			const turn = createManagedSuccessorFlow(f.runtime)
				.fork({
					source,
					target,
					onAcknowledged: () => {
						entered();
						return persistence;
					},
					publish: () => {
						f.order.push("publish");
					},
				})
				.catch(error => error);
			await acknowledgementEntered;
			expect(f.order).not.toContain("attachment:forked-session");
			expect(f.order).not.toContain("publish");
			rejectPersistence(failure);
			const error = await turn;
			expect(error).toBeInstanceOf(ManagedSuccessorUncertainError);
			expect(error.cause).toBe(failure);
			expect(error.acknowledgedAuthority).toEqual(successorAuthority);
			expect(f.closes).toEqual([]);
			await expect(f.runtime.acquireAttachment(successorAuthority)).rejects.toThrow("not registered");
		} finally {
			await f.runtime.dispose();
		}
	});

	test.each(["failed", "missing-generation", "source-identity"] as const)(
		"does not acknowledge or publish a %s fork result",
		async mode => {
			const f = await runtimeFixture();
			try {
				f.outcome =
					mode === "failed"
						? {
								ok: false,
								operation: "session.fork",
								certainty: "uncertain",
								error: { code: "failed", message: "failed" },
							}
						: {
								ok: true,
								operation: "session.fork",
								result:
									mode === "missing-generation"
										? { sessionId: successor.sessionId }
										: { sessionId: source.sessionId, endpointGeneration: source.generation },
							};
				let acknowledged = false;
				let published = false;
				await expect(
					createManagedSuccessorFlow(f.runtime).fork({
						source,
						target,
						onAcknowledged: () => {
							acknowledged = true;
						},
						publish: () => {
							published = true;
						},
					}),
				).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
				expect(f.forks).toHaveLength(1);
				expect(acknowledged).toBe(false);
				expect(published).toBe(false);
				expect(f.closes).toEqual([]);
			} finally {
				await f.runtime.dispose();
			}
		},
	);

	test("retains cleanup uncertainty without SDK close dispatch when the public incarnation is unavailable", async () => {
		const f = await runtimeFixture();
		const failure = new Error("publication failed");
		try {
			const error = await createManagedSuccessorFlow(f.runtime)
				.fork({
					source,
					target,
					publish: () => {
						throw failure;
					},
				})
				.catch(error => error);
			expect(error).toBeInstanceOf(ManagedSuccessorUncertainError);
			expect(error.acknowledgedAuthority).toEqual(successorAuthority);
			expect(error.cause.errors[0]).toBe(failure);
			expect(error.cause.errors[1]).toMatchObject({ code: "exact_close_authority_unavailable" });
			expect(f.closes).toEqual([]);
			await expect(f.runtime.acquireAttachment(successorAuthority)).resolves.toMatchObject({
				generation: successor.endpointGeneration,
			});
		} finally {
			await f.runtime.dispose();
		}
	});
});

async function runtimeFixture() {
	const state = {
		allowed: true,
		running: false,
		outcome: { ok: true, operation: "session.fork", result: successor } as ForkOutcome,
		order: [] as string[],
		forks: [] as ForkRequest[],
		closes: [] as CloseRequest[],
		fenced: [] as TenantSessionKey[],
	};
	const attachments = [sourceTenant, successorAuthority].map(
		key =>
			({
				sessionId: key.sessionId,
				generation: key.generation,
				isCurrent: () => state.running,
				send: () => undefined,
			}) satisfies router.SessionAttachment,
	);
	const publicRouter: Pick<router.SessionRouter, "start" | "stop" | "reconcile" | "attachment" | "generationStatus"> =
		{
			start: async () => {
				state.running = true;
			},
			stop: async () => {
				state.running = false;
			},
			reconcile: async () => {
				state.order.push("reconcile");
			},
			attachment: (sessionId, generation) => {
				state.order.push(`attachment:${sessionId}`);
				return attachments.find(value => value.sessionId === sessionId && value.generation === generation) ?? null;
			},
			generationStatus: async () => ({
				status: "current",
				evidence: { source: "session_index", observedIndexSeq: 1, evidenceIndexSeq: 1 },
			}),
		};
	const service: Pick<LifecycleService, "fork" | "close"> = {
		fork: async request => {
			state.forks.push(request);
			state.order.push("fork");
			return state.outcome;
		},
		close: async request => {
			state.closes.push(request);
			return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
		},
	};
	const runtime = new ManagedSdkRuntime({
		agentDir: "/test-agent",
		deps: {
			preparedTenantFence: authority =>
				state.allowed &&
				state.running &&
				Object.entries(target).every(([field, value]) => Reflect.get(authority, field) === value),
			tenantFence: key => {
				state.fenced.push(key);
				return (
					state.allowed &&
					[sourceTenant, successorAuthority].some(expected =>
						Object.entries(sourceTenant).every(
							([field]) => Reflect.get(key, field) === Reflect.get(expected, field),
						),
					)
				);
			},
			createLifecycleService: () => service as LifecycleService,
			createRouter: () => publicRouter as router.SessionRouter,
		},
	});
	runtime.registerTenant(sourceTenant);
	await runtime.start();
	return Object.assign(state, { runtime });
}

class FakeRuntime {
	readonly order: string[] = [];
	readonly forks: ForkRequest[] = [];
	readonly closeTargets: CloseRequest["target"][] = [];
	readonly unregistered: TenantSessionKey[] = [];
	readonly registered = new Map<string, TenantSessionKey>();
	readonly #attachments = new Map<string, ManagedSdkAttachment>();
	targetStatus: "current" | "retired" | "replaced" | "unknown" = "current";
	successorPrincipalId = source.principalId;
	afterFork: (() => void) | undefined;
	forkFailure: Error | undefined;
	closeOutcome: CloseOutcome = { ok: true, operation: "session.close", result: { sessionId: successor.sessionId } };
	sourceFence = true;
	afterPhase: ((phase: string) => Promise<void>) | undefined;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {
		this.order.push("reconcile");
		await this.afterPhase?.("reconcile");
	}
	async acquireAttachment(key: TenantSessionKey) {
		this.order.push(`acquire:${key.sessionId}:${key.generation}`);
		await this.afterPhase?.(`acquire:${key.sessionId}:${key.generation}`);
		if (key.sessionId === source.sessionId && !this.sourceFence) throw new Error("source fence was lost");
		const registered =
			key.sessionId === source.sessionId ? sourceTenant : this.registered.get(`${key.sessionId}:${key.generation}`);
		if (registered === undefined) throw new Error("Returned successor was not registered.");
		if (tenantIdentity(key) !== tenantIdentity(registered)) throw new Error("Fixture tenant authority changed.");
		return this.attachmentFor(key);
	}
	async generationStatus(key: { sessionId: string; generation: number }) {
		this.order.push(`status:${key.sessionId}:${key.generation}`);
		await this.afterPhase?.(`status:${key.sessionId}:${key.generation}`);
		return { status: key.sessionId === source.sessionId ? "current" : this.targetStatus };
	}
	registerTenant(key: TenantSessionKey) {
		this.order.push(`register:${key.sessionId}:${key.generation}`);
		this.registered.set(`${key.sessionId}:${key.generation}`, key);
	}
	unregisterTenant(key: TenantSessionKey) {
		this.order.push(`unregister:${key.sessionId}:${key.generation}`);
		this.unregistered.push(key);
		this.registered.delete(`${key.sessionId}:${key.generation}`);
		this.#attachments.delete(tenantIdentity(key));
		if (key.sessionId === source.sessionId) this.sourceFence = false;
	}
	async registerLifecycleTenant(key: TenantSessionKey) {
		this.registerTenant(key);
		await this.afterPhase?.("register");
		return this.attachmentFor(key);
	}
	async proveLifecycleTenant(key: TenantSessionKey) {
		this.registerTenant(key);
		await this.afterPhase?.("adopt");
		return this.attachmentFor(key);
	}
	private attachmentFor(key: TenantSessionKey): ManagedSdkAttachment {
		const identity = tenantIdentity(key);
		let token = this.#attachments.get(identity);
		if (token === undefined) {
			const tenant = Object.freeze({ ...key });
			const issued: ManagedSdkAttachment = Object.freeze({
				tenant,
				generation: tenant.generation,
				isCurrent: () =>
					this.#attachments.get(identity) === issued &&
					(tenant.sessionId === source.sessionId
						? this.sourceFence
						: this.targetStatus === "current" &&
							tenantIdentity(this.registered.get(`${tenant.sessionId}:${tenant.generation}`)) === identity),
			});
			token = issued;
			this.#attachments.set(identity, token);
		}
		return token;
	}
	async forkLifecycleSession(tenant: TenantSessionKey, request: ForkRequest) {
		expect(tenant).toEqual(sourceTenant);
		this.order.push("fork");
		this.forks.push(request);
		await this.afterPhase?.("fork");
		this.afterFork?.();
		if (this.forkFailure !== undefined) throw this.forkFailure;
		return {
			ok: true,
			operation: "session.fork",
			result: {
				sessionId: successor.sessionId,
				endpointGeneration: successor.endpointGeneration,
				principalId: this.successorPrincipalId,
			},
		};
	}
	async closeLifecycleSession(tenant: TenantSessionKey, request: CloseRequest): Promise<CloseOutcome> {
		expect(tenant).toMatchObject({ sessionId: successor.sessionId, generation: successor.endpointGeneration });
		this.order.push("close");
		this.closeTargets.push(request.target);
		if (this.targetStatus !== "unknown") this.targetStatus = "retired";
		await this.afterPhase?.("close");
		return this.closeOutcome;
	}
}

function tenantIdentity(key: TenantSessionKey | undefined): string {
	return JSON.stringify(
		key === undefined
			? null
			: [
					key.principalId,
					key.projectId,
					key.canonicalWorkspace,
					key.chatId,
					key.sessionId,
					key.generation,
					key.leaseId,
					key.epoch,
				],
	);
}
