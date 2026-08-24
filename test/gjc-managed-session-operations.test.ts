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
	test("uses exact tenant lifecycle, Router controls, model mutation, and bounded query pages without credentials", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await operations.create({ authority, target: { cwd: authority.canonicalWorkspace } });
		await operations.resume({ authority, target: { sessionId: authority.sessionId } });
		await operations.fork({
			authority,
			target: { sourceSessionId: authority.sessionId, cwd: authority.canonicalWorkspace },
		});
		await operations.list({ authority, target: { cwd: authority.canonicalWorkspace } });
		await operations.setModel(authority, { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" });
		await operations.setThinking(authority, "low");
		await expect(operations.query(authority, "models.list/current")).resolves.toEqual(["one", "two"]);
		await expect(operations.getState(authority)).resolves.toEqual([]);
		await expect(operations.getProviders(authority)).resolves.toEqual([]);
		await expect(operations.getBranchCandidates(authority)).resolves.toEqual([]);
		expect(fake.lifecycle.map(call => call.operation)).toEqual(["create", "resume", "fork", "list"]);
		expect(fake.lifecycle[0]?.request).toMatchObject({
			actor: { namespace: "openwebui-gjc-adapter", id: authority.principalId },
			requestKey: authority.requestKey,
		});
		expect(operations.payloadHash({ z: [2, 1], a: "stable" })).toBe(
			operations.payloadHash({ a: "stable", z: [2, 1] }),
		);
		expect(fake.requests.map(frame => frame.operation ?? frame.query)).toEqual([
			"model.set",
			"thinking.set",
			"models.list/current",
			"models.list/current",
			"session.state",
			"providers.list/active",
			"session.branch_candidates",
		]);
		expect(fake.requests[2]?.cursor).toBeUndefined();
		expect(fake.requests[3]?.cursor).toBe("next");
		expect(JSON.stringify({ authority, lifecycle: fake.lifecycle, requests: fake.requests })).not.toMatch(
			/token|credential|password/i,
		);
	});

	test("proves retirement after close and treats current or unknown exact generations as uncertain", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		fake.status = "retired";
		await expect(
			operations.close({
				authority,
				target: { sessionId: authority.sessionId, endpointGeneration: authority.generation },
			}),
		).resolves.toMatchObject({ ok: true });
		fake.status = "current";
		await expect(operations.delete({ authority, target: { sessionId: authority.sessionId } })).rejects.toBeInstanceOf(
			ManagedTurnUncertainError,
		);
		fake.status = "unknown";
		await expect(operations.close({ authority, target: { sessionId: authority.sessionId } })).rejects.toBeInstanceOf(
			ManagedTurnUncertainError,
		);
	});

	test("rejects incomplete and exact-tenant-mismatched authority before a Router request", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		await expect(
			operations.request({ authority: { ...authority, generation: 0 }, operation: "turn.prompt" }),
		).rejects.toThrow("Complete positive");
		fake.rejectTenant = true;
		await expect(operations.request({ authority, operation: "turn.prompt" })).rejects.toThrow("Exact tenant");
		expect(fake.requests).toHaveLength(0);
	});

	test("uses terminal turn.abort and never dispatches after cancellation", async () => {
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
		).rejects.toThrow("cancelled");
		expect(fake.requests).toHaveLength(1);
	});

	test("sends one terminal abort when cancellation follows the prompt dispatch boundary", async () => {
		const fake = new FakeRuntime();
		const operations = createManagedSessionOperations(fake.runtime);
		const controller = new AbortController();
		await expect(
			operations.prompt({
				authority,
				operation: "turn.prompt",
				text: "dispatch",
				signal: controller.signal,
				onDispatch: () => controller.abort(),
			}),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(fake.requests.map(frame => frame.operation)).toEqual(["turn.prompt", "turn.abort"]);
	});

	test("rejects repeated query cursors rather than traversing an unbounded Router stream", async () => {
		const fake = new FakeRuntime();
		fake.repeatCursor = true;
		await expect(
			createManagedSessionOperations(fake.runtime).query(authority, "models.list/current"),
		).rejects.toThrow("repeated");
	});
});

class FakeRuntime {
	readonly attachment = { isCurrent: () => true };
	readonly lifecycle: { operation: string; request: Record<string, unknown> }[] = [];
	readonly requests: Record<string, unknown>[] = [];
	status: "retired" | "current" | "unknown" = "current";
	rejectTenant = false;
	repeatCursor = false;
	readonly lifecycleService = {
		createExternal: async (request: Record<string, unknown>) => {
			this.lifecycle.push({ operation: "create", request });
			return { ok: true };
		},
		resumeExternal: async (request: Record<string, unknown>) => {
			this.lifecycle.push({ operation: "resume", request });
			return { kind: "result", outcome: { ok: true } };
		},
	};
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {}
	async acquireAttachment(key: unknown) {
		if (this.rejectTenant) throw new Error("Exact tenant mismatch");
		return { tenant: key, generation: authority.generation, attachment: this.attachment };
	}
	async request(_attachment: unknown, frame: Record<string, unknown>, options?: { onDispatch?: () => void }) {
		this.requests.push(frame);
		options?.onDispatch?.();
		if (frame.type === "query_request" && frame.query === "models.list/current")
			return frame.cursor === undefined || this.repeatCursor
				? { items: ["one"], continuationCursor: "next" }
				: { items: ["two"] };
		if (frame.type === "query_request") return { items: [] };
		return { ok: true, commandId: "command-1", turnId: "turn-1" };
	}
	async generationStatus() {
		return { status: this.status };
	}
	async forkLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "fork", request });
		return { ok: true };
	}
	async closeLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "close", request });
		return { ok: true };
	}
	async deleteLifecycleSession(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "delete", request });
		return { ok: true };
	}
	async listLifecycleSessions(request: Record<string, unknown>) {
		this.lifecycle.push({ operation: "list", request });
		return { ok: true, result: { sessions: [] } };
	}
}
