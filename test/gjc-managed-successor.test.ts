import { describe, expect, test } from "bun:test";
import type { ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
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

describe("unwired managed successor", () => {
	test("forks with stable actor/request key/hash and publishes only after target proof", async () => {
		const fake = new FakeRuntime();
		const published: string[] = [];
		const result = await createManagedSuccessorFlow(fake.runtime).fork({
			source,
			target,
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
			"register:forked-session:9",
			"reconcile",
			"acquire:forked-session:9",
			"status:forked-session:9",
			"publish",
		]);
		expect(fake.forks[0]).toMatchObject({
			actor: { namespace: "openwebui-gjc-adapter", id: source.principalId },
			requestKey: source.requestKey,
			target: {
				sourceSessionId: source.sessionId,
				operationHash: result.operationHash,
			},
		});
	});

	test("reuses the same request key and stable hash during same-key recovery", async () => {
		const fake = new FakeRuntime();
		const flow = createManagedSuccessorFlow(fake.runtime);
		const first = await flow.fork({ source, target, publish: () => undefined });
		const second = await flow.fork({ source, target, publish: () => undefined });
		expect(first.operationHash).toBe(second.operationHash);
		expect(fake.forks.map(request => request.requestKey)).toEqual([source.requestKey, source.requestKey]);
		expect(fake.forks.map(request => (request.target as Record<string, unknown>).operationHash)).toEqual([
			first.operationHash,
			second.operationHash,
		]);
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
		).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(published).toBeFalse();
		expect(fake.order).toContain("close");
		expect(fake.closeTargets).toEqual([successor]);
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

	test("treats cancellation after invocation as uncertain until cleanup proves retirement", async () => {
		const fake = new FakeRuntime();
		const controller = new AbortController();
		fake.afterFork = () => controller.abort();
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target,
				signal: controller.signal,
				publish: () => undefined,
			}),
		).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(fake.order).toContain("close");
		expect(fake.order.filter(entry => entry === "status:forked-session:9").length).toBe(1);
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

class FakeRuntime {
	readonly order: string[] = [];
	readonly forks: Record<string, unknown>[] = [];
	readonly closeTargets: Record<string, unknown>[] = [];
	readonly registered = new Map<string, { sessionId: string; generation: number; principalId: string }>();
	targetStatus: "current" | "retired" | "replaced" | "unknown" = "current";
	successorPrincipalId = source.principalId;
	afterFork: (() => void) | undefined;
	forkFailure: Error | undefined;
	sourceFence = true;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {
		this.order.push("reconcile");
	}
	async acquireAttachment(key: { sessionId: string; generation: number }) {
		this.order.push(`acquire:${key.sessionId}:${key.generation}`);
		if (key.sessionId === source.sessionId && !this.sourceFence) throw new Error("source fence was lost");
		if (key.sessionId === successor.sessionId && !this.registered.has(`${key.sessionId}:${key.generation}`))
			throw new Error("Returned successor was not registered.");
		return {
			tenant: key,
			generation: key.generation,
			attachment: { isCurrent: () => key.sessionId === source.sessionId || this.targetStatus === "current" },
		};
	}
	async generationStatus(key: { sessionId: string; generation: number }) {
		this.order.push(`status:${key.sessionId}:${key.generation}`);
		return { status: key.sessionId === source.sessionId ? "current" : this.targetStatus };
	}
	registerTenant(key: { sessionId: string; generation: number; principalId: string }) {
		this.order.push(`register:${key.sessionId}:${key.generation}`);
		this.registered.set(`${key.sessionId}:${key.generation}`, key);
	}
	async registerLifecycleTenant(key: { sessionId: string; generation: number; principalId: string }) {
		this.registerTenant(key);
		return { tenant: key, generation: key.generation, attachment: this.attachmentFor(key) };
	}
	private attachmentFor(key: { sessionId: string }) {
		return { isCurrent: () => key.sessionId === source.sessionId || this.targetStatus === "current" };
	}
	async forkLifecycleSession(request: Record<string, unknown>) {
		this.order.push("fork");
		this.forks.push(request);
		this.afterFork?.();
		if (this.forkFailure !== undefined) throw this.forkFailure;
		return {
			ok: true,
			result: {
				sessionId: successor.sessionId,
				endpointGeneration: successor.endpointGeneration,
				principalId: this.successorPrincipalId,
			},
		};
	}
	async closeLifecycleSession(request: Record<string, unknown>) {
		this.order.push("close");
		this.closeTargets.push(request.target as Record<string, unknown>);
		if (this.targetStatus !== "unknown") this.targetStatus = "retired";
		return { ok: true };
	}
}
