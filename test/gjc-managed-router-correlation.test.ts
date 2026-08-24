import { describe, expect, test } from "bun:test";
import type { router } from "@gajae-code/coding-agent/sdk";
import { ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import { createManagedSessionOperations } from "../src/live/gjc-managed-session-operations";

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

const authority: ManagedTurnAuthority = {
	...tenant,
	requestKey: "request-1",
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

function frame(input: {
	seq: number;
	commandId?: string;
	turnId?: string;
	generation?: number;
	id: string;
	text: string;
}): router.SessionRouterFrame {
	return {
		body: { type: "message_update", id: input.id, text: input.text },
		name: "event",
		sessionId: tenant.sessionId,
		generation: input.generation ?? tenant.generation,
		seq: input.seq,
		...(input.commandId === undefined ? {} : { commandId: input.commandId }),
		...(input.turnId === undefined ? {} : { turnId: input.turnId }),
	};
}

class RouterHarness {
	readonly attachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	readonly requests: Record<string, unknown>[] = [];
	readonly promptStarted = deferred<void>();
	readonly promptResponse = deferred<Record<string, unknown>>();
	readonly abortResponse = deferred<Record<string, unknown>>();
	#onFrame:
		| ((attachment: router.SessionAttachment, frame: router.SessionRouterFrame) => Promise<void> | void)
		| undefined;
	#promptStarted = false;

	createRouter = (options: router.SessionRouterOptions): router.SessionRouter => {
		this.#onFrame = options.deps?.onFrame;
		return {
			start: async () => undefined,
			stop: async () => undefined,
			reconcile: async () => undefined,
			attachment: (sessionId: string, generation?: number) =>
				sessionId === tenant.sessionId && generation === tenant.generation ? this.attachment : null,
			request: async (
				_sessionId: string,
				request: Record<string, unknown>,
				_generation?: number,
				_expected?: router.SessionAttachment,
				options?: { beforeDispatch?: (context: never) => void; onDispatch?: (context: never) => void },
			) => {
				options?.beforeDispatch?.({} as never);
				this.requests.push(request);
				options?.onDispatch?.({} as never);
				if (request.operation === "turn.abort") return await this.abortResponse.promise;
				if (!this.#promptStarted) {
					this.#promptStarted = true;
					this.promptStarted.resolve();
				}
				return await this.promptResponse.promise;
			},
			generationStatus: async () => ({
				status: "current" as const,
				evidence: { source: "session_index" as const, observedIndexSeq: 1, evidenceIndexSeq: 1 },
			}),
		} as unknown as router.SessionRouter;
	};

	async emit(observed: router.SessionRouterFrame): Promise<void> {
		if (this.#onFrame === undefined) throw new Error("Router frame handler was not installed.");
		await this.#onFrame(this.attachment, observed);
	}
}

async function fixture() {
	const harness = new RouterHarness();
	const runtime = new ManagedSdkRuntime({
		agentDir: "/agent",
		deps: {
			createRouter: harness.createRouter,
			createLifecycleService: () => ({}) as never,
		},
	});
	runtime.registerTenant(tenant);
	await runtime.start();
	return { harness, runtime, operations: createManagedSessionOperations(runtime) };
}

describe("managed Router acknowledgement correlation", () => {
	test("replays a host-correlated pre-response frame, drains the terminal frame, and classifies duplicate, late, and foreign generations", async () => {
		const current = await fixture();
		const releaseTerminal = deferred<void>();
		const observed: string[] = [];
		const turn = current.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "hello",
			observer: async event => {
				observed.push(String(event.id));
				if (event.id === "terminal") await releaseTerminal.promise;
			},
		});
		await current.harness.promptStarted.promise;
		const correlation = { commandId: "host-command", turnId: "host-turn" };
		await current.harness.emit(frame({ ...correlation, seq: 1, id: "buffered", text: "before response" }));
		expect(observed).toEqual([]);
		expect(current.harness.requests).toEqual([
			{
				type: "control_request",
				operation: "turn.prompt",
				input: { text: "hello" },
				idempotencyKey: authority.requestKey,
			},
		]);
		current.harness.promptResponse.resolve({
			type: "control_response",
			ok: true,
			result: { correlation },
		});
		await Promise.resolve();
		await current.harness.emit(frame({ ...correlation, seq: 2, id: "terminal", text: "after response" }));
		await current.harness.emit(frame({ ...correlation, seq: 2, id: "duplicate", text: "duplicate" }));
		await current.harness.emit(frame({ ...correlation, generation: 8, seq: 3, id: "foreign", text: "foreign" }));
		let settled = false;
		void turn.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseTerminal.resolve();
		await expect(turn).resolves.toMatchObject({
			text: "before responseafter response",
			events: [
				{ id: "buffered", text: "before response" },
				{ id: "terminal", text: "after response" },
			],
		});
		await current.harness.emit(frame({ ...correlation, seq: 4, id: "late", text: "late" }));
		expect(observed).toEqual(["buffered", "terminal"]);
		expect(current.runtime.frameDiagnostics()).toMatchObject({ duplicate: 1, foreign: 1, late: 1 });
		await current.runtime.dispose();
	});

	test("cancels after dispatch through Router while retaining host-only acknowledgement correlation", async () => {
		const current = await fixture();
		const controller = new AbortController();
		const turn = current.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "cancel me",
			signal: controller.signal,
		});
		await current.harness.promptStarted.promise;
		await current.harness.emit(
			frame({ commandId: "host-command", turnId: "host-turn", seq: 1, id: "buffered", text: "before cancellation" }),
		);
		controller.abort();
		current.harness.abortResponse.resolve({ type: "control_response", ok: true, result: {} });
		current.harness.promptResponse.resolve({
			type: "control_response",
			ok: true,
			result: { correlation: { commandId: "host-command", turnId: "host-turn" } },
		});
		await expect(turn).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(current.harness.requests).toEqual([
			{
				type: "control_request",
				operation: "turn.prompt",
				input: { text: "cancel me" },
				idempotencyKey: authority.requestKey,
			},
			{
				type: "control_request",
				operation: "turn.abort",
				input: { mode: "terminal", scope: "turn" },
				idempotencyKey: authority.requestKey,
			},
		]);
		await current.runtime.dispose();
	});
});
