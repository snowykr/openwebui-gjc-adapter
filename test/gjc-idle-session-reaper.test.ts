import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import {
	createManagedLifecycleEvidence,
	lifecycleExactAuthority,
	lifecyclePreparedAuthority,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import { parseSessionAuthorityV3Document, SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
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
import { FakeManagedSdkRuntime, writeDirectV3Authority } from "./cli-fixtures";

const project = {
	id: "project-1",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

// Synthetic public Router observation; this fixture does not supply production exact-close authority.
const retirementEvidence = {
	source: "session_index",
	observedIndexSeq: 3,
	evidenceIndexSeq: 3,
	event: "session_closed",
} as const;

function managedRuntimeFixture() {
	const accounting = new FakeManagedSdkRuntime();
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
		createProducerScope: () => accounting.createProducerScope(),
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
		const authority = mapping.managedAuthority!;
		const payloadHash = "a".repeat(64);
		const operation = {
			id: mapping.operationId,
			kind: "create" as const,
			ingressId: mapping.operationId,
			detail: payloadHash,
			chatId: mapping.chatId,
			projectId: mapping.projectId,
		};
		initial.reserveProvisionalOperationScoped(scope, operation);
		let lifecycle = createManagedLifecycleEvidence({
			operation: "session.create",
			preparedAuthority: lifecyclePreparedAuthority(authority),
			target: { path: authority.canonicalWorkspace, kind: "existing_path" },
			payloadHash,
		});
		initial.recordLifecycleEvidenceScoped(scope, operation.id, payloadHash, lifecycle);
		lifecycle = transitionManagedLifecycleEvidence(lifecycle, "invoking");
		initial.recordLifecycleEvidenceScoped(scope, operation.id, payloadHash, lifecycle);
		lifecycle = transitionManagedLifecycleEvidence(lifecycle, "acknowledged_unproven", {
			acknowledged: lifecycleExactAuthority(authority),
		});
		initial.recordLifecycleEvidenceScoped(scope, operation.id, payloadHash, lifecycle);
		lifecycle = transitionManagedLifecycleEvidence(lifecycle, "active_generation_proven", {
			proven: {
				kind: "managed-generation",
				sessionId: authority.sessionId,
				generation: authority.generation,
				leaseId: authority.leaseId,
				epoch: authority.epoch,
			},
		});
		initial.recordLifecycleEvidenceScoped(scope, operation.id, payloadHash, lifecycle);
		initial.publishProvisionalOperationScoped(scope, operation, mapping);
		initial.close();
		return {
			authorityPath,
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
				return { status: "retired", evidence: retirementEvidence };
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
		const intent = {
			key: "managed-close-prepare",
			authority: record!.authority,
			requestedAt: Date.now(),
		};
		const prepared = await records.prepareClose(record!, intent);
		expect(prepared).toBe(true);
		expect(fixture.mappings.operationScoped(record!.authority, intent.key)?.lifecycle).toMatchObject({
			state: "closing",
			sourceProofRef: { operationId: fixture.mapping.operationId },
		});
		const beforeAcknowledgement = await readFile(fixture.authorityPath, "utf8");
		await expect(records.retire(record!, intent, retirementEvidence)).rejects.toThrow(
			"durable successful close acknowledgement",
		);
		expect(await readFile(fixture.authorityPath, "utf8")).toBe(beforeAcknowledgement);
		await records.acknowledge(record!, intent, record!.authority.sessionId);
		await records.retire(record!, intent, retirementEvidence);
		expect(fixture.mappings.operationScoped(record!.authority, intent.key)).toMatchObject({
			state: "complete",
			lifecycle: { state: "retired", retirement: { evidence: retirementEvidence } },
		});
		await records.evict(record!, intent);
		expect(
			fixture.mappings.getScoped({ principalId: record!.authority.principalId, chatId: record!.authority.chatId }),
		).toBeUndefined();
		fixture.mappings.close();
		await fixture.cleanup();
	});

	test("retryable rejection remains uncertain under the same exact key after actual reopen without redispatch", async () => {
		const fixture = await createV3Fixture();
		let { mappings } = fixture;
		const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
		let now = Date.now() + 100_000;
		const ingressIds: string[] = [];
		const authorities: unknown[] = [];
		const runtime = runtimeFor(
			async request => {
				ingressIds.push(request.requestKey);
				authorities.push({ tenant: request.tenant, target: request.target });
				return { ok: false, certainty: "retryable" };
			},
			async () => {
				throw new Error("A rejected close must not query retirement.");
			},
		);
		const first = reaperFor(
			mappings,
			runtime,
			async () => undefined,
			() => now,
		);
		await expect(first.runOnce()).rejects.toThrow("matching success and exact retirement");
		await first.stop();
		const prior = mappings.operationScoped(scope, ingressIds[0]!);
		expect(prior).toMatchObject({ state: "uncertain", lifecycle: { state: "uncertain" } });
		expect(prior?.lifecycle?.requestKey).toBe(ingressIds[0]);
		expect(prior?.lifecycle?.closeAcknowledgement).toBeUndefined();
		expect(prior?.lifecycle?.source).toEqual(lifecycleExactAuthority(fixture.mapping.managedAuthority!));
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

		expect(ingressIds).toHaveLength(1);
		const { requestKey: _requestKey, ...tenant } = lifecycleExactAuthority(fixture.mapping.managedAuthority!);
		expect(authorities).toEqual([
			{ tenant, target: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation } },
		]);
		expect(mappings.operationScoped(scope, ingressIds[0]!)).toEqual(prior);
		expect(mappings.operationsScoped(scope).filter(operation => operation.kind === "close")).toEqual([prior!]);
		expect(mappings.getScoped(scope)?.managedAuthority).toEqual(fixture.mapping.managedAuthority);
		await restarted.stop();
		mappings.close();
		await fixture.cleanup();
	});

	test("a persisted idle-close conflict cannot authorize a retry after reopen", async () => {
		const fixture = await createV3Fixture();
		let mappings = fixture.mappings;
		const records = createManagedV3GenerationStore(mappings);
		const record = (await records.active())[0]!;
		const authority = record.authority;
		const identity = [
			authority.principalId,
			authority.projectId,
			authority.canonicalWorkspace,
			authority.chatId,
			authority.sessionId,
			authority.generation,
			authority.leaseId,
			authority.epoch,
		].join("\u0000");
		const key = `managed-idle-close:${createHash("sha256").update(identity).digest("hex")}`;
		const intent = { key, authority, requestedAt: Date.now() };
		try {
			expect(await records.prepareClose(record, intent)).toBe(true);
			const reserved = mappings.operationScoped(authority, key)!;
			mappings.transitionOperationScoped(authority, key, "conflict", reserved.detail);
			mappings.close();
			mappings = fixture.reopen();
			const before = await readFile(fixture.authorityPath, "utf8");
			const forbidden = async (): Promise<never> => {
				throw new Error("Conflict is not not-applied proof.");
			};
			const restarted = reaperFor(mappings, {
				closeLifecycleSession: forbidden,
				reconcile: forbidden,
				generationStatus: forbidden,
			});
			await restarted.runOnce();
			await restarted.stop();
			expect((await createManagedV3GenerationStore(mappings).active())[0]?.state).toBe("uncertain");
			expect(mappings.operationScoped(authority, key)?.state).toBe("conflict");
			expect(await readFile(fixture.authorityPath, "utf8")).toBe(before);
		} finally {
			mappings.close();
			await fixture.cleanup();
		}
	});

	test("a new mapping operation ID cannot rearm a retired exact generation after reopen", async () => {
		const fixture = await createV3Fixture();
		let { mappings } = fixture;
		const { mapping: original } = fixture;
		const scope = { principalId: original.principalId!, chatId: original.chatId };
		const records = createManagedV3GenerationStore(mappings);
		const record = (await records.active())[0]!;
		const intent = { key: "managed-close", authority: record.authority, requestedAt: Date.now() };
		expect(await records.prepareClose(record, intent)).toBe(true);
		await records.acknowledge(record, intent, record.authority.sessionId);
		await records.retire(record, intent, retirementEvidence);
		mappings.beginOperationScoped(scope, { id: "turn-2", kind: "prompt", ingressId: "turn-2", detail: "turn-2" });
		mappings.completeOperationWithMappingScoped(
			scope,
			"turn-2",
			"turn-2",
			{ ...original, operationId: "turn-2" },
			"turn",
		);
		mappings.close();
		mappings = fixture.reopen();
		const before = JSON.stringify(mappings.operationsScoped(scope));
		const beforeBytes = await readFile(fixture.authorityPath, "utf8");
		const ingressIds: string[] = [];
		const reaper = reaperFor(
			mappings,
			runtimeFor(
				async request => {
					ingressIds.push(request.requestKey);
					return { ok: true, result: { sessionId: request.target.sessionId } };
				},
				async () => ({ status: "retired", evidence: retirementEvidence }),
			),
		);
		await reaper.runOnce();
		const reopenedRecords = createManagedV3GenerationStore(mappings);
		const reopenedRecord = (await reopenedRecords.active())[0]!;
		expect(reopenedRecord.state).toBe("uncertain");
		expect(
			await reopenedRecords.prepareClose(reopenedRecord, {
				key: "new-close-key",
				authority: reopenedRecord.authority,
				requestedAt: Date.now(),
			}),
		).toBe(false);

		expect(ingressIds).toEqual([]);
		expect(JSON.stringify(mappings.operationsScoped(scope))).toBe(before);
		expect(await readFile(fixture.authorityPath, "utf8")).toBe(beforeBytes);
		expect(mappings.getScoped(scope)?.managedAuthority).toEqual(original.managedAuthority);
		expect(mappings.operationScoped(scope, intent.key)?.lifecycle?.state).toBe("retired");
		await reaper.stop();
		mappings.close();
		await fixture.cleanup();
	});

	test.each([
		{ name: "missing", evidence: undefined },
		{ name: "missing evidence sequence", evidence: { source: "session_index", observedIndexSeq: 3 } },
		{ name: "non-index", evidence: { ...retirementEvidence, source: "endpoint" } },
		{ name: "nonpositive sequence", evidence: { ...retirementEvidence, evidenceIndexSeq: 0 } },
		{ name: "unobserved sequence", evidence: { ...retirementEvidence, evidenceIndexSeq: 4 } },
		{ name: "non-retirement event", evidence: { ...retirementEvidence, event: "session_opened" } },
	])("rejects $name positive retirement evidence and retains acknowledgement across reopen", async ({ evidence }) => {
		const fixture = await createV3Fixture();
		let mappings = fixture.mappings;
		const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
		const closeKeys: string[] = [];
		const runtime = runtimeFor(
			async request => {
				closeKeys.push(request.requestKey);
				return { ok: true, result: { sessionId: request.target.sessionId } };
			},
			async () => ({ status: "retired", ...(evidence === undefined ? {} : { evidence }) }),
		);
		const first = reaperFor(mappings, runtime);
		try {
			await expect(first.runOnce()).rejects.toThrow("retirement");
			await first.stop();
			const receipt = mappings.operationScoped(scope, closeKeys[0]!)!;
			expect(receipt).toMatchObject({
				state: "uncertain",
				lifecycle: {
					state: "uncertain",
					closeAcknowledgement: { sessionId: fixture.mapping.sessionId, generation: 1 },
				},
			});
			expect(receipt.lifecycle?.retirement).toBeUndefined();
			expect(receipt.result).toBeUndefined();
			expect(mappings.getScoped(scope)?.managedAuthority).toEqual(fixture.mapping.managedAuthority);
			mappings.close();
			mappings = fixture.reopen();
			expect(mappings.operationScoped(scope, closeKeys[0]!)).toEqual(receipt);
			const restarted = reaperFor(mappings, runtime);
			await restarted.runOnce();
			await restarted.stop();
			expect(closeKeys).toHaveLength(1);
			expect(mappings.operationsScoped(scope).filter(operation => operation.kind === "close")).toEqual([receipt]);
		} finally {
			mappings.close();
			await fixture.cleanup();
		}
	});

	test("persists matching acknowledgement before status failure and reopens without remote redispatch", async () => {
		const fixture = await createV3Fixture();
		let mappings = fixture.mappings;
		const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
		const failure = new Error("status unavailable");
		const closeKeys: string[] = [];
		const observations: string[] = [];
		const runtime: ManagedIdleLifecycleRuntime = {
			closeLifecycleSession: async request => {
				closeKeys.push(request.requestKey);
				return { ok: true, result: { sessionId: request.target.sessionId } };
			},
			reconcile: async () => {
				const persisted = parseSessionAuthorityV3Document(await readFile(fixture.authorityPath, "utf8"));
				const receipt = persisted?.mappings[0]?.journal.find(operation => operation.id === closeKeys[0]);
				expect(receipt?.lifecycle?.closeAcknowledgement).toMatchObject({
					sessionId: fixture.mapping.sessionId,
					generation: 1,
				});
				observations.push("durable acknowledgement");
			},
			generationStatus: async () => {
				observations.push("status failure");
				throw failure;
			},
		};
		const first = reaperFor(mappings, runtime);
		try {
			await expect(first.runOnce()).rejects.toBe(failure);
			await first.stop();
			expect(observations).toEqual(["durable acknowledgement", "status failure"]);
			const receipt = mappings.operationScoped(scope, closeKeys[0]!)!;
			expect(receipt).toMatchObject({
				state: "uncertain",
				lifecycle: {
					state: "uncertain",
					closeAcknowledgement: { sessionId: fixture.mapping.sessionId, generation: 1 },
				},
			});
			expect(receipt.lifecycle?.retirement).toBeUndefined();
			mappings.close();
			mappings = fixture.reopen();
			expect(mappings.operationScoped(scope, closeKeys[0]!)).toEqual(receipt);
			const forbidden = async (): Promise<never> => {
				throw new Error("Uncertain close requires external reconciliation.");
			};
			const restarted = reaperFor(mappings, {
				closeLifecycleSession: forbidden,
				reconcile: forbidden,
				generationStatus: forbidden,
			});
			await restarted.runOnce();
			await restarted.stop();
			expect(closeKeys).toHaveLength(1);
			expect(mappings.getScoped(scope)?.managedAuthority).toEqual(fixture.mapping.managedAuthority);
		} finally {
			mappings.close();
			await fixture.cleanup();
		}
	});

	test("restart preserves pending, uncertain, and conflict close or interrupted turn exclusion", async () => {
		for (const kind of ["close", "prompt"] as const) {
			for (const state of ["pending", "uncertain", "conflict"] as const) {
				const fixture = await createV3Fixture();
				let mappings = fixture.mappings;
				const scope = { principalId: fixture.mapping.principalId!, chatId: fixture.mapping.chatId };
				mappings.beginOperationScoped(scope, { id: "interrupted", kind, ingressId: "interrupted", detail: "hash" });
				if (state !== "pending") mappings.transitionOperationScoped(scope, "interrupted", state, "hash");
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
						async () => ({ status: "retired", evidence: retirementEvidence }),
					),
				);
				await reaper.runOnce();
				expect(closes).toBe(0);
				expect(mappings.operationScoped(scope, "interrupted")?.state).toBe(
					state === "pending" ? "uncertain" : state,
				);
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
			{ requestKey: "foreign" },
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
			async () => ({ status: "retired", evidence: retirementEvidence }),
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
				async () => ({ status: "retired", evidence: retirementEvidence }),
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
			await records.acknowledge(record, intent, record.authority.sessionId);
			await records.retire(record, intent, retirementEvidence);
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
				async () => ({ status: "retired", evidence: retirementEvidence }),
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
