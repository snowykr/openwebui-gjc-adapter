import { describe, expect, test } from "bun:test";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import { createManagedSessionOperations, ManagedTurnUncertainError } from "../src/live/gjc-managed-session-operations";

const authority: ManagedTurnAuthority = {
	principalId: "principal-1",
	projectId: "project-1",
	canonicalWorkspace: "/workspace/project-1",
	chatId: "chat-1",
	sessionId: "session-1",
	generation: 7,
	leaseId: "lease-1",
	epoch: "epoch-1",
	requestKey: "request-1",
};

describe("managed session operations", () => {
	test("uses external lifecycle adoption, exact tenant authority, public Router envelopes, and bounded pages", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await operations.create({ authority: withoutIdentity(), target: { path: authority.canonicalWorkspace } });
		await operations.resume({ authority, target: { sessionIdOrPrefix: authority.sessionId } });
		await operations.fork({
			authority,
			target: { sourceSessionId: authority.sessionId, cwd: authority.canonicalWorkspace },
		});
		await operations.list({ authority, target: { cwd: authority.canonicalWorkspace } });
		await operations.setModel(authority, { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" });
		await operations.setThinking(authority, "low");
		await expect(operations.query(authority, "models.list/current")).resolves.toEqual(["one", "two"]);
		await expect(operations.getProviders(authority)).resolves.toEqual([]);
		await expect(operations.getBranchCandidates(authority)).resolves.toEqual([]);
		expect(fake.externalLifecycle.map(call => call.operation)).toEqual(["create", "resume"]);
		expect(fake.externalLifecycle[0]?.request).toMatchObject({
			actor: { namespace: "openwebui-gjc-adapter", id: authority.principalId },
			requestKey: authority.requestKey,
			target: { kind: "existing_path", path: authority.canonicalWorkspace },
		});
		expect(fake.registered).toHaveLength(3);
		expect(operations.payloadHash({ z: [2, 1], a: "stable" })).toBe(
			operations.payloadHash({ a: "stable", z: [2, 1] }),
		);
		expect(fake.requests.map(frame => frame.operation ?? frame.query)).toEqual([
			"model.set",
			"thinking.set",
			"models.list/current",
			"models.list/current",
			"providers.list/active",
			"session.branch_candidates",
		]);
		expect(fake.requests[2]?.cursor).toBeUndefined();
		expect(fake.requests[3]?.cursor).toBe("next");
		expect(JSON.stringify(fake)).not.toMatch(/credential|password|endpointIncarnation/i);
	});

	test("keeps logical timeout out of SDK readiness and persists identity before registration", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime, 500);
		const order: string[] = [];
		const register = fake.registerLifecycleTenant.bind(fake);
		fake.registerLifecycleTenant = async (key, outcome) => {
			order.push("register");
			return register(key, outcome);
		};
		await operations.create({
			authority: withoutIdentity(),
			target: { path: authority.canonicalWorkspace },
			onAcknowledged: proof => {
				order.push("acknowledge");
				expect(proof).toMatchObject(authority);
			},
		});
		expect(order).toEqual(["acknowledge", "register"]);
		expect(fake.externalLifecycle[0]?.request).not.toHaveProperty("timeoutMs");
		expect(fake.externalLifecycle[0]?.request).not.toHaveProperty("readinessTimeoutMs");
		expect(fake.externalTimeouts[0]).toBeGreaterThan(0);
		expect(fake.externalTimeouts[0]).toBeLessThanOrEqual(500);
	});

	test("retains failed durable acknowledgement without registration or cleanup effects", async () => {
		const fake = new FakeRuntime();
		const failure = new Error("ack fsync failed");
		await expect(
			createManagedSessionOperations(fake.runtime).create({
				authority: withoutIdentity(),
				target: { path: authority.canonicalWorkspace },
				onAcknowledged: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(fake.registered).toHaveLength(0);
		expect(fake.lifecycle).toHaveLength(0);
	});

	test.each([25, 180_000])(
		"external create and resume keep a %ims logical deadline out of readiness",
		async timeoutMs => {
			const fake = new FakeRuntime();
			const operations = createManagedSessionOperations(fake.runtime, timeoutMs);
			await operations.create({ authority: withoutIdentity(), target: { path: authority.canonicalWorkspace } });
			await operations.resume({ authority, target: { sessionIdOrPrefix: authority.sessionId } });
			expect(fake.externalLifecycle.map(call => call.operation)).toEqual(["create", "resume"]);
			for (const call of fake.externalLifecycle) {
				expect(call.request).not.toHaveProperty("readinessTimeoutMs");
				expect(call.request).not.toHaveProperty("timeoutMs");
			}
			for (const budget of fake.externalTimeouts) {
				expect(budget).toBeGreaterThan(0);
				expect(budget).toBeLessThanOrEqual(timeoutMs);
			}
		},
	);

	test("times out lifecycle invocation and never registers a late result", async () => {
		const fake = new FakeRuntime();
		const gate = deferred<ReturnType<typeof lifecycleSuccess>>();
		fake.createPreparedExternalLifecycleSession = async () => gate.promise;
		await expect(
			createManagedSessionOperations(fake.runtime, 25).create({
				authority: withoutIdentity(),
				target: { path: authority.canonicalWorkspace },
			}),
		).rejects.toMatchObject({ code: "timeout" });
		gate.resolve(lifecycleSuccess());
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.registered).toHaveLength(0);
	});

	test("requires retired exact generation for close or delete and fences unproven retirement", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		fake.status = "retired";
		await expect(operations.close({ authority, target: { sessionId: authority.sessionId } })).resolves.toMatchObject({
			ok: true,
		});
		fake.status = "current";
		await expect(operations.delete({ authority, target: { sessionId: authority.sessionId } })).rejects.toBeInstanceOf(
			ManagedTurnUncertainError,
		);
		fake.status = "unknown";
		await expect(operations.close({ authority, target: { sessionId: authority.sessionId } })).rejects.toBeInstanceOf(
			ManagedTurnUncertainError,
		);
	});

	test("rejects failed and foreign close or delete acknowledgements even when generation is retired", async () => {
		for (const operation of ["close", "delete"] as const) {
			for (const outcome of [
				{ ok: false, certainty: "retryable" },
				{ ok: true },
				{ ok: true, result: { sessionId: "replacement" } },
			]) {
				const fake = new FakeRuntime();
				fake.status = "retired";
				fake.retirementOutcome = outcome;
				const operations = createManagedSessionOperations(fake.runtime);
				await expect(
					operations[operation]({ authority, target: { sessionId: authority.sessionId } }),
				).rejects.toBeInstanceOf(ManagedTurnUncertainError);
			}
		}
	});
	test("rejects incomplete or tenant-mismatched authority before the Router request", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await expect(
			operations.request({ authority: { ...authority, generation: 0 }, operation: "turn.prompt" }),
		).rejects.toThrow("Complete positive");
		fake.rejectTenant = true;
		await expect(operations.request({ authority, operation: "turn.prompt" })).rejects.toThrow("Exact tenant");
		expect(fake.requests).toHaveLength(0);
	});

	test("does not admit a stale generation or changed lease and epoch for Router traffic", async () => {
		for (const candidate of [
			{ generation: authority.generation - 1 },
			{ leaseId: "lease-stale" },
			{ epoch: "epoch-stale" },
		] as const) {
			const fake = new FakeRuntime();
			const operations = createManagedSessionOperations(fake.runtime);
			await expect(
				operations.request({
					authority: { ...authority, ...candidate },
					operation: "turn.prompt",
				}),
			).rejects.toThrow("Exact tenant");
			expect(fake.requests).toHaveLength(0);
		}
	});

	test("uses public terminal abort control_response and never dispatches a pre-cancelled prompt", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await operations.abort({ authority, operation: "ignored" });
		expect(fake.requests[0]).toMatchObject({
			type: "control_request",
			operation: "turn.abort",
			input: { mode: "terminal", scope: "turn" },
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			operations.prompt({ authority, operation: "turn.prompt", text: "no dispatch", signal: controller.signal }),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(fake.requests).toHaveLength(1);
	});

	test("rejects repeated query cursors rather than traversing an unbounded public Router stream", async () => {
		const fake = new FakeRuntime();
		fake.repeatCursor = true;
		await expect(
			createManagedSessionOperations(fake.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("repeated");
	});

	test("bounds public queries to 256 pages and 100000 total items", async () => {
		const pages = new FakeRuntime();
		pages.queryHandler = async (_frame, page) => queryResponse([], `page-${page}`);
		await expect(
			createManagedSessionOperations(pages.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("page bound");
		expect(pages.requests).toHaveLength(256);
		const items = new FakeRuntime();
		items.queryHandler = async (_frame, page) =>
			queryResponse(
				Array.from({ length: 50_001 }, () => "item"),
				page === 1 ? "next" : undefined,
			);
		await expect(
			createManagedSessionOperations(items.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("item bound");
		expect(items.requests).toHaveLength(2);
	});

	test("fails closed on malformed and error query envelopes", async () => {
		for (const response of [
			{ type: "control_response", ok: true, result: {} },
			{ type: "query_response", ok: false, error: { message: "query denied" } },
			{ type: "query_response", ok: true, page: { items: [], complete: false } },
			{ type: "query_response", ok: true, page: { items: [], complete: true, continuationCursor: "unexpected" } },
			{ type: "query_response", ok: true, page: { items: [], complete: false, continuationCursor: "" } },
			{ type: "query_response", ok: true, page: { items: {}, complete: true } },
		]) {
			const fake = new FakeRuntime();
			fake.queryHandler = async () => response;
			await expect(
				createManagedSessionOperations(fake.runtime).query(authority, "models.list/current"),
			).rejects.toThrow();
			expect(fake.requests).toHaveLength(1);
		}
	});

	test("uses one total query deadline rather than renewing the timeout on each page", async () => {
		const fake = new FakeRuntime();
		const releaseSecond = deferred<Record<string, unknown>>();
		fake.queryHandler = async (_frame, page) => {
			if (page === 1) {
				await new Promise(resolve => setTimeout(resolve, 50));
				return queryResponse(["one"], "next");
			}
			return releaseSecond.promise;
		};
		await expect(
			createManagedSessionOperations(fake.runtime).query(authority, "models.list/current", {}, 500),
		).rejects.toMatchObject({ code: "timeout" });
		expect(fake.requests).toHaveLength(2);
		expect(fake.requestTimeouts[1]!).toBeLessThan(fake.requestTimeouts[0]! - 10);
		releaseSecond.resolve(queryResponse(["two"], "must-not-fetch"));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(2);
	});

	test("bounds generic request acquisition and prevents dispatch after expiration", async () => {
		const fake = new FakeRuntime();
		const release = deferred<void>();
		const acquire = fake.acquireAttachment.bind(fake);
		fake.acquireAttachment = async key => {
			await release.promise;
			return acquire(key);
		};
		const operations = createManagedSessionOperations(fake.runtime, 25);
		await expect(
			operations.request({ authority, operation: "turn.steer", input: { text: "bounded" } }),
		).rejects.toMatchObject({ code: "timeout" });
		expect(fake.requests).toHaveLength(0);
		release.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(0);
	});

	test("cancels hanging generic acquisition without late dispatch", async () => {
		const fake = new FakeRuntime();
		const entered = deferred<void>();
		const release = deferred<void>();
		const acquire = fake.acquireAttachment.bind(fake);
		fake.acquireAttachment = async key => {
			entered.resolve();
			await release.promise;
			return acquire(key);
		};
		const controller = new AbortController();
		const request = createManagedSessionOperations(fake.runtime, 1_000).request({
			authority,
			operation: "turn.steer",
			signal: controller.signal,
		});
		await entered.promise;
		controller.abort();
		await expect(request).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		release.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(0);
	});

	test("rejects invalid query and turn timeouts before any Router dispatch", async () => {
		for (const timeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
			const fake = new FakeRuntime();
			const operations = createManagedSessionOperations(fake.runtime);
			await expect(operations.query(authority, "models.list/current", {}, timeoutMs)).rejects.toBeInstanceOf(
				TypeError,
			);
			await expect(
				operations.prompt({ authority, operation: "turn.prompt", text: "no", timeoutMs }),
			).rejects.toBeInstanceOf(TypeError);
			expect(fake.requests).toHaveLength(0);
		}
	});

	test("requires real terminal events for prompt, follow-up and gate continuation", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		const input = { authority, operation: "turn.prompt", text: "hello", timeoutMs: 1_000 };
		for (const run of [
			() => operations.prompt(input),
			() => operations.followUp(input),
			() => operations.answerGate({ ...input, gateId: "gate-1", answer: "yes" }),
		]) {
			await expect(run()).resolves.toMatchObject({
				text: "terminal done",
				events: [
					{ type: "message_update", text: "done" },
					{ type: "agent_end", payload: { finalText: "terminal done" } },
				],
			});
			expect(fake.subscriptions).toHaveLength(0);
		}
		expect(fake.requests.filter(request => request.operation === "workflow.gate_answer")[0]?.input).toEqual({
			id: "gate-1",
			response: "yes",
			expectedSessionId: authority.sessionId,
		});
	});
});

function withoutIdentity(): Omit<ManagedTurnAuthority, "sessionId" | "generation"> {
	const { sessionId: _sessionId, generation: _generation, ...value } = authority;
	return value;
}

class FakeRuntime {
	readonly state = "running";
	readonly attachment = { isCurrent: () => true };
	readonly tokens = new Map<string, ManagedSdkAttachment>();
	readonly externalLifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	readonly externalTimeouts: (number | undefined)[] = [];
	readonly lifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	readonly requests: Record<string, unknown>[] = [];
	readonly registered: unknown[] = [];
	readonly subscriptions: ((frame: unknown) => Promise<void>)[] = [];
	status: "retired" | "current" | "unknown" = "current";
	retirementOutcome: Record<string, unknown> = lifecycleSuccess();
	rejectTenant = false;
	repeatCursor = false;
	queryHandler: ((frame: Record<string, unknown>, page: number) => Promise<Record<string, unknown>>) | undefined;
	readonly requestTimeouts: (number | undefined)[] = [];
	queryCount = 0;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {}
	async acquireAttachment(key: unknown) {
		const tenant = key as typeof authority;
		if (
			this.rejectTenant ||
			tenant.principalId !== authority.principalId ||
			tenant.projectId !== authority.projectId ||
			tenant.canonicalWorkspace !== authority.canonicalWorkspace ||
			tenant.chatId !== authority.chatId ||
			tenant.sessionId !== authority.sessionId ||
			tenant.generation !== authority.generation ||
			tenant.leaseId !== authority.leaseId ||
			tenant.epoch !== authority.epoch
		)
			throw new Error("Exact tenant mismatch");
		return this.token(tenant);
	}
	async registerLifecycleTenant(key: unknown, outcome: unknown) {
		this.registered.push({ key, outcome });
		return this.token(key as TenantSessionKey);
	}
	async proveLifecycleTenant(key: TenantSessionKey) {
		return this.registerLifecycleTenant(key, undefined);
	}
	private token(key: TenantSessionKey): ManagedSdkAttachment {
		const identity = JSON.stringify(key);
		let token = this.tokens.get(identity);
		if (token === undefined) {
			token = { tenant: key, generation: key.generation, isCurrent: this.attachment.isCurrent };
			this.tokens.set(identity, token);
		}
		return token;
	}
	async createPreparedExternalLifecycleSession(
		_authority: unknown,
		request: Record<string, unknown>,
		timeoutMs?: number,
	) {
		this.externalTimeouts.push(timeoutMs);
		this.externalLifecycle.push({ operation: "create", request });
		return lifecycleSuccess();
	}
	async resumeExternalLifecycleSession(_tenant: unknown, request: Record<string, unknown>, timeoutMs?: number) {
		this.externalTimeouts.push(timeoutMs);
		this.externalLifecycle.push({ operation: "resume", request });
		return { kind: "result", outcome: lifecycleSuccess() };
	}
	async request(
		_attachment: unknown,
		frame: Record<string, unknown>,
		options?: { beforeDispatch?: () => void; onDispatch?: () => void; timeoutMs?: number },
	) {
		options?.beforeDispatch?.();
		this.requests.push(frame);
		this.requestTimeouts.push(options?.timeoutMs);
		options?.onDispatch?.();
		if (frame.type === "query_request" && this.queryHandler !== undefined)
			return await this.queryHandler(frame, ++this.queryCount);
		if (
			frame.operation === "turn.prompt" ||
			frame.operation === "turn.follow_up" ||
			frame.operation === "workflow.gate_answer"
		) {
			const listener = this.subscriptions.at(-1);
			if (listener === undefined) throw new Error("managed frame subscription must precede request");
			await listener({
				frame: {
					body: { type: "message_update", id: "frame-1", text: "done" },
					sessionId: authority.sessionId,
					generation: authority.generation,
					commandId: "command-1",
					turnId: "turn-1",
					seq: 1,
				},
			});
			await listener({
				frame: {
					body: { type: "agent_end", finalText: "terminal done" },
					sessionId: authority.sessionId,
					generation: authority.generation,
					commandId: "command-1",
					turnId: "turn-1",
					seq: 2,
				},
			});
		}
		if (frame.type === "query_request" && frame.query === "models.list/current")
			return queryResponse(
				frame.cursor === undefined || this.repeatCursor ? ["one"] : ["two"],
				frame.cursor === undefined || this.repeatCursor ? "next" : undefined,
			);
		if (frame.type === "query_request") return queryResponse([]);
		return {
			type: "control_response",
			ok: true,
			result: { accepted: true, commandId: "command-1", turnId: "turn-1" },
		};
	}
	subscribeFrames(
		_attachment: unknown,
		_operation: string,
		_correlation: unknown,
		listener: (frame: unknown) => Promise<void>,
	) {
		this.subscriptions.push(listener);
		const unsubscribe = (() => {
			this.subscriptions.splice(this.subscriptions.indexOf(listener), 1);
		}) as (() => void) & {
			drain(): Promise<void>;
		};
		unsubscribe.drain = async () => undefined;
		return unsubscribe;
	}
	prepareFrameSubscription(_attachment: unknown, _operation: string, listener: (frame: unknown) => Promise<void>) {
		const buffered: unknown[] = [];
		let bound = false;
		let active = true;
		let tail = Promise.resolve();
		const deliver = async (frame: unknown) => {
			if (!bound) {
				buffered.push(frame);
				return;
			}
			tail = tail.then(async () => {
				if (active) await listener(frame);
			});
			void tail.catch(() => undefined);
		};
		this.subscriptions.push(deliver);
		const unsubscribe = (() => {
			if (!active) return;
			active = false;
			this.subscriptions.splice(this.subscriptions.indexOf(deliver), 1);
		}) as (() => void) & { bind(correlation: unknown): void; drain(): Promise<void> };
		unsubscribe.bind = () => {
			bound = true;
			for (const frame of buffered) void deliver(frame);
			buffered.length = 0;
		};
		unsubscribe.drain = async () => {
			await tail;
		};
		return unsubscribe;
	}
	async generationStatus() {
		return { status: this.status };
	}
	async forkLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "fork", request });
		return lifecycleSuccess();
	}
	async closeLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "close", request });
		return this.retirementOutcome;
	}
	async deleteLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "delete", request });
		return this.retirementOutcome;
	}
	async listLifecycleSessions(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "list", request });
		return { ok: true, result: { sessions: [] } };
	}
}

function lifecycleSuccess() {
	return { ok: true as const, result: { sessionId: authority.sessionId, endpointGeneration: authority.generation } };
}
function queryResponse(items: readonly unknown[], continuationCursor?: string) {
	return {
		type: "query_response",
		ok: true as const,
		page: {
			items,
			complete: continuationCursor === undefined,
			...(continuationCursor === undefined ? {} : { continuationCursor }),
		},
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
}
