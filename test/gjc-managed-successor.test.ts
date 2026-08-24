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
const target: ManagedTurnAuthority = { ...source, sessionId: "target-session", generation: 5 };

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
		expect(result.successor.tenant).toMatchObject({ sessionId: target.sessionId, generation: target.generation });
		expect(published).toEqual([target.sessionId]);
		expect(fake.order).toEqual([
			"reconcile",
			"acquire:source-session:4",
			"fork",
			"reconcile",
			"acquire:target-session:5",
			"status:target-session:5",
			"publish",
		]);
		expect(fake.forks[0]).toMatchObject({
			actor: { namespace: "openwebui-gjc-adapter", id: source.principalId },
			requestKey: source.requestKey,
			target: {
				sourceSessionId: source.sessionId,
				targetSessionId: target.sessionId,
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
		fake.status = "replaced";
		let published = false;
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target,
				publish: () => {
					published = true;
				},
			}),
		).rejects.toThrow("not current");
		expect(published).toBeFalse();
		expect(fake.order).toContain("close");
		expect(fake.closeTargets).toEqual([{ sessionId: target.sessionId, endpointGeneration: target.generation }]);
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
		expect(fake.order.filter(entry => entry === "status:target-session:5").length).toBe(1);
	});

	test("treats a lifecycle timeout after invocation as uncertain after retirement cleanup", async () => {
		const fake = new FakeRuntime();
		fake.forkFailure = new Error("fork timeout");
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({ source, target, publish: () => undefined }),
		).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(fake.order).toContain("close");
		expect(fake.closeTargets).toEqual([{ sessionId: target.sessionId, endpointGeneration: target.generation }]);
	});

	test("reports ambiguous cleanup when exact target retirement is not proven", async () => {
		const fake = new FakeRuntime();
		fake.status = "unknown";
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({ source, target, publish: () => undefined }),
		).rejects.toBeInstanceOf(ManagedSuccessorUncertainError);
		expect(fake.order).toContain("close");
		expect(fake.order).toContain("status:target-session:5");
	});

	test("rejects tenant-crossing successors before lifecycle visibility or invocation", async () => {
		const fake = new FakeRuntime();
		await expect(
			createManagedSuccessorFlow(fake.runtime).fork({
				source,
				target: { ...target, principalId: "user-b" },
				publish: () => undefined,
			}),
		).rejects.toThrow("tenant authority boundary");
		expect(fake.order).toEqual([]);
	});
});

class FakeRuntime {
	readonly order: string[] = [];
	readonly forks: Record<string, unknown>[] = [];
	readonly closeTargets: Record<string, unknown>[] = [];
	status: "current" | "retired" | "replaced" | "unknown" = "current";
	afterFork: (() => void) | undefined;
	forkFailure: Error | undefined;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {
		this.order.push("reconcile");
	}
	async acquireAttachment(key: { sessionId: string; generation: number }) {
		this.order.push(`acquire:${key.sessionId}:${key.generation}`);
		return {
			tenant: key,
			generation: key.generation,
			attachment: { isCurrent: () => this.status === "current" },
		};
	}
	async generationStatus(key: { sessionId: string; generation: number }) {
		this.order.push(`status:${key.sessionId}:${key.generation}`);
		return { status: this.status };
	}
	async forkLifecycleSession(request: Record<string, unknown>) {
		this.order.push("fork");
		this.forks.push(request);
		this.afterFork?.();
		if (this.forkFailure !== undefined) throw this.forkFailure;
		return { ok: true };
	}
	async closeLifecycleSession(request: Record<string, unknown>) {
		this.order.push("close");
		this.closeTargets.push(request.target as Record<string, unknown>);
		if (this.status !== "unknown") this.status = "retired";
		return { ok: true };
	}
}
