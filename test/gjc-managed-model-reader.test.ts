import { describe, expect, test } from "bun:test";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { GjcTurnCancelledError } from "../src/gjc/turn-runner";
import {
	createManagedModelReaderFactory,
	ManagedModelReaderUnavailableError,
} from "../src/live/gjc-managed-model-reader";

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

const temporary = {
	principalId: tenant.principalId,
	projectId: tenant.projectId,
	canonicalWorkspace: tenant.canonicalWorkspace,
	chatId: tenant.chatId,
	leaseId: tenant.leaseId,
	epoch: tenant.epoch,
	requestKey: "catalog-1",
};

const userContext = {
	principal: { role: "user" as const, userId: tenant.principalId },
	workspace: {
		userId: tenant.principalId,
		safeKey: "principal-1",
		root: tenant.canonicalWorkspace,
		sessionRoot: `${tenant.canonicalWorkspace}/.gjc/sessions`,
	},
	lease: { assertFence: async () => undefined },
};

describe("managed model reader", () => {
	test("queries models, providers, and state through one exact existing Router attachment", async () => {
		const fake = new FakeRuntime();
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			resolveAttachment: async () => ({ tenant }),
		})(userContext);

		await expect(reader.getAvailableModels()).resolves.toEqual([{ provider: "openai", id: "gpt-5" }]);
		await expect(reader.getActiveProviders()).resolves.toEqual([
			{ provider: "openai", connectionKind: "credentialless" },
		]);
		await expect(reader.getState()).resolves.toEqual({ model: { provider: "openai", id: "gpt-5" } });
		expect(fake.reconciles).toBe(1);
		expect(fake.requests.map(frame => frame.query)).toEqual([
			"models.list/current",
			"providers.list/active",
			"session.state",
		]);
		expect(JSON.stringify(fake)).not.toMatch(/token|password/i);
	});

	test("creates an isolated catalog lifecycle, acquires its exact generation, and proves retirement on stop", async () => {
		const fake = new FakeRuntime();
		const reader = await createManagedModelReaderFactory({ runtime: fake.runtime, temporary })();
		await reader.stop();

		expect(fake.created).toMatchObject({
			capability: "session.create",
			target: { kind: "existing_path", path: temporary.canonicalWorkspace },
		});
		expect(fake.registered).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
		expect(fake.closed).toMatchObject({
			capability: "session.close",
			target: { sessionId: "catalog-session", endpointGeneration: 11 },
		});
		expect(fake.statusKeys).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
		expect(fake.unregistered).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
	});

	test("fails closed before dispatch and cleans a late-created temporary session after cancellation", async () => {
		const fake = new FakeRuntime();
		const controller = new AbortController();
		controller.abort();
		await expect(
			createManagedModelReaderFactory({ runtime: fake.runtime, temporary })(undefined, controller.signal),
		).rejects.toBeInstanceOf(GjcTurnCancelledError);
		expect(fake.created).toBeUndefined();

		let release!: () => void;
		fake.createGate = new Promise<void>(resolve => {
			release = resolve;
		});
		const pending = createManagedModelReaderFactory({ runtime: fake.runtime, temporary })(
			undefined,
			new AbortController().signal,
		);
		await Promise.resolve();
		const lateController = new AbortController();
		const late = createManagedModelReaderFactory({ runtime: fake.runtime, temporary })(
			undefined,
			lateController.signal,
		);
		await Promise.resolve();
		lateController.abort();
		release();
		await expect(late).rejects.toBeInstanceOf(GjcTurnCancelledError);
		await Promise.resolve();
		expect(fake.closed).toBeDefined();
		void pending.catch(() => undefined);
	});

	test("cleans up after query failure and rejects replaced or unknown retirement proof", async () => {
		const fake = new FakeRuntime();
		fake.queryFailure = new Error("query unavailable");
		const reader = await createManagedModelReaderFactory({ runtime: fake.runtime, temporary })();
		await expect(reader.getAvailableModels()).rejects.toThrow("query unavailable");
		expect(fake.closed).toBeDefined();

		for (const status of ["replaced", "unknown"] as const) {
			const uncertain = new FakeRuntime();
			uncertain.status = status;
			const temporaryReader = await createManagedModelReaderFactory({ runtime: uncertain.runtime, temporary })();
			await expect(temporaryReader.stop()).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
		}
	});

	test("rejects tenant mismatch before every query dispatch", async () => {
		const fake = new FakeRuntime();
		fake.rejectTenant = true;
		await expect(
			createManagedModelReaderFactory({ runtime: fake.runtime, resolveAttachment: async () => ({ tenant }) })(),
		).rejects.toThrow("tenant mismatch");
		expect(fake.requests).toHaveLength(0);
	});

	test("requires the normal-user workspace and lease fence to match managed tenant authority", async () => {
		const fake = new FakeRuntime();
		let fenceCalls = 0;
		const context = {
			...userContext,
			lease: {
				assertFence: async () => {
					fenceCalls += 1;
				},
			},
		};
		await createManagedModelReaderFactory({ runtime: fake.runtime, resolveAttachment: async () => ({ tenant }) })(
			context,
		);
		expect(fenceCalls).toBe(2);
		await expect(
			createManagedModelReaderFactory({ runtime: fake.runtime, resolveAttachment: async () => ({ tenant }) })({
				...userContext,
				workspace: { ...userContext.workspace, root: "/other-workspace" },
			}),
		).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
	});
});

