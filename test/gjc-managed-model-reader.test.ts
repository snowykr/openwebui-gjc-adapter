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
	assertFence: async () => undefined,
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
		const reader = await createManagedModelReaderFactory({
			runtime: fake.runtime,
			temporary: { ...temporary, timeoutMs: 250 },
		})();
		await reader.stop();

		expect(fake.created).toMatchObject({
			capability: "session.create",
			target: { kind: "existing_path", path: temporary.canonicalWorkspace },
		});
		expect(fake.created).not.toHaveProperty("timeoutMs");
		expect(fake.created).not.toHaveProperty("readinessTimeoutMs");
		expect(fake.createTimeoutMs).toBe(250);
		expect(fake.preparedCreates).toEqual([
			expect.objectContaining({
				principalId: temporary.principalId,
				projectId: temporary.projectId,
				canonicalWorkspace: temporary.canonicalWorkspace,
				chatId: temporary.chatId,
				leaseId: temporary.leaseId,
				epoch: temporary.epoch,
				requestKey: temporary.requestKey,
			}),
		]);
		expect(fake.registered).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
		expect(fake.closed).toMatchObject({
			tenant: { ...tenant, sessionId: "catalog-session", generation: 11 },
			capability: "session.close",
			target: { sessionId: "catalog-session", endpointGeneration: 11 },
		});
		expect(fake.statusKeys).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
		expect(fake.unregistered).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
	});

	test("does not create a catalog session with substituted prepared authority", async () => {
		for (const change of [
			{ principalId: "foreign" },
			{ projectId: "foreign" },
			{ canonicalWorkspace: "/foreign" },
			{ chatId: "foreign" },
			{ leaseId: "foreign" },
			{ epoch: "foreign" },
			{ requestKey: "foreign" },
		]) {
			const fake = new FakeRuntime();
			await expect(
				createManagedModelReaderFactory({ runtime: fake.runtime, temporary: { ...temporary, ...change } })(),
			).rejects.toThrow("prepared authority");
			expect(fake.createCalls).toBe(0);
			expect(fake.created).toBeUndefined();
		}
	});

	test.each(["failed", "foreign"] as const)(
		"rejects %s close acknowledgement despite positive retirement",
		async mode => {
			const fake = new FakeRuntime();
			fake.closeOutcome =
				mode === "failed"
					? {
							ok: false,
							operation: "session.close",
							certainty: "uncertain",
							error: { code: "failed", message: "close failed" },
						}
					: { ok: true, operation: "session.close", result: { sessionId: "foreign-session" } };
			const reader = await createManagedModelReaderFactory({ runtime: fake.runtime, temporary })();
			await expect(reader.stop()).rejects.toBeInstanceOf(ManagedModelReaderUnavailableError);
			expect(fake.statusKeys).toEqual([{ ...tenant, sessionId: "catalog-session", generation: 11 }]);
			expect(fake.unregistered).toEqual([]);
		},
	);

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
		const lateController = new AbortController();
		const late = createManagedModelReaderFactory({ runtime: fake.runtime, temporary })(
			undefined,
			lateController.signal,
		);
		for (let attempt = 0; attempt < 20 && fake.createCalls < 1; attempt++) await Bun.sleep(1);
		expect(fake.createCalls).toBe(1);
		lateController.abort();
		release();
		await expect(late).rejects.toBeInstanceOf(GjcTurnCancelledError);
		await fake.closeObserved;
		expect(fake.closed).toBeDefined();
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

	test("keeps fixture capabilities stable and revokes them when tenant authority is lost", async () => {
		const fake = new FakeRuntime();
		const acquired = await fake.acquireAttachment(tenant);
		expect(await fake.acquireAttachment({ ...tenant })).toBe(acquired);
		expect(acquired).not.toHaveProperty("attachment");
		expect(acquired).not.toHaveProperty("send");
		fake.rejectTenant = true;
		expect(acquired.isCurrent()).toBe(false);
		await expect(fake.request(acquired, { query: "session.state" })).rejects.toThrow("tenant mismatch");
		fake.rejectTenant = false;
		fake.unregisterTenant(tenant);
		expect(acquired.isCurrent()).toBe(false);
		const replacement = await fake.registerLifecycleTenant({ ...tenant });
		expect(replacement).not.toBe(acquired);
		expect(replacement.isCurrent()).toBe(true);
		expect(acquired.isCurrent()).toBe(false);
		await fake.generationStatus(tenant);
		expect(replacement.isCurrent()).toBe(false);
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
	private closeResolve: () => void = () => undefined;
	readonly closeObserved = new Promise<void>(resolve => {
		this.closeResolve = resolve;
	});
	readonly #attachments = new Map<string, ManagedSdkAttachment>();
	readonly #tenants = new Set<string>([tenantIdentity(tenant)]);
	readonly #retired = new Set<string>();
	readonly requests: Record<string, unknown>[] = [];
	readonly acquired: TenantSessionKey[] = [];
	readonly registered: TenantSessionKey[] = [];
	readonly unregistered: TenantSessionKey[] = [];
	readonly statusKeys: TenantSessionKey[] = [];
	readonly preparedCreates: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[0][] = [];
	created: Record<string, unknown> | undefined;
	createTimeoutMs: number | undefined;
	createCalls = 0;
	closed: Record<string, unknown> | undefined;
	closeOutcome: Awaited<ReturnType<ManagedSdkRuntime["closeLifecycleSession"]>> | undefined;
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
		const identity = tenantIdentity(key);
		if (this.rejectTenant || !this.#tenants.has(identity) || this.#retired.has(identity))
			throw new Error("tenant mismatch");
		this.acquired.push(key);
		let token = this.#attachments.get(identity);
		if (token === undefined) {
			const issued: ManagedSdkAttachment = Object.freeze({
				tenant: Object.freeze({ ...key }),
				generation: key.generation,
				isCurrent: () =>
					!this.rejectTenant &&
					!this.#retired.has(identity) &&
					this.#tenants.has(identity) &&
					this.#attachments.get(identity) === issued,
			});
			token = issued;
			this.#attachments.set(identity, token);
		}
		return token;
	}
	async request(attachment: ManagedSdkAttachment, frame: Record<string, unknown>) {
		if (this.#attachments.get(tenantIdentity(attachment.tenant)) !== attachment || !attachment.isCurrent())
			throw new Error("tenant mismatch");
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
	async createPreparedExternalLifecycleSession(
		authority: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[0],
		request: Parameters<ManagedSdkRuntime["createPreparedExternalLifecycleSession"]>[1],
		timeoutMs?: number,
	) {
		if (
			this.rejectTenant ||
			!["principalId", "projectId", "canonicalWorkspace", "chatId", "leaseId", "epoch", "requestKey"].every(
				field => Reflect.get(authority, field) === Reflect.get(temporary, field),
			)
		)
			throw new Error("Fixture prepared authority does not match the catalog tenant.");
		if (
			request.actor.id !== authority.principalId ||
			request.requestKey !== authority.requestKey ||
			request.capability !== "session.create" ||
			request.target.kind !== "existing_path" ||
			request.target.path !== authority.canonicalWorkspace
		)
			throw new Error("Fixture lifecycle request does not match prepared authority.");
		this.preparedCreates.push(authority);
		this.createCalls += 1;
		this.created = request;
		this.createTimeoutMs = timeoutMs;
		await this.createGate;
		return { ok: true, result: { sessionId: "catalog-session", endpointGeneration: 11 } };
	}
	async registerLifecycleTenant(key: TenantSessionKey) {
		if (this.rejectTenant) throw new Error("tenant mismatch");
		this.registered.push(key);
		this.#tenants.add(tenantIdentity(key));
		return this.acquireAttachment(key);
	}
	async closeLifecycleSession(
		request: NonNullable<Parameters<ManagedSdkRuntime["closeLifecycleSession"]>[1]> & {
			readonly tenant: TenantSessionKey;
		},
	): ReturnType<ManagedSdkRuntime["closeLifecycleSession"]> {
		const expected = { ...tenant, sessionId: "catalog-session", generation: 11 };
		if (
			request.tenant === undefined ||
			tenantIdentity(request.tenant) !== tenantIdentity(expected) ||
			request.target.sessionId !== expected.sessionId ||
			request.target.endpointGeneration !== expected.generation ||
			request.actor.id !== expected.principalId ||
			request.capability !== "session.close"
		)
			throw new Error("Fixture close requires exact catalog tenant and generation authority.");
		this.closed = request;
		this.closeResolve();
		return (
			this.closeOutcome ?? { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } }
		);
	}
	async generationStatus(key: TenantSessionKey) {
		this.statusKeys.push(key);
		if (this.status === "retired" || this.status === "replaced") this.#retired.add(tenantIdentity(key));
		return { status: this.status };
	}
	unregisterTenant(key: TenantSessionKey) {
		this.unregistered.push(key);
		const identity = tenantIdentity(key);
		this.#tenants.delete(identity);
		this.#attachments.delete(identity);
	}
}

function tenantIdentity(key: TenantSessionKey): string {
	return JSON.stringify([
		key.principalId,
		key.projectId,
		key.canonicalWorkspace,
		key.chatId,
		key.sessionId,
		key.generation,
		key.leaseId,
		key.epoch,
	]);
}
