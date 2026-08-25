import { describe, expect, test } from "bun:test";
import type { ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
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
		expect(JSON.stringify(fake)).not.toMatch(/token|credential|password/i);
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
});

function withoutIdentity(): Omit<ManagedTurnAuthority, "sessionId" | "generation"> {
	const { sessionId: _sessionId, generation: _generation, ...value } = authority;
	return value;
}

class FakeRuntime {
	readonly attachment = { isCurrent: () => true };
	readonly externalLifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	readonly lifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	readonly requests: Record<string, unknown>[] = [];
	readonly registered: unknown[] = [];
	readonly subscriptions: ((frame: unknown) => Promise<void>)[] = [];
	status: "retired" | "current" | "unknown" = "current";
	rejectTenant = false;
	repeatCursor = false;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {}
	async acquireAttachment(key: unknown) {
		if (this.rejectTenant) throw new Error("Exact tenant mismatch");
		return { tenant: key, generation: authority.generation, attachment: this.attachment };
	}
	async registerLifecycleTenant(key: unknown, outcome: unknown) {
		this.registered.push({ key, outcome });
		return { tenant: key, generation: authority.generation, attachment: this.attachment };
	}
	async createPreparedExternalLifecycleSession(_authority: unknown, request: Record<string, unknown>) {
		this.externalLifecycle.push({ operation: "create", request });
		return lifecycleSuccess();
	}
	async resumeExternalLifecycleSession(_tenant: unknown, request: Record<string, unknown>) {
		this.externalLifecycle.push({ operation: "resume", request });
		return { kind: "result", outcome: lifecycleSuccess() };
	}
	async request(_attachment: unknown, frame: Record<string, unknown>, options?: { onDispatch?: () => void }) {
		this.requests.push(frame);
		options?.onDispatch?.();
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
					seq: 1,
				},
			});
		}
		if (frame.type === "query_request" && frame.query === "models.list/current")
			return queryResponse(
				frame.cursor === undefined || this.repeatCursor ? ["one"] : ["two"],
				frame.cursor === undefined || this.repeatCursor ? "next" : undefined,
			);
		if (frame.type === "query_request") return queryResponse([]);
		return { type: "control_response", ok: true, result: { commandId: "command-1", turnId: "turn-1" } };
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
		this.subscriptions.push(listener);
		const unsubscribe = (() => {
			this.subscriptions.splice(this.subscriptions.indexOf(listener), 1);
		}) as (() => void) & { bind(correlation: unknown): void; drain(): Promise<void> };
		unsubscribe.bind = () => undefined;
		unsubscribe.drain = async () => undefined;
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
		return lifecycleSuccess();
	}
	async deleteLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "delete", request });
		return lifecycleSuccess();
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
