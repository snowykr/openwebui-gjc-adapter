import { describe, expect, test } from "bun:test";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import { ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";

type CloseRequest = Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0];

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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function closeRequest(): CloseRequest {
	return {
		actor: { id: tenant.principalId, namespace: "adapter" },
		capability: "session.close",
		requestKey: "close-1",
		target: {
			sessionId: tenant.sessionId,
			endpointGeneration: tenant.generation,
			// Synthetic authority for boundary tests, not obtainable from SDK 0.16.4 public results.
			endpointIncarnation: "0123456789abcdef".repeat(4),
		},
		timeoutMs: 500,
	};
}

function fixture(
	options: { start?: () => Promise<void>; fence?: () => boolean | Promise<boolean>; maxFrames?: number } = {},
) {
	let onFrame:
		| ((attachment: router.SessionAttachment, frame: router.SessionRouterFrame) => Promise<void> | void)
		| undefined;
	const attachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const foreignAttachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const calls: string[] = [];
	const closeCalls: CloseRequest[] = [];
	const lifecycleService: Pick<ReturnType<typeof lifecycle.createSessionLifecycleService>, "close"> = {
		async close(request) {
			closeCalls.push(request);
			return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
		},
	};
	const sessionRouter = {
		async start() {
			calls.push("start");
			await options.start?.();
		},
		async stop() {
			calls.push("stop");
		},
		async reconcile() {
			calls.push("reconcile");
		},
		attachment(sessionId: string, generation?: number) {
			return sessionId === tenant.sessionId && generation === tenant.generation ? attachment : null;
		},
		async request(
			_sessionId: string,
			_frame: Record<string, unknown>,
			_generation: number,
			_expected: router.SessionAttachment,
			requestOptions?: { beforeDispatch?: (context: never) => void; onDispatch?: (context: never) => void },
		) {
			requestOptions?.beforeDispatch?.({} as never);
			calls.push("request");
			requestOptions?.onDispatch?.({} as never);
			return { ok: true };
		},
		async generationStatus() {
			return {
				status: "retired",
				evidence: { source: "session_index", observedIndexSeq: 1, evidenceIndexSeq: 1, event: "session_closed" },
			};
		},
	} as unknown as router.SessionRouter;
	const runtime = new ManagedSdkRuntime({
		agentDir: "/agent",
		deps: {
			createRouter: input => {
				onFrame = input.deps?.onFrame;
				return sessionRouter;
			},
			createLifecycleService: () => lifecycleService as ReturnType<typeof lifecycle.createSessionLifecycleService>,
			tenantFence: () => options.fence?.() ?? true,
			...(options.maxFrames === undefined ? {} : { maxFramesPerSubscription: options.maxFrames }),
		},
	});
	return {
		runtime,
		attachment,
		foreignAttachment,
		calls,
		closeCalls,
		emit: async (frame: router.SessionRouterFrame, sourceAttachment = attachment) =>
			await onFrame?.(sourceAttachment, frame),
	};
}

