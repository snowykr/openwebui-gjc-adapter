import { describe, expect, test } from "bun:test";
import type { router } from "@gajae-code/coding-agent/sdk";
import { ManagedSdkRuntime, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import { createManagedSessionOperations } from "../src/live/gjc-managed-session-operations";
import { pendingWorkflowGateFromEvent } from "../src/projection/workflow-gates";

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
	body?: Record<string, unknown>;
}): router.SessionRouterFrame {
	return {
		body: input.body ?? { type: "message_update", id: input.id, text: input.text },
		name: "event",
		sessionId: tenant.sessionId,
		generation: input.generation ?? tenant.generation,
		seq: input.seq,
		...(input.commandId === undefined ? {} : { commandId: input.commandId }),
		...(input.turnId === undefined ? {} : { turnId: input.turnId }),
	};
}

class RouterHarness {
	current = true;
	readonly attachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => this.current,
		send: () => undefined,
	} as router.SessionAttachment;
	readonly requests: Record<string, unknown>[] = [];
	readonly promptStarted = deferred<void>();
	readonly promptResponse = deferred<Record<string, unknown>>();
	readonly abortResponse = deferred<Record<string, unknown>>();
	readonly abortStarted = deferred<void>();
	readonly gateQueryStarted = deferred<void>();
	readonly gateResponse = deferred<readonly unknown[]>();
	baseline: readonly unknown[] = [];
	baselineResponse: Promise<readonly unknown[]> | undefined;
	queries = 0;
	beforePromptDispatch: (() => void) | undefined;
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
				if (request.type === "query_request") {
					this.queries += 1;
					if (this.queries === 1)
						return queryResponse(
							this.baselineResponse === undefined ? this.baseline : await this.baselineResponse,
						);
					this.gateQueryStarted.resolve();
					return queryResponse(await this.gateResponse.promise);
				}
				if (request.operation !== "turn.abort") this.beforePromptDispatch?.();
				options?.beforeDispatch?.({} as never);
				this.requests.push(request);
				options?.onDispatch?.({} as never);
				if (request.operation === "turn.abort") {
					this.abortStarted.resolve();
					return await this.abortResponse.promise;
				}
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
	test("replays host-correlated streaming but waits for a real delayed terminal after acknowledgement", async () => {
		const current = await fixture();
		const releaseTerminal = deferred<void>();
		const bufferedObserved = deferred<void>();
		const terminalObserved = deferred<void>();
		const observed: string[] = [];
		const turn = current.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "hello",
			observer: async event => {
				observed.push(String(event.id));
				if (event.id === "buffered") bufferedObserved.resolve();
				if (event.id === "terminal") {
					terminalObserved.resolve();
					await releaseTerminal.promise;
				}
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
		await bufferedObserved.promise;
		let settled = false;
		void turn.then(() => {
			settled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		await current.harness.emit(frame({ ...correlation, seq: 2, id: "update", text: "after response" }));
		await current.harness.emit(frame({ ...correlation, seq: 2, id: "duplicate", text: "duplicate" }));
		await current.harness.emit(frame({ ...correlation, generation: 8, seq: 3, id: "foreign", text: "foreign" }));
		await current.harness.emit(terminalFrame(3, "authoritative final"));
		await terminalObserved.promise;
		expect(settled).toBe(false);
		releaseTerminal.resolve();
		await expect(turn).resolves.toMatchObject({
			text: "authoritative final",
			events: [
				{ id: "buffered", text: "before response" },
				{ id: "update", text: "after response" },
				{ id: "terminal", type: "agent_end", payload: { finalText: "authoritative final" } },
			],
		});
		await current.harness.emit(frame({ ...correlation, seq: 4, id: "late", text: "late" }));
		expect(observed).toEqual(["buffered", "update", "terminal"]);
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
		await current.harness.abortStarted.promise;
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

	test("does not accept idle, finalized text, session-only, conflicting or unrelated pre-ack terminals", async () => {
		const current = await fixture();
		const observed: string[] = [];
		const turn = current.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "hello",
			timeoutMs: 1_000,
			observer: event => {
				observed.push(event.type);
			},
		});
		await current.harness.promptStarted.promise;
		await current.harness.emit({ ...terminalFrame(1, "old"), commandId: "old-command", turnId: "old-turn" });
		current.harness.promptResponse.resolve(
			acknowledgement({ finalizedAssistantText: "not terminal", text: "not terminal" }),
		);
		await current.harness.emit({ ...terminalFrame(2, "session-only"), commandId: undefined, turnId: undefined });
		await current.harness.emit({ ...terminalFrame(3, "wrong turn"), turnId: "other-turn" });
		await current.harness.emit(eventFrame(4, { type: "agent_end", commandId: "foreign", finalText: "bad" }));
		await current.harness.emit(
			eventFrame(5, { type: "agent_end", correlation: { turnId: "foreign" }, finalText: "bad" }),
		);
		await current.harness.emit(eventFrame(6, { type: "session_idle" }));
		await current.harness.emit(
			eventFrame(7, { type: "turn_stream", phase: "finalized", finalAnswer: true, text: "not enough" }),
		);
		let settled = false;
		void turn.then(() => {
			settled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		await current.harness.emit(terminalFrame(8, ""));
		await expect(turn).resolves.toMatchObject({ text: "", rawFrameCursor: 8 });
		expect(observed.filter(type => type === "agent_end")).toHaveLength(1);
		await current.runtime.dispose();
	});

	test("rejects failed terminals with the typed SDK failure, not successful assistant text", async () => {
		const current = await fixture();
		const turn = current.operations.prompt({ authority, operation: "turn.prompt", text: "fail", timeoutMs: 1_000 });
		await current.harness.promptStarted.promise;
		current.harness.promptResponse.resolve(acknowledgement());
		await current.harness.emit(eventFrame(1, { type: "agent_failed", error: { message: "provider failure" } }));
		await expect(turn).rejects.toMatchObject({
			name: "ManagedSdkOperationError",
			code: "prompt_failed",
			message: "provider failure",
		});
		await current.runtime.dispose();
	});

	test("requires complete nonempty acknowledgement correlation and terminal finalText", async () => {
		for (const result of [
			{},
			{ commandId: "host-command" },
			{ turnId: "host-turn" },
			{ commandId: "", turnId: "host-turn" },
			{ publicationId: "publication-only" },
			{ commandId: "host-command", turnId: "host-turn", sessionId: "foreign" },
		]) {
			const current = await fixture();
			const turn = current.operations.prompt({
				authority,
				operation: "turn.prompt",
				text: "invalid",
				timeoutMs: 1_000,
			});
			await current.harness.promptStarted.promise;
			current.harness.promptResponse.resolve({ type: "control_response", ok: true, result });
			await expect(turn).rejects.toMatchObject({ code: "invalid_result" });
			await current.runtime.dispose();
		}
		const current = await fixture();
		const turn = current.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "invalid",
			timeoutMs: 1_000,
		});
		await current.harness.promptStarted.promise;
		current.harness.promptResponse.resolve(acknowledgement({ finalizedAssistantText: "no fallback" }));
		await current.harness.emit(eventFrame(1, { type: "agent_end" }));
		await expect(turn).rejects.toMatchObject({ code: "invalid_result" });
		await current.runtime.dispose();
	});

	test("resolves a real unique durable ask gate and accumulates repeated nested text deltas in order", async () => {
		const current = await fixture();
		current.harness.baseline = [{ gate_id: "old" }];
		const turn = current.operations.prompt({ authority, operation: "turn.prompt", text: "ask", timeoutMs: 1_000 });
		await current.harness.promptStarted.promise;
		current.harness.promptResponse.resolve(acknowledgement());
		await current.harness.emit(
			eventFrame(1, {
				type: "message_update",
				id: "message",
				assistantMessageEvent: { type: "text_delta", delta: "echo " },
			}),
		);
		await current.harness.emit(
			eventFrame(2, {
				type: "message_update",
				id: "message",
				assistantMessageEvent: { type: "text_delta", text: "echo " },
			}),
		);
		await current.harness.emit(
			eventFrame(3, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } }),
		);
		await current.harness.emit(askFrame(4));
		await current.harness.gateQueryStarted.promise;
		const gate = {
			gate_id: "durable-gate",
			status: "pending",
			schema_hash: "schema-1",
			schema: { type: "string" },
			context: { prompt: "Choose the durable option" },
			...hostCorrelation,
			sessionId: authority.sessionId,
		};
		current.harness.gateResponse.resolve([{ gate_id: "old" }, gate]);
		const result = await turn;
		expect(result.text).toBe("echo echo ");
		const event = result.events.at(-1)!;
		expect(event).toMatchObject({ type: "workflow_gate", id: "durable-gate", payload: gate });
		expect(event.payload).not.toHaveProperty("summary");
		expect(pendingWorkflowGateFromEvent(event)).toMatchObject({
			gateId: "durable-gate",
			status: "pending",
			schemaHash: "schema-1",
			...hostCorrelation,
			sessionId: authority.sessionId,
		});
		expect(current.harness.queries).toBe(2);
		await current.runtime.dispose();
	});

	test("ignores old, partial, foreign and empty gate results; terminal wins while lookup hangs", async () => {
		for (const mode of ["empty", "old", "foreign", "partial", "hanging"] as const) {
			const current = await fixture();
			current.harness.baseline = [{ gate_id: "durable-gate" }];
			const turn = current.operations.prompt({ authority, operation: "turn.prompt", text: "ask", timeoutMs: 1_000 });
			await current.harness.promptStarted.promise;
			current.harness.promptResponse.resolve(acknowledgement());
			await current.harness.emit(askFrame(1));
			await current.harness.gateQueryStarted.promise;
			if (mode !== "hanging")
				current.harness.gateResponse.resolve(
					mode === "empty"
						? []
						: [
								{
									gate_id: "durable-gate",
									...(mode === "foreign"
										? { ...hostCorrelation, sessionId: "foreign" }
										: mode === "partial"
											? { sessionId: authority.sessionId }
											: {}),
								},
							],
				);
			await current.harness.emit(terminalFrame(2, `terminal ${mode}`));
			const result = await turn;
			expect(result.text).toBe(`terminal ${mode}`);
			expect(result.events.some(event => event.type === "workflow_gate")).toBe(false);
			current.harness.gateResponse.resolve([]);
			await current.runtime.dispose();
		}
	});

	test("accepts a baseline gate only with explicit current correlation and rejects ambiguous gates", async () => {
		const current = await fixture();
		current.harness.baseline = [{ gate_id: "durable-gate" }];
		const turn = current.operations.prompt({ authority, operation: "turn.prompt", text: "ask", timeoutMs: 1_000 });
		await current.harness.promptStarted.promise;
		current.harness.promptResponse.resolve(acknowledgement());
		await current.harness.emit(askFrame(1));
		await current.harness.gateQueryStarted.promise;
		current.harness.gateResponse.resolve([
			{ gate_id: "durable-gate", ...hostCorrelation, sessionId: authority.sessionId, schema: { type: "string" } },
		]);
		expect((await turn).events.at(-1)?.type).toBe("workflow_gate");
		await current.runtime.dispose();
		const ambiguous = await fixture();
		const rejected = ambiguous.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "ask",
			timeoutMs: 1_000,
		});
		await ambiguous.harness.promptStarted.promise;
		ambiguous.harness.promptResponse.resolve(acknowledgement());
		await ambiguous.harness.emit(eventFrame(1, { type: "action_needed", kind: "ask", id: "ask" }));
		await ambiguous.harness.gateQueryStarted.promise;
		ambiguous.harness.gateResponse.resolve([{ gate_id: "one" }, { gate_id: "two" }]);
		await expect(rejected).rejects.toMatchObject({ code: "invalid_result" });
		await ambiguous.runtime.dispose();
	});

	test("times out an acknowledged turn without public terminal evidence and closes observation", async () => {
		const current = await fixture();
		const observed: string[] = [];
		const turn = current.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "timeout",
			timeoutMs: 40,
			observer: event => {
				observed.push(event.type);
			},
		});
		await current.harness.promptStarted.promise;
		current.harness.promptResponse.resolve(acknowledgement({ text: "not proof" }));
		await expect(turn).rejects.toMatchObject({ code: "timeout" });
		await current.harness.emit(terminalFrame(1, "late"));
		expect(observed).toEqual([]);
		expect(current.runtime.frameDiagnostics().late).toBe(1);
		await current.runtime.dispose();
	});

	test("bounds baseline and gate lookup with the same finite turn deadline", async () => {
		const before = await fixture();
		const releaseBaseline = deferred<readonly unknown[]>();
		before.harness.baselineResponse = releaseBaseline.promise;
		await expect(
			before.operations.prompt({ authority, operation: "turn.prompt", text: "baseline", timeoutMs: 40 }),
		).rejects.toMatchObject({ code: "timeout" });
		releaseBaseline.resolve([]);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(before.harness.requests).toHaveLength(0);
		await before.runtime.dispose();
		const after = await fixture();
		const turn = after.operations.prompt({ authority, operation: "turn.prompt", text: "ask", timeoutMs: 100 });
		await after.harness.promptStarted.promise;
		after.harness.promptResponse.resolve(acknowledgement());
		await after.harness.emit(askFrame(1));
		await after.harness.gateQueryStarted.promise;
		await expect(turn).rejects.toMatchObject({ code: "timeout" });
		after.harness.gateResponse.resolve([{ gate_id: "durable-gate" }]);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(after.harness.queries).toBe(2);
		await after.runtime.dispose();
	});

	test("pre-dispatch cancellation sends no abort and post-ack cancellation does not await abort acknowledgement", async () => {
		const before = await fixture();
		const pre = new AbortController();
		before.harness.beforePromptDispatch = () => pre.abort();
		await expect(
			before.operations.prompt({
				authority,
				operation: "turn.prompt",
				text: "cancel",
				signal: pre.signal,
				timeoutMs: 1_000,
			}),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(before.harness.requests).toHaveLength(0);
		await before.runtime.dispose();
		const after = await fixture();
		const post = new AbortController();
		const observed = deferred<void>();
		const turn = after.operations.prompt({
			authority,
			operation: "turn.prompt",
			text: "cancel",
			signal: post.signal,
			timeoutMs: 1_000,
			observer: () => {
				observed.resolve();
			},
		});
		await after.harness.promptStarted.promise;
		after.harness.promptResponse.resolve(acknowledgement());
		await after.harness.emit(eventFrame(1, { type: "agent_start" }));
		await observed.promise;
		post.abort();
		post.abort();
		await expect(turn).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		await after.harness.abortStarted.promise;
		expect(after.harness.requests.filter(request => request.operation === "turn.abort")).toHaveLength(1);
		after.harness.abortResponse.resolve({ type: "control_response", ok: true, result: {} });
		await after.runtime.dispose();
	});

	test("observer failures, stuck observers, shutdown and lost attachment cannot publish or hang", async () => {
		for (const mode of ["throw", "stuck", "shutdown", "attachment"] as const) {
			const current = await fixture();
			const observerEntered = deferred<void>();
			const releaseObserver = deferred<void>();
			const turn = current.operations.prompt({
				authority,
				operation: "turn.prompt",
				text: mode,
				timeoutMs: mode === "stuck" ? 40 : 1_000,
				observer: async () => {
					observerEntered.resolve();
					if (mode === "throw") throw new Error("observer failed");
					if (mode === "stuck") await releaseObserver.promise;
				},
			});
			await current.harness.promptStarted.promise;
			current.harness.promptResponse.resolve(acknowledgement());
			await current.harness.emit(eventFrame(1, { type: "agent_start" }));
			await observerEntered.promise;
			if (mode === "shutdown") await current.runtime.dispose();
			if (mode === "attachment") current.harness.current = false;
			if (mode === "throw") await expect(turn).rejects.toThrow("observer failed");
			else if (mode === "stuck") await expect(turn).rejects.toMatchObject({ code: "timeout" });
			else await expect(turn).rejects.toThrow("attachment");
			releaseObserver.resolve();
			await current.runtime.dispose();
		}
	});
});

const hostCorrelation = { commandId: "host-command", turnId: "host-turn" };
function acknowledgement(extra: Record<string, unknown> = {}) {
	return { type: "control_response", ok: true, result: { accepted: true, ...hostCorrelation, ...extra } };
}
function queryResponse(items: readonly unknown[]) {
	return { type: "query_response", ok: true, page: { items, complete: true } };
}
function eventFrame(seq: number, body: Record<string, unknown>): router.SessionRouterFrame {
	return frame({ ...hostCorrelation, seq, id: "", text: "", body });
}
function terminalFrame(seq: number, finalText: string): router.SessionRouterFrame {
	return eventFrame(seq, {
		type: "agent_end",
		id: "terminal",
		sessionId: authority.sessionId,
		...hostCorrelation,
		finalText,
		outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
	});
}
function askFrame(seq: number): router.SessionRouterFrame {
	return eventFrame(seq, {
		type: "action_needed",
		id: "ask-1",
		kind: "ask",
		workflowGateId: "durable-gate",
		summary: "Not a durable gate payload",
	});
}