class FakeRuntime {
	readonly attachment = { isCurrent: () => true };
	readonly requests: Record<string, unknown>[] = [];
	readonly acquired: TenantSessionKey[] = [];
	readonly registered: TenantSessionKey[] = [];
	readonly unregistered: TenantSessionKey[] = [];
	readonly statusKeys: TenantSessionKey[] = [];
	created: Record<string, unknown> | undefined;
	closed: Record<string, unknown> | undefined;
	reconciles = 0;
	status: "retired" | "replaced" | "unknown" = "retired";
	rejectTenant = false;
	queryFailure: Error | undefined;
	createGate: Promise<void> | undefined;

	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {
		this.reconciles += 1;
	}
	async acquireAttachment(key: TenantSessionKey) {
		if (this.rejectTenant) throw new Error("tenant mismatch");
		this.acquired.push(key);
		return { tenant: key, generation: key.generation, attachment: this.attachment };
	}
	async request(_attachment: ManagedSdkAttachment, frame: Record<string, unknown>) {
		this.requests.push(frame);
		if (this.queryFailure !== undefined) throw this.queryFailure;
		if (frame.query === "models.list/current")
			return {
				type: "query_response",
				ok: true,
				page: { items: [{ provider: "openai", id: "gpt-5" }], complete: true },
			};
		if (frame.query === "providers.list/active")
			return {
				type: "query_response",
				ok: true,
				page: { items: [{ provider: "openai", connectionKind: "credentialless" }], complete: true },
			};
		return {
			type: "query_response",
			ok: true,
			page: { items: [{ model: { provider: "openai", id: "gpt-5" } }], complete: true },
		};
	}
	async createExternalLifecycleSession(request: Record<string, unknown>) {
		this.created = request;
		await this.createGate;
		return { ok: true, result: { sessionId: "catalog-session", endpointGeneration: 11 } };
	}
	async registerLifecycleTenant(key: TenantSessionKey) {
		if (this.rejectTenant) throw new Error("tenant mismatch");
		this.registered.push(key);
		return { tenant: key, generation: key.generation, attachment: this.attachment };
	}
	async closeLifecycleSession(request: Record<string, unknown>) {
		this.closed = request;
		return { ok: true };
	}
	async generationStatus(key: TenantSessionKey) {
		this.statusKeys.push(key);
		return { status: this.status };
	}
	unregisterTenant(key: TenantSessionKey) {
		this.unregistered.push(key);
	}
}