describe("managed SDK runtime", () => {
	test("shares start/stop races, admits bootstrap only while starting, and records start failure", async () => {
		const startGate = deferred<void>();
		const active = fixture({ start: async () => await startGate.promise });
		active.runtime.registerTenant(tenant);
		const firstStart = active.runtime.start();
		expect(active.runtime.start()).toBe(firstStart);
		expect(active.runtime.bootstrapAdmissionOpen).toBe(true);
		await expect(active.runtime.acquireAttachment(tenant)).resolves.toMatchObject({ generation: 7 });
		const stopping = active.runtime.stop();
		expect(active.runtime.bootstrapAdmissionOpen).toBe(false);
		startGate.resolve();
		await Promise.all([firstStart, stopping]);
		expect(active.runtime.state).toBe("stopped");
		expect(active.calls).toEqual(["start", "stop"]);

		const failed = fixture({
			start: async () => {
				throw new Error("start failed");
			},
		});
		await expect(failed.runtime.start()).rejects.toThrow("start failed");
		expect(failed.runtime.state).toBe("failed");
	});

	test("requires full registered tenant fencing, exact positive generation, and a current attachment", async () => {
		const current = fixture();
		await current.runtime.start();
		await expect(current.runtime.acquireAttachment(tenant)).rejects.toThrow("not registered");
		current.runtime.registerTenant(tenant);
		const managed = await current.runtime.acquireAttachment(tenant);
		await expect(current.runtime.acquireAttachment({ ...tenant, generation: 0 })).rejects.toThrow(
			"positive generation",
		);
		await expect(current.runtime.acquireAttachment({ ...tenant, leaseId: "wrong" })).rejects.toThrow(
			"not registered",
		);
		await expect(current.runtime.request({ ...managed, generation: 8 }, {})).rejects.toThrow(
			"Exact tenant generation",
		);
		(current.attachment as unknown as { isCurrent: () => boolean }).isCurrent = () => false;
		await expect(current.runtime.request(managed, {})).rejects.toThrow("Current Router attachment");
		await current.runtime.stop();

		const fenced = fixture({ fence: () => false });
		fenced.runtime.registerTenant(tenant);
		await fenced.runtime.start();
		await expect(fenced.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await fenced.runtime.stop();
	});

	test("reserves one complete tenant for each session generation and rejects foreign boundaries", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		expect(() => current.runtime.registerTenant({ ...tenant, leaseId: "foreign-lease" })).toThrow("already owned");
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const foreign = { ...managed, tenant: { ...tenant, leaseId: "foreign-lease" } };
		await expect(current.runtime.request(foreign, {})).rejects.toThrow("not registered");
		expect(() =>
			current.runtime.subscribeFrames(foreign, "turn", { commandId: "command-foreign" }, () => {}),
		).toThrow("Registered current tenant attachment");
		await current.emit(
			{
				body: {},
				name: "event",
				sessionId: tenant.sessionId,
				generation: tenant.generation,
				commandId: "command-foreign",
				seq: 1,
			},
			current.foreignAttachment,
		);
		expect(current.runtime.frameDiagnostics().foreign).toBe(1);
		await current.runtime.stop();
	});

	test("delegates request settlement solely to Router and preserves dispatch hook order", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const order: string[] = [];
		await expect(
			current.runtime.request(
				managed,
				{ type: "query_request" },
				{
					beforeDispatch: () => order.push("before"),
					onDispatch: () => order.push("after"),
				},
			),
		).resolves.toEqual({ ok: true });
		expect(order).toEqual(["before", "after"]);
		expect(current.calls).toContain("request");
		await current.runtime.stop();
	});

	test("multiplexes only matching frames with duplicate, foreign, overflow, and cleanup classification", async () => {
		const current = fixture({ maxFrames: 1 });
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const received: string[] = [];
		const releaseListener = deferred<void>();
		const unsubscribe = current.runtime.subscribeFrames(managed, "turn", { commandId: "command-1" }, async frame => {
			received.push(String(frame.frame.seq));
			await releaseListener.promise;
		});
		const matching = {
			body: {},
			name: "event",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			commandId: "command-1",
			seq: 1,
		};
		await current.emit(matching);
		await Promise.resolve();
		await current.emit(matching);
		await current.emit({ ...matching, sessionId: "foreign", seq: 2 });
		await current.emit({ ...matching, seq: 3 });
		unsubscribe();
		unsubscribe();
		await current.emit({ ...matching, seq: 4 });
		releaseListener.resolve();
		await Promise.resolve();
		expect(received).toEqual(["1"]);
		expect(current.runtime.frameDiagnostics()).toMatchObject({ duplicate: 1, foreign: 1, overflow: 1, late: 1 });
		await current.runtime.stop();
	});

	test("forwards exact-generation retirement status without retaining credential data", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		await expect(current.runtime.generationStatus(tenant)).resolves.toMatchObject({ status: "retired" });
		expect(JSON.stringify(current.runtime.frameDiagnostics())).not.toContain("token");
		expect(JSON.stringify(current.runtime.frameDiagnostics())).not.toContain("url");
		await current.runtime.dispose();
	});

	test("rejects lifecycle calls without complete managed tenant authority", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		await expect(
			current.runtime.createLifecycleSession({
				actor: { id: tenant.principalId, namespace: "adapter" },
				capability: "session.create",
				requestKey: "create-1",
				target: { cwd: tenant.canonicalWorkspace },
			} as never),
		).rejects.toThrow("Complete managed tenant authority");
		expect("lifecycleService" in current.runtime).toBeFalse();
		await current.runtime.stop();
	});

	test("rejects tenantless close even with paired endpoint authority", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(closeRequest() as never)).rejects.toThrow(
				"Complete managed tenant authority",
			);
			await expect(current.runtime.closeLifecycleSession({ request: closeRequest() } as never)).rejects.toThrow(
				"Complete managed tenant authority",
			);
			await expect(
				current.runtime.closeLifecycleSession({
					...closeRequest(),
					tenant: { sessionId: tenant.sessionId },
				} as never),
			).rejects.toThrow("Complete managed tenant authority");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test("rejects close without registration or with foreign tenant, session, generation, or fence identity", async () => {
		const current = fixture();
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("not registered");
			current.runtime.registerTenant(tenant);
			for (const foreign of [
				{ principalId: "foreign-principal" },
				{ projectId: "foreign-project" },
				{ canonicalWorkspace: "/foreign-workspace" },
				{ chatId: "foreign-chat" },
				{ sessionId: "foreign-session" },
				{ generation: tenant.generation + 1 },
				{ leaseId: "foreign-lease" },
				{ epoch: "foreign-epoch" },
			]) {
				await expect(
					current.runtime.closeLifecycleSession({ ...tenant, ...foreign }, closeRequest()),
				).rejects.toThrow("not registered");
			}
			await expect(
				current.runtime.closeLifecycleSession(tenant, {
					...closeRequest(),
					actor: { id: "foreign-principal", namespace: "adapter" },
				}),
			).rejects.toThrow("Lifecycle actor does not match");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each([
		{ name: "absent target", target: undefined },
		{ name: "empty target", target: {} },
		{
			name: "missing session",
			target: {
				endpointGeneration: tenant.generation,
				endpointIncarnation: closeRequest().target.endpointIncarnation,
			},
		},
		{ name: "foreign session", target: { ...closeRequest().target, sessionId: "foreign-session" } },
		{ name: "session-ID-only", target: { sessionId: tenant.sessionId } },
		{
			name: "incarnation without generation",
			target: { sessionId: tenant.sessionId, endpointIncarnation: closeRequest().target.endpointIncarnation },
		},
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, tenant.generation + 1, String(tenant.generation), null].map(
			generation => ({
				name: `invalid or foreign generation ${generation}`,
				target: { ...closeRequest().target, endpointGeneration: generation },
			}),
		),
	])("rejects close with $name before SDK mutation", async ({ target }) => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(
				current.runtime.closeLifecycleSession(tenant, { ...closeRequest(), target } as never),
			).rejects.toThrow(/target.*(generation|managed tenant authority)/i);
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each([
		undefined,
		null,
		"",
		"a".repeat(63),
		"a".repeat(65),
		"A".repeat(64),
		"g".repeat(64),
		`${"a".repeat(64)}\n`,
		123,
	])(
		"fails closed with an actionable unavailable diagnostic for absent or invalid incarnation %j",
		async endpointIncarnation => {
			const current = fixture();
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			try {
				await expect(
					current.runtime.closeLifecycleSession(tenant, {
						...closeRequest(),
						target: { ...closeRequest().target, endpointIncarnation },
					} as never),
				).rejects.toMatchObject({
					code: "exact_close_authority_unavailable",
					message: expect.stringContaining("SDK 0.16.4 public binding/lifecycle results do not supply it"),
				});
				expect(current.closeCalls).toHaveLength(0);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test.each(["explicit", "wrapped", "flat"] as const)(
		"forwards a supplied opaque pair untouched with %s tenant admission",
		async shape => {
			let fenceChecks = 0;
			const current = fixture({
				fence: () => {
					fenceChecks += 1;
					return true;
				},
			});
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			const request = closeRequest();
			try {
				const outcome =
					shape === "explicit"
						? await current.runtime.closeLifecycleSession(tenant, request)
						: shape === "wrapped"
							? await current.runtime.closeLifecycleSession({ tenant, request })
							: await current.runtime.closeLifecycleSession({ tenant, ...request });
				expect(outcome).toEqual({ ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } });
				expect(fenceChecks).toBe(1);
				expect(current.closeCalls).toEqual([request]);
				expect(current.closeCalls[0]?.target).toBe(request.target);
				if (shape !== "flat") expect(current.closeCalls[0]).toBe(request);
				expect(current.calls).toEqual(["start"]);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test("does not dispatch paired close when the tenant fence is lost", async () => {
		const current = fixture({ fence: () => false });
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each(["fence loss", "unregistration", "registration replacement"] as const)(
		"rejects paired close after %s during authorization",
		async change => {
			const fenceEntered = deferred<void>();
			const fenceResult = deferred<boolean>();
			const current = fixture({
				fence: async () => {
					fenceEntered.resolve();
					return await fenceResult.promise;
				},
			});
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			try {
				const closing = current.runtime.closeLifecycleSession(tenant, closeRequest());
				await fenceEntered.promise;
				expect(current.closeCalls).toHaveLength(0);
				if (change !== "fence loss") current.runtime.unregisterTenant(tenant);
				if (change === "registration replacement")
					current.runtime.registerTenant({ ...tenant, leaseId: "replacement-lease" });
				fenceResult.resolve(change !== "fence loss");
				await expect(closing).rejects.toThrow(change === "fence loss" ? "fence was lost" : "registration changed");
				expect(current.closeCalls).toHaveLength(0);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test("exposes listener failures through subscription drain and diagnostics", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const unsubscribe = current.runtime.subscribeFrames(managed, "turn", { commandId: "command-error" }, () => {
			throw new Error("listener failed");
		});
		await current.emit({
			body: {},
			name: "event",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			commandId: "command-error",
			seq: 1,
		});
		await expect(unsubscribe.drain()).rejects.toThrow("listener failed");
		expect(current.runtime.frameDiagnostics().listenerError).toBe(1);
		unsubscribe();
		await current.runtime.stop();
	});
});
