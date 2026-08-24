import { describe, expect, test } from "bun:test";
import type { router } from "@gajae-code/coding-agent/sdk";
import { ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";

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

function fixture(options: { start?: () => Promise<void>; fence?: () => boolean; maxFrames?: number } = {}) {
	let onFrame:
		| ((attachment: router.SessionAttachment, frame: router.SessionRouterFrame) => Promise<void> | void)
		| undefined;
	const attachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const calls: string[] = [];
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
			createLifecycleService: () => ({}) as never,
			tenantFence: () => options.fence?.() ?? true,
			...(options.maxFrames === undefined ? {} : { maxFramesPerSubscription: options.maxFrames }),
		},
	});
	return {
		runtime,
		attachment,
		calls,
		emit: async (frame: router.SessionRouterFrame) => await onFrame?.(attachment, frame),
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
});
