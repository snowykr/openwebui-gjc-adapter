import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type { SessionMapping, SessionMappingStore } from "../src/gjc/session-router";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import {
	createManagedIdleReaper,
	createManagedV3GenerationStore,
	type ManagedIdleGenerationStore,
	type ManagedIdleLifecycleRuntime,
} from "../src/live/gjc-managed-idle-reaper";
import type { OpenWebUIProjectionRepository } from "../src/openwebui/client";
import { writeDirectV3Authority } from "./cli-fixtures";

const project = {
	id: "project-1",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function managedRuntimeFixture() {
	let state: "new" | "running" | "stopped" = "new";
	let disposes = 0;
	const registrations = new Map<string, Record<string, unknown>>();
	const tenantKey = (tenant: Record<string, unknown>) =>
		JSON.stringify([
			tenant.principalId,
			tenant.projectId,
			tenant.canonicalWorkspace,
			tenant.chatId,
			tenant.sessionId,
			tenant.generation,
			tenant.leaseId,
			tenant.epoch,
		]);
	const runtime = {
		get state() {
			return state;
		},
		async start() {
			state = "running";
		},
		async dispose() {
			disposes += 1;
			state = "stopped";
		},
		async reconcile() {},
		registerTenant(tenant: Record<string, unknown>) {
			registrations.set(tenantKey(tenant), tenant);
		},
		async acquireAttachment(tenant: Record<string, unknown>) {
			const key = tenantKey(tenant);
			if (!registrations.has(key)) throw new Error("Managed fixture tenant is not registered.");
			return {
				tenant,
				generation: tenant.generation,
				isCurrent: () => state === "running" && registrations.has(key),
			};
		},
		async generationStatus() {
			return { status: "current" as const };
		},
		async request() {
			return { ok: true };
		},
		subscribeFrames() {
			return () => undefined;
		},
		async createLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.create" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
		async resumeLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.resume" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
		async closeLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.close" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
		async deleteLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.delete" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
	};
	return {
		runtime: runtime as never,
		get disposes() {
			return disposes;
		},
	};
}

function createManagedV3Authority(operationId = "turn-1", generation = 1): ManagedTurnAuthority {
	return {
		principalId: "owner-1",
		projectId: project.id,
		canonicalWorkspace: project.cwd,
		chatId: "chat-1",
		sessionId: "managed-session-1",
		generation,
		leaseId: "lease-v3-1",
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		requestKey: operationId,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	} as ManagedTurnAuthority;
}

function createManagedV3Mapping(operationId = "turn-1", generation = 1): SessionMapping {
	const authority = createManagedV3Authority(operationId, generation);
	return {
		chatId: authority.chatId,
		principalId: authority.principalId,
		projectId: authority.projectId,
		sessionId: authority.sessionId,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId,
		managedAuthority: authority,
	};
}

test("a linked-project projection failure does not stop the constructed reaper", async () => {
	const root = await mkdtemp(join(tmpdir(), "gjc-idle-reaper-init-"));
	const failure = new Error("projection startup failure");
	const managedSdkRuntime = managedRuntimeFixture();
	const projectionRepository: OpenWebUIProjectionRepository = {
		async upsertFolder() {
			throw failure;
		},
		async upsertChat(record) {
			return record;
		},
		async replaceChatMessages(_ownerUserId, _chatId, messages) {
			return messages;
		},
		async getChat() {
			return undefined;
		},
	};
	try {
		await writeDirectV3Authority(join(root, "sessions"));
		const options = await buildAdapterServerOptions(
			{
				mode: "existing",
				bindHost: "127.0.0.1",
				bindPort: 8765,
				openWebUIBaseUrl: "http://127.0.0.1:3000",
				allowedProjectRoots: [root],
				projects: [{ cwd: root, name: "demo" }],
				statePath: join(root, "state"),
				sessionRoot: join(root, "sessions"),
				gjcCommand: "/bin/true",
				turnTimeoutMs: 60_000,
			},
			{ managedSdkRuntime: managedSdkRuntime.runtime, projectionRepository },
		);
		expect(options.checks).toContainEqual(
			expect.objectContaining({ name: "openwebui-project-projection", status: "degraded" }),
		);
		expect(managedSdkRuntime.disposes).toBe(0);
		await options.shutdownCleanup?.();
		await options.runtimeLock.release();
		expect(managedSdkRuntime.disposes).toBe(1);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
test("a linked-project projection failure does not stop the base routing runner", async () => {
	const root = await mkdtemp(join(tmpdir(), "gjc-idle-reaper-no-close-init-"));
	const failure = new Error("projection startup failure");
	const managedSdkRuntime = managedRuntimeFixture();
	const projectionRepository: OpenWebUIProjectionRepository = {
		async upsertFolder() {
			throw failure;
		},
		async upsertChat(record) {
			return record;
		},
		async replaceChatMessages(_ownerUserId, _chatId, messages) {
			return messages;
		},
		async getChat() {
			return undefined;
		},
	};
	try {
		await writeDirectV3Authority(join(root, "sessions"));
		const options = await buildAdapterServerOptions(
			{
				mode: "existing",
				bindHost: "127.0.0.1",
				bindPort: 8765,
				openWebUIBaseUrl: "http://127.0.0.1:3000",
				allowedProjectRoots: [root],
				projects: [{ cwd: root, name: "demo" }],
				statePath: join(root, "state"),
				sessionRoot: join(root, "sessions"),
				gjcCommand: "/bin/true",
				turnTimeoutMs: 60_000,
			},
			{ managedSdkRuntime: managedSdkRuntime.runtime, projectionRepository },
		);
		expect(options.checks).toContainEqual(
			expect.objectContaining({ name: "openwebui-project-projection", status: "degraded" }),
		);
		expect(managedSdkRuntime.disposes).toBe(0);
		await options.shutdownCleanup?.();
		await options.runtimeLock.release();
		expect(managedSdkRuntime.disposes).toBe(1);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

describe("managed V3 idle retirement", () => {
	async function createV3Fixture(mapping = createManagedV3Mapping()) {
		const root = await mkdtemp(join(tmpdir(), "gjc-managed-v3-idle-"));
		const authorityPath = join(root, "session-authority.json");
		const initial = new V3FileBackedSessionMappingStore(authorityPath);
		const scope = { principalId: mapping.principalId!, chatId: mapping.chatId };
		const operation = {
			id: mapping.operationId,
			kind: "prompt" as const,
			ingressId: mapping.operationId,
			detail: mapping.operationId,
			chatId: mapping.chatId,
			projectId: mapping.projectId,
		};
		initial.reserveProvisionalOperationScoped(scope, operation);
		initial.publishProvisionalOperationScoped(scope, operation, mapping);
		initial.close();
		return {
			mapping,
			mappings: new V3FileBackedSessionMappingStore(authorityPath),
			reopen: () => new V3FileBackedSessionMappingStore(authorityPath),
			cleanup: async () => rm(root, { force: true, recursive: true }),
		};
	}

	function runtimeFor(
		close: ManagedIdleLifecycleRuntime["closeLifecycleSession"],
		status: ManagedIdleLifecycleRuntime["generationStatus"],
	): ManagedIdleLifecycleRuntime {
		return {
			closeLifecycleSession: close,
			reconcile: async () => undefined,
			generationStatus: status,
		};
	}

	function reaperFor(
		mappings: SessionMappingStore,
		runtime: ManagedIdleLifecycleRuntime,
		assertFence: () => Promise<void> = async () => undefined,
		now: () => number = () => Date.now() + 100_000,
		records: ManagedIdleGenerationStore = createManagedV3GenerationStore(mappings),
	) {
		return createManagedIdleReaper({
			records,
			runtime,
			idleTimeoutMs: 1,
			now,
			admission: { acquire: async () => () => undefined },
			leases: {
				acquire: async () => ({ assertFence, release: async () => undefined }),
			},
		});
	}

	test("proves exact retirement before evicting a V3 mapping with no legacy attachment", async () => {
		const fixture = await createV3Fixture();
		const { mappings, mapping } = fixture;
		expect(await createManagedV3GenerationStore(mappings).active()).toHaveLength(1);
		const lifecycleCalls: string[] = [];
		const closeTargets: Array<{ readonly sessionId: string; readonly endpointGeneration: number }> = [];
		const reaper = reaperFor(mappings, {
			closeLifecycleSession: async request => {
				lifecycleCalls.push("close");
				closeTargets.push(request.target);
				return { ok: true, result: { sessionId: request.target.sessionId } };
			},
			reconcile: async () => {
				lifecycleCalls.push("reconcile");
			},
			generationStatus: async () => {
				lifecycleCalls.push("status");
				return { status: "retired" };
			},
		});

		await reaper.runOnce();

		expect(closeTargets).toEqual([{ sessionId: mapping.sessionId, endpointGeneration: 1 }]);
		expect(lifecycleCalls).toEqual(["close", "reconcile", "status"]);
		expect(mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })).toBeUndefined();
		expect(mapping).not.toHaveProperty("attachment");
		expect(mapping).not.toHaveProperty("sessionFile");
		await reaper.stop();
		mappings.close();
		await fixture.cleanup();
	});

	test("durably prepares and retires a V3 close with scoped authority", async () => {
		const fixture = await createV3Fixture();
		const records = createManagedV3GenerationStore(fixture.mappings);
		const [record] = await records.active();
		expect(record).toBeDefined();
		const scopedMapping = fixture.mappings.getScoped({
			principalId: record!.authority.principalId,
			chatId: record!.authority.chatId,
		});
		expect(scopedMapping).toBeDefined();
		expect(scopedMapping!.managedAuthority).toEqual(record!.authority);
		const prepared = await records.prepareClose(record!, {
			key: "managed-close-prepare",
			authority: record!.authority,
			requestedAt: Date.now(),
		});
		expect(prepared).toBe(true);
		fixture.mappings.retireScoped({
			principalId: record!.authority.principalId,
			chatId: record!.authority.chatId,
		});
		expect(
			fixture.mappings.getScoped({ principalId: record!.authority.principalId, chatId: record!.authority.chatId }),
		).toBeUndefined();
		fixture.mappings.close();
		await fixture.cleanup();
	});

	test("restarts a retryable close with a deterministic ingress and then retires", async () => {
		const fixture = await createV3Fixture();
		let { mappings } = fixture;
		const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
		let now = Date.now() + 100_000;
		let attempt = 0;
		const ingressIds: string[] = [];
		const authorities: unknown[] = [];
		const runtime = runtimeFor(
			async request => {
				attempt += 1;
				ingressIds.push(request.requestKey);
				authorities.push({ tenant: request.tenant, target: request.target });
				return attempt === 1
					? { ok: false, certainty: "retryable" }
					: { ok: true, result: { sessionId: request.target.sessionId } };
			},
			async () => ({ status: attempt === 1 ? "current" : "retired" }),
		);
		const first = reaperFor(
			mappings,
			runtime,
			async () => undefined,
			() => now,
		);
		await first.runOnce();
		await first.stop();
		const prior = mappings.operationScoped(scope, ingressIds[0]!);
		expect(prior?.state).toBe("conflict");
		mappings.close();
		mappings = fixture.reopen();
		expect(mappings.operationScoped(scope, ingressIds[0]!)).toEqual(prior);
		now += 100_000;
		const restarted = reaperFor(
			mappings,
			runtime,
			async () => undefined,
			() => now,
		);
		await restarted.runOnce();

		expect(ingressIds).toHaveLength(2);
		expect(ingressIds[1]).toBe(`${ingressIds[0]}:retry:1`);
		expect(authorities[1]).toEqual(authorities[0]);
		expect(mappings.entries()).toHaveLength(0);
		await restarted.stop();
		mappings.close();
		await fixture.cleanup();
	});

	test("rearms a previously completed close after the mapping operation advances", async () => {
		const fixture = await createV3Fixture();
		let { mappings } = fixture;
		const { mapping: original } = fixture;
		const scope = { principalId: original.principalId!, chatId: original.chatId };
		mappings.beginOperationScoped(scope, {
			id: "managed-close",
			kind: "close",
			ingressId: "managed-close",
			detail: "managed-close",
		});
		mappings.transitionOperationScoped(scope, "managed-close", "complete", "managed-close", {
			kind: "close",
			assistantText: "",
			events: [],
			managedAuthority: original.managedAuthority!,
			mapping: {
				chatId: original.chatId,
				projectId: original.projectId,
				sessionId: original.sessionId,
				rawFrameCursor: original.rawFrameCursor,
				eventCursor: original.eventCursor,
				operationId: "managed-close",
			},
			correlation: { closeStatus: "closed", mappingOperationId: original.operationId },
		});
		mappings.upsertScoped(scope, { ...original, operationId: "turn-2" });
		mappings.close();
		mappings = fixture.reopen();
		const ingressIds: string[] = [];
		const reaper = reaperFor(
			mappings,
			runtimeFor(
				async request => {
					ingressIds.push(request.requestKey);
					return { ok: true, result: { sessionId: request.target.sessionId } };
				},
				async () => ({ status: "retired" }),
			),
		);
		await reaper.runOnce();

		expect(ingressIds[0]).toContain(":rearmed:turn-2:1");
		expect(mappings.entries()).toHaveLength(0);
		await reaper.stop();
		mappings.close();
		await fixture.cleanup();
	});

	test("restart preserves manual pending or uncertain close and interrupted turn exclusion", async () => {
		for (const kind of ["close", "prompt"] as const) {
			for (const state of ["pending", "uncertain"] as const) {
				const fixture = await createV3Fixture();
				let mappings = fixture.mappings;
				const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
				mappings.beginOperationScoped(scope, { id: "interrupted", kind, ingressId: "interrupted", detail: "hash" });
				if (state === "uncertain") mappings.transitionOperationScoped(scope, "interrupted", state, "hash");
				mappings.close();
				mappings = fixture.reopen();
				let closes = 0;
				const reaper = reaperFor(
					mappings,
					runtimeFor(
						async request => {
							closes += 1;
							return { ok: true, result: { sessionId: request.target.sessionId } };
						},
						async () => ({ status: "retired" }),
					),
				);
				await reaper.runOnce();
				expect(closes).toBe(0);
				expect(mappings.operationScoped(scope, "interrupted")?.state).toBe("uncertain");
				expect(mappings.getScoped(scope)).toBeDefined();
				await reaper.stop();
				mappings.close();
				await fixture.cleanup();
			}
		}
	});
	test("revalidates activity and every authority dimension before preparing close", async () => {
		const fixture = await createV3Fixture();
		const records = createManagedV3GenerationStore(fixture.mappings);
		const record = (await records.active())[0]!;
		for (const change of [
			{ principalId: "foreign" },
			{ projectId: "foreign" },
			{ canonicalWorkspace: "/other" },
			{ chatId: "foreign" },
			{ sessionId: "foreign" },
			{ generation: 2 },
			{ leaseId: "foreign" },
			{ epoch: "foreign" },
		]) {
			const foreign = { ...record, authority: { ...record.authority, ...change } };
			await expect(
				records.prepareClose(foreign, {
					key: "foreign-close",
					authority: foreign.authority,
					requestedAt: Date.now(),
				}),
			).resolves.toBe(false);
		}
		await expect(
			records.prepareClose(
				{ ...record, lastActivityAt: record.lastActivityAt - 1 },
				{ key: "stale-close", authority: record.authority, requestedAt: Date.now() },
			),
		).resolves.toBe(false);
		expect(
			fixture.mappings
				.operationsScoped({ principalId: record.authority.principalId, chatId: record.authority.chatId })
				.filter(operation => operation.kind === "close"),
		).toEqual([]);
		fixture.mappings.close();
		await fixture.cleanup();
	});
	test("completed retirement is never redispatched after canonical store reopen", async () => {
		const fixture = await createV3Fixture();
		let closes = 0;
		const runtime = runtimeFor(
			async request => {
				closes += 1;
				return { ok: true, result: { sessionId: request.target.sessionId } };
			},
			async () => ({ status: "retired" }),
		);
		const first = reaperFor(fixture.mappings, runtime);
		await first.runOnce();
		await first.stop();
		fixture.mappings.close();
		const reopened = fixture.reopen();
		const second = reaperFor(reopened, runtime);
		await second.runOnce();
		expect(closes).toBe(1);
		expect(reopened.entries()).toEqual([]);
		await second.stop();
		reopened.close();
		await fixture.cleanup();
	});
	test.each(["eviction", "publication"] as const)(
		"recovers failed %s after persisted retirement and actual reopen without remote re-close",
		async phase => {
			const fixture = await createV3Fixture();
			let mappings = fixture.mappings;
			const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
			const failure = new Error(`${phase} failed`);
			let closes = 0;
			const runtime = runtimeFor(
				async request => {
					closes += 1;
					return { ok: true, result: { sessionId: request.target.sessionId } };
				},
				async () => ({ status: "retired" }),
			);
			const records = createManagedV3GenerationStore(mappings);
			const published = new Set<string>();
			const publicationAttempts: string[] = [];
			records.publishRetired = async (_record, intent) => {
				publicationAttempts.push(intent.key);
				published.add(intent.key);
				// The external effect may succeed before its acknowledgement fails.
				if (phase === "publication") throw failure;
			};
			if (phase === "eviction")
				records.evict = async () => {
					throw failure;
				};
			const first = reaperFor(mappings, runtime, undefined, undefined, records);
			try {
				await expect(first.runOnce()).rejects.toBe(failure);
				await first.stop();
				const record = (await records.active())[0]!;
				expect(record.state).toBe("closing");
				const intent = (await records.pendingRetirement(record))!;
				const receipt = mappings.operationScoped(scope, intent.key);
				expect(receipt).toMatchObject({ state: "complete", result: { correlation: { closeStatus: "closed" } } });
				expect(mappings.getScoped(scope)).toBeDefined();
				mappings.close();
				mappings = fixture.reopen();
				expect(mappings.operationScoped(scope, intent.key)).toEqual(receipt);
				const reopenedRecords = createManagedV3GenerationStore(mappings);
				const reopenedRecord = (await reopenedRecords.active())[0]!;
				expect(reopenedRecord.state).toBe("closing");
				expect(await reopenedRecords.pendingRetirement(reopenedRecord)).toEqual(intent);
				reopenedRecords.publishRetired = async (_record, recovered) => {
					publicationAttempts.push(recovered.key);
					published.add(recovered.key);
				};
				const forbidden = async (): Promise<never> => {
					throw new Error("Recovery must not invoke the remote runtime.");
				};
				const recovered = reaperFor(
					mappings,
					{
						closeLifecycleSession: forbidden,
						reconcile: forbidden,
						generationStatus: forbidden,
					},
					undefined,
					undefined,
					reopenedRecords,
				);
				await recovered.runOnce();
				await recovered.stop();
				expect(closes).toBe(1);
				expect(publicationAttempts).toEqual([intent.key, intent.key]);
				expect([...published]).toEqual([intent.key]);
				expect(mappings.entries()).toEqual([]);
				mappings.close();
				mappings = fixture.reopen();
				expect(mappings.entries()).toEqual([]);
			} finally {
				mappings.close();
				await fixture.cleanup();
			}
		},
	);
	test("local retirement recovery refuses changed authority and a substituted completed receipt", async () => {
		const fixture = await createV3Fixture();
		const records = createManagedV3GenerationStore(fixture.mappings);
		const record = (await records.active())[0]!;
		const intent = { key: "exact-retirement", authority: record.authority, requestedAt: Date.now() };
		try {
			await records.prepareClose(record, intent);
			await records.retire(record, intent);
			for (const change of [
				{ principalId: "foreign" },
				{ projectId: "foreign" },
				{ canonicalWorkspace: "/foreign" },
				{ chatId: "foreign" },
				{ sessionId: "foreign" },
				{ generation: 2 },
				{ leaseId: "foreign" },
				{ epoch: "foreign" },
				{ requestKey: "foreign" },
			]) {
				const foreign = { ...record, authority: { ...record.authority, ...change } };
				expect(await records.pendingRetirement(foreign)).toBeUndefined();
				await expect(records.evict(foreign, intent)).rejects.toThrow("receipt changed");
			}
			await expect(records.evict(record, { ...intent, key: "other" })).rejects.toThrow("receipt changed");
			expect((await records.active())[0]?.state).toBe("closing");
		} finally {
			fixture.mappings.close();
			await fixture.cleanup();
		}
	});
	test("does not evict after the live tenant fence fails", async () => {
		const fixture = await createV3Fixture();
		const { mappings, mapping } = fixture;
		let fenceChecks = 0;
		const reaper = reaperFor(
			mappings,
			runtimeFor(
				async request => ({ ok: true, result: { sessionId: request.target.sessionId } }),
				async () => ({ status: "retired" }),
			),
			async () => {
				fenceChecks += 1;
				if (fenceChecks >= 3) throw new Error("fence lost");
			},
		);

		await expect(reaper.runOnce()).rejects.toThrow("fence lost");

		expect(fenceChecks).toBeGreaterThanOrEqual(3);
		expect(mappings.getScoped({ principalId: mapping.principalId!, chatId: mapping.chatId })).toBeDefined();
		await reaper.stop();
		mappings.close();
		await fixture.cleanup();
	});
});
