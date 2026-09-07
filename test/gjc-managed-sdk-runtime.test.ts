import { describe, expect, spyOn, test } from "bun:test";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import {
	createManagedLifecycleEvidence,
	type ManagedHistoricalSavedSession,
	managedLifecycleEvidenceHash,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import {
	type ManagedSdkAccess,
	type ManagedSdkCatalogAccess,
	type ManagedSdkCatalogQueryOptions,
	type ManagedSdkCatalogReference,
	type ManagedSdkHistoricalSelection,
	type ManagedSdkLifecycleOperation,
	ManagedSdkRuntime,
	type ManagedSdkRuntimeDeps,
	type TenantSessionKey,
} from "../src/gjc/managed-sdk-runtime";
import type { ProvisionalSessionOperation } from "../src/gjc/session-authority-types";
import type { ManagedPreparedTurnAuthority } from "../src/gjc/turn-runner";
import { acquireWorkspaceAdmission } from "../src/live/chat-completions";
import { createManagedModelReaderFactory } from "../src/live/gjc-managed-model-reader";
import type { ModelReaderContext } from "../src/live/model-reader";
import { handleOpenAIModelsRequest } from "../src/live/openai-models-route";
import type { AdapterRouteDependencies } from "../src/live/openai-routes";

type LifecycleService = ReturnType<typeof lifecycle.createSessionLifecycleService>;
type CloseRequest = Parameters<LifecycleService["close"]>[0];
type CreateRequest = Parameters<LifecycleService["createExternal"]>[0];
type ResumeRequest = Parameters<LifecycleService["resumeExternal"]>[0];
type ListRequest = Parameters<LifecycleService["list"]>[0];
type HistoricalResumeRequest = Parameters<LifecycleService["resume"]>[0];

function historicalSelection(): ManagedSdkHistoricalSelection {
	return {
		manifestDigest: "b".repeat(64),
		preparedAuthority: { ...preparedAuthority(), requestKey: "migration:resume:key-1" },
		historicalBinding: {
			kind: "unbound-history",
			principalId: tenant.principalId,
			projectId: tenant.projectId,
			canonicalWorkspace: tenant.canonicalWorkspace,
			chatId: tenant.chatId,
			sessionId: tenant.sessionId,
			reason: "generation-unproven",
			provenance: { source: "v2", documentHash: "c".repeat(64), nodeRef: "/mappings/0", nodeHash: "d".repeat(64) },
		},
	};
}

function savedSession(): ManagedHistoricalSavedSession {
	return {
		id: tenant.sessionId,
		path: "/workspace/project-1/.gjc/sessions/saved.jsonl",
		identity: {
			dev: "1",
			ino: "42",
			size: 123,
			mtimeMs: 1234,
			mtimeNs: "1234000000",
			sha256: "a".repeat(64),
			nlink: "1",
			ctimeNs: "1234000000",
		},
	};
}

function historicalEvidence() {
	const selection = historicalSelection();
	const saved = savedSession();
	const { nlink: _nlink, ctimeNs: _ctimeNs, ...sessionIdentity } = saved.identity;
	return transitionManagedLifecycleEvidence(
		createManagedLifecycleEvidence({
			operation: "session.resume",
			preparedAuthority: selection.preparedAuthority,
			payloadHash: "e".repeat(64),
			historicalSource: {
				kind: "bootstrap-history",
				manifestDigest: selection.manifestDigest,
				historicalBinding: selection.historicalBinding,
				savedSession: saved,
			},
			target: {
				sessionId: saved.id,
				cwd: selection.preparedAuthority.canonicalWorkspace,
				sessionPath: saved.path,
				sessionIdentity,
			},
		}),
		"invoking",
	);
}

function historicalList(saved = savedSession()): Awaited<ReturnType<LifecycleService["list"]>> {
	return {
		ok: true,
		operation: "session.list",
		result: {
			indexSeq: 1,
			sessions: [{ sessionId: "unrelated-session", cwd: "/foreign" }],
			warnings: ["private warning"],
			savedSession: saved,
		},
	};
}

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

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function closeRequest(): CloseRequest {
	return {
		actor: { id: tenant.principalId, namespace: "openwebui-gjc-adapter" },
		capability: "session.close",
		requestKey: "close-1",
		target: {
			sessionId: tenant.sessionId,
			endpointGeneration: tenant.generation,
			// Synthetic authority for boundary tests, not evidence of a persisted public lifecycle receipt.
			endpointIncarnation: "0123456789abcdef".repeat(4),
		},
		timeoutMs: 500,
	};
}

function operationIdentity(): ManagedSdkLifecycleOperation {
	return { operationId: "operation-1", requestKey: "close-1", payloadHash: "a".repeat(64) };
}

function preparedAuthority(): ManagedPreparedTurnAuthority {
	return {
		principalId: tenant.principalId,
		projectId: tenant.projectId,
		canonicalWorkspace: tenant.canonicalWorkspace,
		chatId: tenant.chatId,
		leaseId: tenant.leaseId,
		epoch: tenant.epoch,
		requestKey: "create-1",
	};
}

function createRequest(): CreateRequest {
	return {
		actor: { id: tenant.principalId, namespace: "openwebui-gjc-adapter" },
		capability: "session.create",
		requestKey: "create-1",
		target: { kind: "existing_path", path: tenant.canonicalWorkspace },
		readinessTimeoutMs: 4_000,
	};
}

function listRequest(): ListRequest {
	return {
		actor: closeRequest().actor,
		capability: "session.list",
		target: { cwd: tenant.canonicalWorkspace, resolveSessionId: tenant.sessionId },
		timeoutMs: 500,
	};
}

function observedFrame(seq: number): router.SessionRouterFrame {
	return {
		body: {},
		name: "event",
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		commandId: "queued-command",
		seq,
	};
}

function fixture(
	options: {
		start?: () => Promise<void>;
		stop?: () => Promise<void>;
		fence?: ManagedSdkRuntimeDeps["tenantFence"];
		preparedFence?: ManagedSdkRuntimeDeps["preparedTenantFence"];
		historicalSelectionFence?: ManagedSdkRuntimeDeps["historicalSelectionFence"];
		historicalResumeFence?: ManagedSdkRuntimeDeps["historicalResumeFence"];
		historicalSelectionFenceSync?: ManagedSdkRuntimeDeps["historicalSelectionFenceSync"];
		historicalResumeFenceSync?: ManagedSdkRuntimeDeps["historicalResumeFenceSync"];
		omitHistoricalSync?: boolean;
		catalogFence?: ManagedSdkRuntimeDeps["catalogFence"];
		catalogFenceSync?: ManagedSdkRuntimeDeps["catalogFenceSync"];
		beforeRouterDispatch?: () => Promise<void>;
		omitTenantFence?: boolean;
		omitPreparedFence?: boolean;
		request?: () => Promise<Record<string, unknown>>;
		onMutation?: () => void | Promise<void>;
		close?: LifecycleService["close"];
		list?: LifecycleService["list"];
		historicalResume?: LifecycleService["resume"];
		reconcile?: () => Promise<void>;
		generationStatus?: router.SessionRouter["generationStatus"];
		maxFrames?: number;
		drainTimeoutMs?: number;
	} = {},
) {
	let onFrame:
		| ((attachment: router.SessionAttachment, frame: router.SessionRouterFrame) => Promise<void> | void)
		| undefined;
	const attachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const foreignAttachment = {
		sessionId: tenant.sessionId,
		generation: tenant.generation,
		isCurrent: () => true,
		send: () => undefined,
	} as router.SessionAttachment;
	const calls: string[] = [];
	const closeCalls: CloseRequest[] = [];
	const createCalls: CreateRequest[] = [];
	const internalCreateCalls: Array<Parameters<LifecycleService["create"]>[0]> = [];
	const forkCalls: Array<Parameters<LifecycleService["fork"]>[0]> = [];
	const resumeCalls: ResumeRequest[] = [];
	const listCalls: ListRequest[] = [];
	const historicalResumeCalls: HistoricalResumeRequest[] = [];
	const historicalOutcomes: Awaited<ReturnType<LifecycleService["resume"]>>[] = [];
	const statusCalls: Array<{ sessionId: string; generation: number }> = [];
	const routerRequests: Array<{
		sessionId: string;
		frame: Record<string, unknown>;
		generation: number;
		expected: router.SessionAttachment;
		timeoutMs?: number;
	}> = [];
	let currentAttachment = attachment;
	const lifecycleService: Pick<
		LifecycleService,
		"close" | "create" | "fork" | "createExternal" | "resumeExternal" | "resume" | "list" | "delete"
	> = {
		async close(request) {
			closeCalls.push(request);
			await options.onMutation?.();
			if (options.close !== undefined) return await options.close(request);
			return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
		},
		async createExternal(request) {
			createCalls.push(request);
			await options.onMutation?.();
			return { ok: true, operation: "session.create", result: { sessionId: "created", endpointGeneration: 1 } };
		},
		async create(request) {
			internalCreateCalls.push(request);
			await options.onMutation?.();
			return { ok: true, operation: "session.create", result: { sessionId: "created", endpointGeneration: 1 } };
		},
		async fork(request) {
			forkCalls.push(request);
			await options.onMutation?.();
			return { ok: true, operation: "session.fork", result: { sessionId: "forked", endpointGeneration: 1 } };
		},
		async resumeExternal(request) {
			resumeCalls.push(request);
			await options.onMutation?.();
			return {
				kind: "result",
				outcome: {
					ok: true,
					operation: "session.resume",
					result: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
				},
			};
		},
		async list(request) {
			listCalls.push(request);
			if (options.list !== undefined) return await options.list(request);
			return { ok: true, operation: "session.list", result: { indexSeq: 1, sessions: [], warnings: [] } };
		},
		async resume(request) {
			historicalResumeCalls.push(request);
			await options.onMutation?.();
			if (options.historicalResume !== undefined) return options.historicalResume(request);
			return {
				ok: true,
				operation: "session.resume",
				result: { sessionId: request.target.sessionId, endpointGeneration: 1 },
			};
		},
		async delete() {
			calls.push("delete");
			throw new Error("Delete must never dispatch.");
		},
	};
	const sessionRouter = {
		async start() {
			calls.push("start");
			await options.start?.();
		},
		async stop() {
			calls.push("stop");
			await options.stop?.();
		},
		async reconcile() {
			calls.push("reconcile");
			await options.reconcile?.();
		},
		attachment(sessionId: string, generation?: number) {
			return sessionId === tenant.sessionId && generation === tenant.generation ? currentAttachment : null;
		},
		async request(
			_sessionId: string,
			_frame: Record<string, unknown>,
			_generation: number,
			_expected: router.SessionAttachment,
			requestOptions?: {
				timeoutMs?: number;
				beforeDispatch?: (context: never) => void;
				onDispatch?: (context: never) => void;
			},
		) {
			if (options.beforeRouterDispatch !== undefined) await options.beforeRouterDispatch();
			requestOptions?.beforeDispatch?.({} as never);
			routerRequests.push({
				sessionId: _sessionId,
				frame: _frame,
				generation: _generation,
				expected: _expected,
				timeoutMs: requestOptions?.timeoutMs,
			});
			calls.push("request");
			requestOptions?.onDispatch?.({} as never);
			if (options.request !== undefined) return await options.request();
			return { ok: true };
		},
		async generationStatus(sessionId: string, generation: number) {
			statusCalls.push({ sessionId, generation });
			if (options.generationStatus !== undefined) return options.generationStatus(sessionId, generation);
			return {
				status: "retired",
				evidence: { source: "session_index", observedIndexSeq: 1, evidenceIndexSeq: 1, event: "session_closed" },
			};
		},
	} as unknown as router.SessionRouter;
	const runtime = new ManagedSdkRuntime({
		agentDir: "/agent",
		deps: {
			createRouter: input => {
				onFrame = input.deps?.onFrame;
				return sessionRouter;
			},
			createLifecycleService: () => lifecycleService as ReturnType<typeof lifecycle.createSessionLifecycleService>,
			...(options.omitTenantFence
				? {}
				: {
						tenantFence: (key: TenantSessionKey, access: ManagedSdkAccess) =>
							options.fence?.(key, access) ?? true,
					}),
			...(options.omitPreparedFence ? {} : { preparedTenantFence: options.preparedFence ?? (() => true) }),
			historicalSelectionFence: options.historicalSelectionFence,
			historicalResumeFence: options.historicalResumeFence,
			historicalSelectionFenceSync: options.omitHistoricalSync
				? undefined
				: (options.historicalSelectionFenceSync ??
					(selection => JSON.stringify(selection) === JSON.stringify(historicalSelection()))),
			historicalResumeFenceSync: options.omitHistoricalSync
				? undefined
				: (options.historicalResumeFenceSync ??
					((id, evidence) =>
						id === "migration:resume:attempt-1" &&
						evidence.state === "invoking" &&
						evidence.historicalSource?.savedSession.id === tenant.sessionId)),
			catalogFence: options.catalogFence,
			catalogFenceSync: options.catalogFenceSync,
			...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
			...(options.maxFrames === undefined ? {} : { maxFramesPerSubscription: options.maxFrames }),
		},
	});
	return {
		runtime,
		attachment,
		foreignAttachment,
		calls,
		closeCalls,
		createCalls,
		internalCreateCalls,
		forkCalls,
		resumeCalls,
		listCalls,
		historicalResumeCalls,
		historicalOutcomes,
		observeHistoricalOutcome: (outcome: Awaited<ReturnType<LifecycleService["resume"]>>) => {
			historicalOutcomes.push(outcome);
		},
		statusCalls,
		routerRequests,
		replaceAttachment() {
			currentAttachment = foreignAttachment;
		},
		emit: async (frame: router.SessionRouterFrame, sourceAttachment = attachment) =>
			await onFrame?.(sourceAttachment, frame),
	};
}

function invokeExternal(
	runtime: ManagedSdkRuntime,
	method: "prepared" | "create" | "resume",
	readiness: { readonly readinessTimeoutMs?: number } = {},
	timeoutMs?: number,
) {
	if (method === "resume")
		return runtime.resumeExternalLifecycleSession(
			tenant,
			{
				actor: closeRequest().actor,
				capability: "session.resume",
				requestKey: "resume-1",
				target: { sessionIdOrPrefix: tenant.sessionId, path: tenant.canonicalWorkspace },
				...readiness,
			},
			timeoutMs,
		);
	const { readinessTimeoutMs: _readiness, ...request } = createRequest();
	return method === "prepared"
		? runtime.createPreparedExternalLifecycleSession(preparedAuthority(), { ...request, ...readiness }, timeoutMs)
		: runtime.createExternalLifecycleSession(tenant, { ...request, ...readiness }, timeoutMs);
}

function catalogReference(
	phase: "acknowledged_unproven" | "active_generation_proven" = "acknowledged_unproven",
): ManagedSdkCatalogReference {
	const original: ProvisionalSessionOperation = {
		id: "catalog-1",
		ingressId: "catalog-ingress-1",
		purpose: "model-catalog",
		kind: "create",
		state: "pending",
		chatId: tenant.chatId,
		projectId: tenant.projectId,
		startedAt: "2026-01-01T00:00:00.000Z",
		detail: "a".repeat(64),
		lifecycle: createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: preparedAuthority(),
				target: { kind: "existing_path", path: tenant.canonicalWorkspace },
				payloadHash: "a".repeat(64),
			},
			"2026-01-01T00:00:00.000Z",
		),
	};
	const acknowledged = transitionManagedLifecycleEvidence(
		transitionManagedLifecycleEvidence(original.lifecycle!, "invoking", {}, "2026-01-01T00:00:01.000Z"),
		"acknowledged_unproven",
		{ acknowledged: { ...tenant, requestKey: preparedAuthority().requestKey } },
		"2026-01-01T00:00:02.000Z",
	);
	const current =
		phase === "acknowledged_unproven"
			? acknowledged
			: transitionManagedLifecycleEvidence(
					acknowledged,
					"active_generation_proven",
					{
						proven: {
							kind: "managed-generation",
							sessionId: tenant.sessionId,
							generation: tenant.generation,
							leaseId: tenant.leaseId,
							epoch: tenant.epoch,
						},
					},
					"2026-01-01T00:00:03.000Z",
				);
	return { original, expectedLifecycleHash: managedLifecycleEvidenceHash(current) };
}

describe("managed SDK runtime", () => {
	test.each(["proof-reconcile", "proof-return", "query-return"] as const)(
		"catalog %s rechecks synchronous authority after successful async validation",
		async boundary => {
			let granted = true;
			let validations = 0;
			const f = fixture({
				catalogFence: async () => {
					const admitted = granted;
					validations += 1;
					if (validations === (boundary === "proof-return" ? 3 : 2))
						queueMicrotask(() => {
							granted = false;
						});
					return admitted;
				},
				catalogFenceSync: () => granted,
			});
			await f.runtime.start();
			try {
				if (boundary === "query-return") {
					f.runtime.registerTenant(tenant);
					await expect(
						f.runtime.queryCatalog(catalogReference("active_generation_proven"), tenant, "session.state", {
							timeoutMs: 500,
						}),
					).rejects.toThrow("fence");
					expect(f.routerRequests).toHaveLength(1);
				} else {
					await expect(f.runtime.proveCatalogSession(catalogReference(), tenant, 500)).rejects.toThrow("fence");
					expect(f.calls.filter(call => call === "reconcile")).toHaveLength(
						boundary === "proof-reconcile" ? 0 : 1,
					);
				}
			} finally {
				await f.runtime.dispose();
			}
		},
	);

	test("catalog proof returns only data and three closed queries never grant active tokens", async () => {
		const proofRef = catalogReference(),
			queryRef = catalogReference("active_generation_proven");
		const accesses: ManagedSdkCatalogAccess[] = [];
		let activeCalls = 0;
		const result = { type: "query_response", ok: true, page: { items: [], complete: true } };
		const f = fixture({
			fence: () => {
				activeCalls += 1;
				return false;
			},
			preparedFence: () => {
				activeCalls += 1;
				return false;
			},
			catalogFence: async (ref, key, access) => {
				accesses.push(access);
				expect(Object.isFrozen(ref.original.lifecycle!.preparedAuthority)).toBe(true);
				expect(Object.isFrozen(key)).toBe(true);
				expect(Object.isFrozen(access)).toBe(true);
				expect(ref).toEqual(access.kind === "proof" ? proofRef : queryRef);
				expect(key).toEqual(tenant);
				return true;
			},
			catalogFenceSync: (ref, key, access) => {
				expect(ref).toEqual(access.kind === "proof" ? proofRef : queryRef);
				expect(key).toEqual(tenant);
				if (access.kind === "query")
					expect(["models.list/current", "providers.list/active", "session.state"]).toContain(access.name);
				return true;
			},
			request: async () => result,
		});
		await f.runtime.start();
		const proof = await f.runtime.proveCatalogSession(proofRef, tenant, 500);
		expect(proof).toEqual({
			kind: "managed-generation",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			leaseId: tenant.leaseId,
			epoch: tenant.epoch,
		});
		expect(Object.keys(proof).sort()).toEqual(["epoch", "generation", "kind", "leaseId", "sessionId"]);
		expect(f.calls).toEqual(["start", "reconcile"]);
		for (const query of ["models.list/current", "providers.list/active", "session.state"] as const) {
			expect(
				await f.runtime.queryCatalog(queryRef, tenant, query, {
					timeoutMs: 500,
					...(query === "session.state" ? {} : { cursor: "opaque-page-2" }),
				}),
			).toBe(result);
			expect(f.routerRequests.at(-1)).toMatchObject({
				sessionId: tenant.sessionId,
				generation: tenant.generation,
				expected: f.attachment,
				frame: {
					type: "query_request",
					query,
					input: {},
					...(query === "session.state" ? {} : { cursor: "opaque-page-2" }),
				},
			});
			if (query === "session.state") expect(f.routerRequests.at(-1)!.frame).not.toHaveProperty("cursor");
			expect(f.routerRequests.at(-1)!.timeoutMs).toBeGreaterThan(0);
			expect(f.routerRequests.at(-1)!.timeoutMs!).toBeLessThanOrEqual(500);
		}
		expect(accesses.filter(access => access.kind === "proof")).toHaveLength(3);
		expect(accesses.filter(access => access.kind === "query")).toHaveLength(6);
		expect(activeCalls).toBe(0);
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		const forged = { tenant, generation: tenant.generation, isCurrent: () => true };
		await expect(f.runtime.request(forged, { type: "control_request", operation: "turn.prompt" })).rejects.toThrow(
			"fence was lost",
		);
		expect(() => f.runtime.subscribeFrames(forged, "turn", { commandId: "command" }, () => {})).toThrow(
			"Manager-issued",
		);
		expect(() => f.runtime.prepareFrameSubscription(forged, "turn", () => {})).toThrow("Manager-issued");
		expect(f.createCalls).toEqual([]);
		expect(f.closeCalls).toEqual([]);
		expect(f.listCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		await f.runtime.dispose();
	});

	test.each(["missing-async", "missing-sync", "denied"] as const)(
		"catalog query denies %s dedicated fencing despite active/prepared grants",
		async mode => {
			const f = fixture({
				catalogFence: mode === "missing-async" ? undefined : async () => mode !== "denied",
				catalogFenceSync: mode === "missing-sync" ? undefined : () => true,
			});
			await f.runtime.start();
			await expect(f.runtime.proveCatalogSession(catalogReference(), tenant)).rejects.toThrow("authority fence");
			f.runtime.registerTenant(tenant);
			await expect(
				f.runtime.queryCatalog(catalogReference("active_generation_proven"), tenant, "session.state", {
					timeoutMs: 500,
				}),
			).rejects.toThrow("fence");
			expect(f.routerRequests).toEqual([]);
			expect(f.createCalls).toEqual([]);
			await f.runtime.dispose();
		},
	);

	test("catalog accepts canonical scoped reservation identity with declared undefined optional values", async () => {
		const ref = catalogReference();
		const original: ProvisionalSessionOperation = {
			...ref.original,
			chatId: JSON.stringify([tenant.principalId, tenant.chatId]),
			sessionId: undefined,
			sessionFile: undefined,
			managedAuthority: undefined,
			historicalBinding: undefined,
			cleanup: undefined,
			lateCreateAcknowledgement: undefined,
			result: undefined,
		};
		const f = fixture({
			catalogFence: async snapshot => {
				expect(snapshot.original).toEqual(original);
				expect(snapshot.expectedLifecycleHash).not.toBe(managedLifecycleEvidenceHash(original.lifecycle!));
				return true;
			},
			catalogFenceSync: () => true,
		});
		await f.runtime.start();
		await expect(f.runtime.proveCatalogSession({ ...ref, original }, tenant)).resolves.toMatchObject({
			kind: "managed-generation",
		});
		await f.runtime.queryCatalog({ ...ref, original }, tenant, "session.state", { timeoutMs: 500 });
		expect(f.routerRequests).toHaveLength(1);
		Reflect.set(original, "unknown", undefined);
		await expect(f.runtime.proveCatalogSession({ ...ref, original }, tenant)).rejects.toThrow();
		await f.runtime.dispose();
	});

	test("catalog rejects malformed reservation, scope, current hash, children and passive evidence before ownership effects", async () => {
		let fences = 0;
		const f = fixture({
			catalogFence: async () => {
				fences += 1;
				return true;
			},
			catalogFenceSync: () => true,
		});
		await f.runtime.start();
		const mutations: Array<(ref: ManagedSdkCatalogReference) => void> = [
			ref => {
				Reflect.set(ref, "expectedLifecycleHash", "x".repeat(64));
			},
			ref => {
				Reflect.set(ref, "expectedLifecycleHash", "a".repeat(63));
			},
			ref => {
				Reflect.set(ref, "admissionHash", "a".repeat(64));
			},
			ref => {
				Reflect.deleteProperty(ref.original, "purpose");
			},
			ref => {
				Reflect.set(ref.original, "purpose", "serving");
			},
			ref => {
				Reflect.set(ref.original, "kind", "close");
			},
			ref => {
				Reflect.set(ref.original, "state", "uncertain");
			},
			ref => {
				Reflect.set(ref.original, "id", "");
			},
			ref => {
				Reflect.set(ref.original, "ingressId", "bad\nidentity");
			},
			ref => {
				Reflect.set(ref.original, "startedAt", "invalid");
			},
			ref => {
				Reflect.set(ref.original, "detail", "b".repeat(64));
			},
			ref => {
				Reflect.set(ref.original, "projectId", "other");
			},
			ref => {
				Reflect.set(ref.original, "chatId", "other");
			},
			ref => {
				Reflect.set(ref.original, "cleanup", {});
			},
			ref => {
				Reflect.set(ref.original, "lateCreateAcknowledgement", {});
			},
			ref => {
				Reflect.set(ref.original, "lateLifecycleAcknowledgement", {});
			},
			ref => {
				Reflect.set(ref.original, "managedAuthority", { ...tenant, requestKey: "key" });
			},
			ref => {
				Reflect.set(ref.original, "historicalBinding", historicalSelection().historicalBinding);
			},
			ref => {
				Reflect.set(ref.original, "sessionId", tenant.sessionId);
			},
			ref => {
				Reflect.set(ref.original, "result", {});
			},
			ref => {
				Reflect.set(ref.original, "completedAt", "2026-01-01T00:00:01.000Z");
			},
			ref => {
				Reflect.set(ref.original, "attachment", {});
			},
			ref => {
				Reflect.set(ref.original.lifecycle!, "state", "invoking");
			},
			ref => {
				Reflect.set(ref.original.lifecycle!.target, "path", "/foreign");
			},
		];
		for (const mutate of mutations) {
			const ref = catalogReference();
			mutate(ref);
			await expect(f.runtime.proveCatalogSession(ref, tenant)).rejects.toThrow();
			await expect(f.runtime.queryCatalog(ref, tenant, "session.state", { timeoutMs: 500 })).rejects.toThrow();
		}
		for (const field of ["principalId", "projectId", "canonicalWorkspace", "chatId", "leaseId", "epoch"] as const) {
			const key = { ...tenant, [field]: "foreign" };
			await expect(f.runtime.proveCatalogSession(catalogReference(), key)).rejects.toThrow();
		}
		await expect(f.runtime.proveCatalogSession(catalogReference(), { ...tenant, generation: 0 })).rejects.toThrow();
		expect(fences).toBe(0);
		expect(f.calls).toEqual(["start"]);
		await f.runtime.dispose();
	});

	test("catalog query accepts no arbitrary names, frames, malformed cursor or undeclared options", async () => {
		const f = fixture({ catalogFence: async () => true, catalogFenceSync: () => true });
		await f.runtime.start();
		const ref = catalogReference();
		for (const invalid of ["turn.prompt", "models.list", "providers.list", "session.close", "", undefined]) {
			const query = { name: "session.state" as const };
			Reflect.set(query, "name", invalid);
			await expect(f.runtime.queryCatalog(ref, tenant, query.name, { timeoutMs: 500 })).rejects.toThrow(
				"query name",
			);
		}
		for (const cursor of ["", " ", " padded", "padded ", "bad\nvalue", 1, {}, null]) {
			const options: ManagedSdkCatalogQueryOptions = { timeoutMs: 500 };
			Reflect.set(options, "cursor", cursor);
			await expect(f.runtime.queryCatalog(ref, tenant, "session.state", options)).rejects.toThrow("cursor");
		}
		for (const field of ["frame", "input", "operation", "onDispatch", "access"]) {
			const options = { timeoutMs: 500, [field]: {} };
			await expect(f.runtime.queryCatalog(ref, tenant, "session.state", options)).rejects.toThrow(
				"declared options",
			);
		}
		const missing = { timeoutMs: 500 };
		Reflect.deleteProperty(missing, "timeoutMs");
		await expect(f.runtime.queryCatalog(ref, tenant, "session.state", missing)).rejects.toThrow(
			"explicit logical timeout",
		);
		expect(f.routerRequests).toEqual([]);
		await f.runtime.dispose();
	});

	test.each(["proof", "query"] as const)(
		"catalog %s owner rejects wrong current hash and exact acknowledged generation",
		async kind => {
			const expected = catalogReference();
			const f = fixture({
				catalogFence: async (ref, key) =>
					ref.expectedLifecycleHash === expected.expectedLifecycleHash &&
					key.sessionId === tenant.sessionId &&
					key.generation === tenant.generation,
				catalogFenceSync: () => true,
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const invoke = (ref: ManagedSdkCatalogReference, key: TenantSessionKey) =>
				kind === "proof"
					? f.runtime.proveCatalogSession(ref, key)
					: f.runtime.queryCatalog(ref, key, "session.state", { timeoutMs: 500 });
			for (const key of [
				{ ...tenant, sessionId: "foreign" },
				{ ...tenant, generation: 8 },
			])
				await expect(invoke(expected, key)).rejects.toThrow("Catalog authority fence");
			await expect(invoke({ ...expected, expectedLifecycleHash: "f".repeat(64) }, tenant)).rejects.toThrow(
				"Catalog authority fence",
			);
			expect(f.calls).toEqual(["start"]);
			await f.runtime.dispose();
		},
	);

	test.each(["proof", "query"] as const)(
		"catalog %s rechecks child/hash revocation after an awaited effect before disclosure",
		async kind => {
			let granted = true;
			const entered = deferred<void>(),
				release = deferred<void>();
			const effect = async () => {
				entered.resolve();
				await release.promise;
			};
			const f = fixture({
				catalogFence: async () => granted,
				catalogFenceSync: () => granted,
				reconcile: effect,
				request: async () => {
					await effect();
					return { secret: "must-not-disclose" };
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const result = (
				kind === "proof"
					? f.runtime.proveCatalogSession(catalogReference(), tenant)
					: f.runtime.queryCatalog(catalogReference("active_generation_proven"), tenant, "session.state", {
							timeoutMs: 500,
						})
			).catch(error => error);
			await entered.promise;
			granted = false;
			release.resolve();
			expect(await result).toBeInstanceOf(Error);
			expect(f.calls.filter(call => call === (kind === "proof" ? "reconcile" : "request"))).toHaveLength(1);
			await f.runtime.dispose();
		},
	);

	test.each(["router-await", "caller-hook"] as const)(
		"catalog synchronous fence rejects child/hash changes during %s before dispatch",
		async seam => {
			let currentHash = catalogReference().expectedLifecycleHash;
			const ref = { ...catalogReference(), expectedLifecycleHash: currentHash };
			const entered = deferred<void>(),
				release = deferred<void>();
			const f = fixture({
				catalogFence: async () => true,
				catalogFenceSync: snapshot => snapshot.expectedLifecycleHash === currentHash,
				beforeRouterDispatch:
					seam === "router-await"
						? async () => {
								entered.resolve();
								await release.promise;
							}
						: undefined,
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const result = f.runtime
				.queryCatalog(ref, tenant, "session.state", {
					timeoutMs: 500,
					beforeDispatch: () => {
						if (seam === "caller-hook") currentHash = "f".repeat(64);
					},
				})
				.catch(error => error);
			if (seam === "router-await") {
				await entered.promise;
				currentHash = "f".repeat(64);
				release.resolve();
			}
			expect(await result).toBeInstanceOf(Error);
			expect(f.routerRequests).toEqual([]);
			expect(f.calls).not.toContain("request");
			await f.runtime.dispose();
		},
	);

	test("catalog snapshots reference/tenant/options and binds the original caller hook receiver before await", async () => {
		const entered = deferred<void>(),
			release = deferred<boolean>();
		const ref = catalogReference("active_generation_proven"),
			expected = structuredClone(ref),
			key = { ...tenant };
		let fences = 0,
			called = 0;
		const snapshots: ManagedSdkCatalogReference[] = [];
		const f = fixture({
			catalogFence: async (snapshot, held) => {
				snapshots.push(snapshot);
				expect(held).toEqual(tenant);
				if (++fences === 1) {
					entered.resolve();
					return release.promise;
				}
				return true;
			},
			catalogFenceSync: snapshot => {
				expect(snapshot).toEqual(expected);
				return true;
			},
		});
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		const options: ManagedSdkCatalogQueryOptions = {
			timeoutMs: 500,
			cursor: "original",
			beforeDispatch() {
				expect(this).toBe(options);
				called += 1;
			},
		};
		const result = f.runtime.queryCatalog(ref, key, "session.state", options);
		await entered.promise;
		Reflect.set(ref, "expectedLifecycleHash", "f".repeat(64));
		Reflect.set(ref.original.lifecycle!.preparedAuthority, "leaseId", "other");
		key.sessionId = "foreign";
		Reflect.set(options, "cursor", "changed");
		Reflect.set(options, "timeoutMs", 1);
		Reflect.set(options, "beforeDispatch", () => {
			throw new Error("replacement hook");
		});
		release.resolve(true);
		await result;
		expect(called).toBe(1);
		expect(snapshots[0]).toEqual(expected);
		expect(snapshots[1]).toBe(snapshots[0]);
		expect(f.routerRequests[0]!.frame.cursor).toBe("original");
		expect(f.routerRequests[0]!.sessionId).toBe(tenant.sessionId);
		await f.runtime.dispose();
	});

	test.each(["lease", "attachment", "budget", "throw"] as const)(
		"catalog rechecks dispatch authority after caller hook changes %s",
		async changed => {
			const f = fixture({ catalogFence: async () => true, catalogFenceSync: () => true });
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			let now = performance.now();
			const clock = spyOn(performance, "now").mockImplementation(() => now);
			const failure = new Error("caller dispatch rejected");
			try {
				const outcome = await f.runtime
					.queryCatalog(catalogReference(), tenant, "session.state", {
						timeoutMs: 500,
						beforeDispatch: () => {
							if (changed === "lease") {
								f.runtime.unregisterTenant(tenant);
								f.runtime.registerTenant(tenant);
							}
							if (changed === "attachment") f.replaceAttachment();
							if (changed === "budget") now += 501;
							if (changed === "throw") throw failure;
						},
					})
					.catch(error => error);
				if (changed === "throw") expect(outcome).toBe(failure);
				else expect(outcome).toBeInstanceOf(Error);
				expect(f.routerRequests).toEqual([]);
				expect(f.calls).not.toContain("request");
			} finally {
				clock.mockRestore();
				await f.runtime.dispose();
			}
		},
	);

	test("catalog query retains the same shrinking budget across async admission and Router dispatch", async () => {
		let now = performance.now();
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		let fences = 0;
		const f = fixture({
			catalogFence: async () => {
				if (++fences === 1) now += 200;
				return true;
			},
			catalogFenceSync: () => true,
		});
		try {
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			await f.runtime.queryCatalog(catalogReference(), tenant, "session.state", { timeoutMs: 500 });
			expect(f.routerRequests[0]!.timeoutMs).toBe(300);
			expect(fences).toBe(2);
		} finally {
			clock.mockRestore();
			await f.runtime.dispose();
		}
	});

	test.each(["proof", "query"] as const)(
		"catalog %s rejects registration ABA and raw replacement after awaiting authority",
		async kind => {
			for (const replacement of ["registration", "raw"] as const) {
				const entered = deferred<void>(),
					release = deferred<void>();
				const effect = async () => {
					entered.resolve();
					await release.promise;
				};
				const f = fixture({
					catalogFence: async () => true,
					catalogFenceSync: () => true,
					reconcile: effect,
					request: async () => {
						await effect();
						return { ok: true };
					},
				});
				await f.runtime.start();
				f.runtime.registerTenant(tenant);
				const result = (
					kind === "proof"
						? f.runtime.proveCatalogSession(catalogReference(), tenant)
						: f.runtime.queryCatalog(catalogReference(), tenant, "session.state", { timeoutMs: 500 })
				).catch(error => error);
				await entered.promise;
				if (replacement === "registration") {
					f.runtime.unregisterTenant(tenant);
					f.runtime.registerTenant(tenant);
				} else {
					if (kind === "proof") Reflect.set(f.foreignAttachment, "generation", 8);
					f.replaceAttachment();
				}
				release.resolve();
				expect(await result).toBeInstanceOf(Error);
				await f.runtime.dispose();
			}
		},
	);

	test.each(["proof", "query"] as const)(
		"catalog %s pending authorization honors the original timeout without raw effects",
		async kind => {
			const entered = deferred<void>(),
				release = deferred<boolean>();
			const f = fixture({
				catalogFence: async () => {
					entered.resolve();
					return release.promise;
				},
				catalogFenceSync: () => true,
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const result = (
				kind === "proof"
					? f.runtime.proveCatalogSession(catalogReference(), tenant, 15)
					: f.runtime.queryCatalog(catalogReference(), tenant, "session.state", { timeoutMs: 15 })
			).catch(error => error);
			await entered.promise;
			expect(await result).toMatchObject({ code: "timeout" });
			release.resolve(true);
			await f.runtime.dispose();
			expect(f.calls).toEqual(["start", "stop"]);
		},
	);

	test("catalog proof queues behind the retained raw reconcile without restarting its deadline", async () => {
		const entered = deferred<void>(),
			release = deferred<void>();
		let reconciles = 0;
		const f = fixture({
			catalogFence: async () => true,
			catalogFenceSync: () => true,
			reconcile: async () => {
				if (++reconciles === 1) {
					entered.resolve();
					await release.promise;
				}
			},
		});
		await f.runtime.start();
		const prior = f.runtime.reconcile(15).catch(error => error);
		await entered.promise;
		expect(await prior).toMatchObject({ code: "timeout" });
		await expect(f.runtime.proveCatalogSession(catalogReference(), tenant, 15)).rejects.toMatchObject({
			code: "timeout",
		});
		expect(reconciles).toBe(1);
		const admitted = f.runtime.proveCatalogSession(catalogReference(), tenant, 500);
		release.resolve();
		await admitted;
		expect(reconciles).toBe(2);
		await f.runtime.dispose();
	});

	test.each(["proof", "query"] as const)(
		"catalog %s retains timed-out raw work in producer scope and disposal",
		async kind => {
			const entered = deferred<void>(),
				release = deferred<void>();
			const effect = async () => {
				entered.resolve();
				await release.promise;
			};
			const f = fixture({
				drainTimeoutMs: 50,
				catalogFence: async () => true,
				catalogFenceSync: () => true,
				reconcile: effect,
				request: async () => {
					await effect();
					return { ok: true };
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const scope = f.runtime.createProducerScope();
			let scoped = false,
				disposed = false;
			const result = scope
				.run(async () =>
					kind === "proof"
						? await f.runtime.proveCatalogSession(catalogReference(), tenant, 15)
						: await f.runtime.queryCatalog(catalogReference(), tenant, "session.state", { timeoutMs: 15 }),
				)
				.catch(error => error);
			await entered.promise;
			expect(await result).toMatchObject({ code: "timeout" });
			void scope.seal().then(() => {
				scoped = true;
			});
			const timers: (() => void)[] = [];
			const nativeSetTimeout = globalThis.setTimeout;
			const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
				timers.push(callback);
				const handle = nativeSetTimeout(() => {}, 0);
				clearTimeout(handle);
				return handle;
			}) as typeof setTimeout);
			const clock = spyOn(performance, "now").mockReturnValue(performance.now());
			try {
				const disposal = f.runtime.dispose().then(() => {
					disposed = true;
				});
				timers[0]!();
				for (let i = 0; i < 30 && !f.calls.includes("stop"); i++) await Promise.resolve();
				expect(f.calls).toContain("stop");
				timers[1]!();
				await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
				expect(scoped).toBe(false);
				expect(disposed).toBe(false);
				release.resolve();
				await disposal;
				await scope.settled;
				expect(scoped).toBe(true);
				expect(disposed).toBe(true);
				expect(f.calls.filter(call => call === (kind === "proof" ? "reconcile" : "request"))).toHaveLength(1);
				expect(await result).toMatchObject({ code: "timeout" });
			} finally {
				release.resolve();
				timer.mockRestore();
				clock.mockRestore();
			}
		},
	);

	test("runtime disposal retains finite local scope producers but not idle scope lifetime", async () => {
		const f = fixture({ drainTimeoutMs: 50 });
		await f.runtime.start();
		const idle = f.runtime.createProducerScope(),
			active = f.runtime.createProducerScope();
		const gate = deferred<void>();
		const local = active.run(() => gate.promise);
		const timers: (() => void)[] = [];
		const nativeSetTimeout = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
			timers.push(callback);
			const handle = nativeSetTimeout(() => {}, 0);
			clearTimeout(handle);
			return handle;
		}) as typeof setTimeout);
		const clock = spyOn(performance, "now").mockReturnValue(performance.now());
		let disposed = false;
		try {
			const disposal = f.runtime.dispose().then(() => {
				disposed = true;
			});
			timers[0]!();
			for (let i = 0; i < 30 && !f.calls.includes("stop"); i++) await Promise.resolve();
			expect(f.calls).toContain("stop");
			timers[1]!();
			await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
			expect(disposed).toBe(false);
			gate.resolve();
			await local;
			await disposal;
			expect(disposed).toBe(true);
			expect(() => idle.run(async () => undefined)).toThrow("scope admission is closed");
			await active.seal();
			await idle.seal();
		} finally {
			gate.resolve();
			timer.mockRestore();
			clock.mockRestore();
		}
	});

	test("actual catalog route retains workspace lease through timed-out raw SDK response", async () => {
		const entered = deferred<void>(),
			response = deferred<Record<string, unknown>>(),
			released = deferred<void>();
		let releases = 0;
		const f = fixture({
			request: async () => {
				entered.resolve();
				return response.promise;
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const safeKey = "e".repeat(64);
		const lease = {
			renew: async () => lease,
			assertFence: async () => {},
			release: async () => {
				releases += 1;
				released.resolve();
			},
		};
		const manager = { acquire: async () => lease };
		const routes = {
			owner: { ownerUserId: "admin", singleOwnerLocalMode: false },
			workspaceRegistry: {
				open: async () => ({
					userId: tenant.principalId,
					safeKey,
					root: tenant.canonicalWorkspace,
					sessionRoot: `${tenant.canonicalWorkspace}/.gjc/sessions`,
				}),
			},
			workspaceLeaseManager: manager,
			modelReaderFactory: (context: ModelReaderContext) =>
				createManagedModelReaderFactory({
					runtime: f.runtime,
					timeoutMs: 100,
					registerSettlement: context.registerSettlement!,
					resolveAttachment: async () => ({ tenant }),
				})(context),
		} as unknown as AdapterRouteDependencies;
		try {
			const request = handleOpenAIModelsRequest(routes, { userId: tenant.principalId, role: "user" });
			await entered.promise;
			expect((await request).status).toBe(503);
			expect(releases).toBe(0);
			let admitted = false;
			await acquireWorkspaceAdmission(manager, safeKey, 30, 8).then(
				release => {
					admitted = true;
					release();
				},
				() => undefined,
			);
			expect(admitted).toBe(false);
			response.resolve({ type: "query_response", ok: true, page: { items: [], complete: true } });
			await released.promise;
			const release = await acquireWorkspaceAdmission(manager, safeKey, 1000, 8);
			release();
			expect(releases).toBe(1);
			expect(f.calls.filter(call => call === "request")).toHaveLength(1);
			expect(f.calls).not.toContain("stop");
		} finally {
			response.resolve({ ok: true });
			await f.runtime.dispose();
		}
	});

	test("producer scope waits for its timed-out raw request without stopping unrelated work", async () => {
		const entered = deferred<void>(),
			response = deferred<Record<string, unknown>>();
		let requests = 0;
		const f = fixture({
			request: () => {
				requests += 1;
				if (requests === 1) {
					entered.resolve();
					return response.promise;
				}
				return Promise.resolve({ ok: true });
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const attachment = await f.runtime.acquireAttachment(tenant);
		const scope = f.runtime.createProducerScope(),
			other = f.runtime.createProducerScope();
		let settled = false;
		void scope.settled.then(() => {
			settled = true;
		});
		const first = scope.run(() => f.runtime.request(attachment, { type: "query_request" }, { timeoutMs: 30 }));
		await entered.promise;
		await expect(first).rejects.toMatchObject({ code: "timeout" });
		expect(scope.seal()).toBe(scope.settled);
		expect(scope.seal()).toBe(scope.settled);
		expect(settled).toBe(false);
		await other.run(() => f.runtime.request(attachment, { type: "query_request" }, { timeoutMs: 100 }));
		await other.seal();
		expect(settled).toBe(false);
		expect(f.calls).not.toContain("stop");
		response.resolve({ ok: true });
		await scope.settled;
		expect(settled).toBe(true);
		expect(() => scope.run(async () => undefined)).toThrow("sealed");
		await f.runtime.dispose();
	});

	test.each([false, true])(
		"scope retains original late acknowledgement and local persistence failure=%s",
		async failed => {
			const entered = deferred<void>(),
				response = deferred<void>();
			const f = fixture({
				onMutation: async () => {
					entered.resolve();
					await response.promise;
				},
			});
			await f.runtime.start();
			const scope = f.runtime.createProducerScope();
			let captured = 0;
			const call = scope.run(() =>
				f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest(), 30, () => {
					captured += 1;
					if (failed) throw undefined;
				}),
			);
			await entered.promise;
			await expect(call).rejects.toMatchObject({ code: "timeout" });
			scope.seal();
			const other = f.runtime.createProducerScope();
			await other.run(async () => undefined);
			await other.seal();
			response.resolve();
			if (failed) {
				await expect(scope.settled).rejects.toThrow("Original lifecycle outcome persistence failed");
				await expect(f.runtime.dispose()).rejects.toThrow("Original lifecycle outcome persistence failed");
			} else {
				await scope.settled;
				await f.runtime.dispose();
			}
			expect(captured).toBe(1);
		},
	);

	test("sealing rejects nested effects but retains admitted local continuations", async () => {
		const f = fixture();
		await f.runtime.start();
		const scope = f.runtime.createProducerScope(),
			other = f.runtime.createProducerScope();
		const entered = deferred<void>(),
			release = deferred<void>();
		const work = scope.run(async () => {
			expect(() => other.run(async () => undefined)).toThrow("ownership");
			entered.resolve();
			await release.promise;
			await f.runtime.reconcile();
		});
		await entered.promise;
		let settled = false;
		void scope.seal().then(() => {
			settled = true;
		});
		expect(settled).toBe(false);
		release.resolve();
		await expect(work).rejects.toThrow("sealed");
		await scope.settled;
		expect(f.calls).toEqual(["start"]);
		await other.seal();
		await f.runtime.dispose();
	});

	test("waits for raw start before initiating one stop within the original budget", async () => {
		const startGate = deferred<void>();
		const f = fixture({ drainTimeoutMs: 1000, start: () => startGate.promise });
		const started = f.runtime.start();
		const disposal = f.runtime.dispose();
		expect(f.calls).toEqual(["start"]);
		expect(f.runtime.bootstrapAdmissionOpen).toBe(false);
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toMatchObject({ code: "runtime_interrupted" });
		startGate.resolve();
		await started;
		await disposal;
		expect(f.calls).toEqual(["start", "stop"]);
		expect(f.runtime.state).toBe("stopped");
	});

	test("late raw lifecycle rejection settles cleanup without manufacturing success or another effect", async () => {
		const entered = deferred<void>();
		const gate = deferred<void>();
		const stopEntered = deferred<void>();
		const f = fixture({
			drainTimeoutMs: 50,
			stop: async () => {
				stopEntered.resolve();
			},
			onMutation: async () => {
				entered.resolve();
				await gate.promise;
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const outcome = f.runtime
			.closeLifecycleSession(tenant, { ...closeRequest(), timeoutMs: 25 })
			.catch(error => error);
		await entered.promise;
		expect(await outcome).toMatchObject({ code: "timeout" });
		const timers: (() => void)[] = [];
		const nativeSetTimeout = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
			timers.push(callback);
			const handle = nativeSetTimeout(() => {}, 0);
			clearTimeout(handle);
			return handle;
		}) as typeof setTimeout);
		const now = performance.now();
		const clock = spyOn(performance, "now").mockReturnValue(now);
		try {
			const disposal = f.runtime.dispose();
			expect(timers).toHaveLength(2);
			timers[0]!();
			await stopEntered.promise;
			timers[1]!();
			await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
			expect(f.calls).toContain("stop");
			expect(f.runtime.state).toBe("stopping");
			gate.reject(new Error("late public failure"));
			await disposal;
			expect(f.runtime.state).toBe("stopped");
			expect(await outcome).toMatchObject({ code: "timeout" });
			expect(f.closeCalls).toHaveLength(1);
		} finally {
			timer.mockRestore();
			clock.mockRestore();
		}
	});

	test.each(["reconcile", "proof"] as const)("serializes %s behind a timed-out raw reconciliation", async kind => {
		const entered = deferred<void>();
		const gate = deferred<void>();
		let calls = 0;
		const f = fixture({
			reconcile: async () => {
				if (++calls === 1) {
					entered.resolve();
					await gate.promise;
				}
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const first = f.runtime.reconcile(25).catch(error => error);
		await entered.promise;
		expect(await first).toMatchObject({ code: "timeout" });
		const next = (timeoutMs: number) =>
			kind === "reconcile"
				? f.runtime.reconcile(timeoutMs)
				: f.runtime.proveLifecycleTenant(tenant, operationIdentity(), timeoutMs);
		try {
			await expect(next(25)).rejects.toMatchObject({ code: "timeout" });
			expect(calls).toBe(1);
			const admitted = next(5000);
			gate.resolve();
			await admitted;
			expect(calls).toBe(2);
		} finally {
			gate.resolve();
			await f.runtime.dispose();
		}
	});

	test.each(["success", "failure"] as const)(
		"observes late raw Router stop %s independently of its timeout",
		async outcome => {
			const gate = deferred<void>();
			const f = fixture({ drainTimeoutMs: 50, stop: () => gate.promise });
			await f.runtime.start();
			const disposal = f.runtime.dispose();
			const observed = disposal.catch(error => error);
			let settled = false;
			void observed.then(() => {
				settled = true;
			});
			await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
			expect(f.runtime.state).toBe("stopping");
			expect(settled).toBe(false);
			const failure = new Error("actual Router stop failed");
			if (outcome === "success") gate.resolve();
			else gate.reject(failure);
			expect(await observed).toBe(outcome === "success" ? undefined : failure);
			expect(f.runtime.state).toBe(outcome === "success" ? "stopped" : "failed");
			expect(f.runtime.dispose()).toBe(disposal);
			await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
			expect(f.closeCalls).toEqual([]);
		},
	);

	test("disposal retains an unsubscribed listener already executing", async () => {
		const entered = deferred<void>();
		const gate = deferred<void>();
		const f = fixture({ drainTimeoutMs: 100 });
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		let delivered = 0;
		const subscription = f.runtime.subscribeFrames(token, "turn", { commandId: "queued-command" }, async () => {
			delivered += 1;
			entered.resolve();
			await gate.promise;
		});
		await f.emit(observedFrame(1));
		await entered.promise;
		subscription();
		const disposal = f.runtime.dispose();
		let settled = false;
		void disposal.then(() => {
			settled = true;
		});
		try {
			await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
			await f.emit(observedFrame(2));
			expect(settled).toBe(false);
			expect(delivered).toBe(1);
			gate.resolve();
			await disposal;
			expect(f.runtime.state).toBe("stopped");
		} finally {
			gate.resolve();
			await disposal;
		}
	});

	test.each(["request", "lifecycle", "authorization", "prepared", "list", "reconcile"] as const)(
		"disposal retains a timed-out raw %s producer until actual settlement",
		async kind => {
			const entered = deferred<void>();
			const gate = deferred<void>();
			let blocked = false;
			const wait = async () => {
				entered.resolve();
				await gate.promise;
			};
			const f = fixture({
				drainTimeoutMs: 100,
				fence: async () => {
					if (blocked && kind === "authorization") await wait();
					return true;
				},
				preparedFence: async () => {
					await wait();
					return true;
				},
				request: async () => {
					await wait();
					return { ok: true };
				},
				onMutation: wait,
				list: async () => {
					await wait();
					return { ok: true, operation: "session.list", result: { indexSeq: 1, sessions: [], warnings: [] } };
				},
				reconcile: wait,
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const token = await f.runtime.acquireAttachment(tenant);
			blocked = true;
			const pending = (
				kind === "request"
					? f.runtime.request(token, {}, { timeoutMs: 25 })
					: kind === "prepared"
						? invokeExternal(f.runtime, "prepared", {}, 25)
						: kind === "list"
							? f.runtime.listLifecycleSessions(tenant, { ...listRequest(), timeoutMs: 25 })
							: kind === "reconcile"
								? f.runtime.reconcile(25)
								: f.runtime.closeLifecycleSession(tenant, { ...closeRequest(), timeoutMs: 25 })
			).catch(error => error);
			await entered.promise;
			expect(await pending).toMatchObject({ code: "timeout" });
			const disposal = f.runtime.dispose();
			let settled = false;
			void disposal.then(() => {
				settled = true;
			});
			try {
				await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
				expect(settled).toBe(false);
				expect(f.runtime.state).toBe("stopping");
				expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
				gate.resolve();
				await disposal;
				expect(f.runtime.state).toBe("stopped");
				expect(f.runtime.dispose()).toBe(disposal);
				if (kind === "authorization") expect(f.closeCalls).toEqual([]);
				if (kind === "prepared") expect(f.createCalls).toEqual([]);
				await expect(f.runtime.acquireAttachment(tenant)).rejects.toMatchObject({ code: "runtime_interrupted" });
			} finally {
				gate.resolve();
				await disposal;
			}
		},
	);

	test.each(["acquire", "register", "adopt", "status", "retirement-status"] as const)(
		"expired %s admission cannot perform late compound proof effects",
		async mode => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const f = fixture({
				fence: () => {
					entered.resolve();
					return release.promise;
				},
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const promise =
				mode === "acquire"
					? f.runtime.acquireAttachment(tenant, 25)
					: mode === "register"
						? f.runtime.registerLifecycleTenant(tenant, 25)
						: mode === "adopt"
							? f.runtime.proveLifecycleTenant(tenant, operationIdentity(), 25)
							: mode === "status"
								? f.runtime.generationStatus(tenant, 25)
								: f.runtime.retirementGenerationStatus(tenant, operationIdentity(), 25);
			const result = promise.catch(error => error);
			await entered.promise;
			expect(await result).toMatchObject({ code: "timeout" });
			const effects = [...f.calls];
			release.resolve(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(f.calls).toEqual(effects);
			expect(f.statusCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test("expired serialized reconciliation never invokes its queued public effect", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const f = fixture({
			reconcile: () => {
				entered.resolve();
				return release.promise;
			},
		});
		await f.runtime.start();
		const first = f.runtime.reconcile(1_000);
		await entered.promise;
		await expect(f.runtime.reconcile(25)).rejects.toMatchObject({ code: "timeout" });
		release.resolve();
		await first;
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.calls.filter(call => call === "reconcile")).toHaveLength(1);
		await f.runtime.stop();
	});

	test.each([
		"prepared",
		"external-create",
		"external-resume",
		"create",
		"resume",
		"fork",
		"close",
		"retirement",
	] as const)("%s mutation acknowledgement is not hidden by a revoked or hanging post-effect fence", async method => {
		for (const hang of [false, true]) {
			let applied = false;
			let afterEffectChecks = 0;
			let hangFence = hang;
			const withheld = deferred<boolean>();
			const fence = () => {
				if (!applied) return true;
				afterEffectChecks += 1;
				return hangFence ? withheld.promise : false;
			};
			const f = fixture({
				fence,
				preparedFence: fence,
				onMutation: () => {
					applied = true;
				},
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			try {
				const common = { actor: closeRequest().actor, requestKey: "mutation-1", timeoutMs: 250 };
				let pending: Promise<unknown>;
				switch (method) {
					case "prepared":
						pending = invokeExternal(f.runtime, "prepared", {}, 250);
						break;
					case "external-create":
						pending = invokeExternal(f.runtime, "create", {}, 250);
						break;
					case "external-resume":
						pending = invokeExternal(f.runtime, "resume", {}, 250);
						break;
					case "create":
						pending = f.runtime.createLifecycleSession(tenant, {
							...common,
							capability: "session.create",
							target: { cwd: tenant.canonicalWorkspace },
						});
						break;
					case "resume":
						pending = f.runtime.resumeLifecycleSession(tenant, {
							...common,
							capability: "session.resume",
							target: { sessionId: tenant.sessionId, cwd: tenant.canonicalWorkspace },
						});
						break;
					case "fork":
						pending = f.runtime.forkLifecycleSession(tenant, {
							...common,
							capability: "session.fork",
							target: { sourceSessionId: tenant.sessionId, cwd: tenant.canonicalWorkspace },
						});
						break;
					case "close":
						pending = f.runtime.closeLifecycleSession(tenant, closeRequest());
						break;
					case "retirement":
						pending = f.runtime.retireLifecycleSession(
							tenant,
							closeRequest(),
							operationIdentity(),
							() => undefined,
						);
						break;
				}
				const receipt = await pending;
				expect(applied).toBe(true);
				expect(afterEffectChecks).toBe(0);
				expect(receipt).toEqual(
					method === "external-resume"
						? {
								kind: "result",
								outcome: {
									ok: true,
									operation: "session.resume",
									result: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
								},
							}
						: {
								ok: true,
								operation: `session.${method === "prepared" || method === "external-create" ? "create" : method === "retirement" ? "close" : method}`,
								result:
									method === "close" || method === "retirement"
										? { sessionId: tenant.sessionId }
										: {
												sessionId:
													method === "fork"
														? "forked"
														: method === "resume"
															? tenant.sessionId
															: "created",
												endpointGeneration: 1,
											},
							},
				);
				hangFence = false;
				await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
				await expect(f.runtime.proveLifecycleTenant(tenant, operationIdentity())).rejects.toThrow("fence was lost");
				expect(f.calls).not.toContain("request");
			} finally {
				withheld.resolve(false);
				await f.runtime.stop();
			}
		}
	});

	test("list disclosure remains fenced after the public read completes", async () => {
		let allowed = true;
		const f = fixture({
			fence: () => allowed,
			list: async () => {
				allowed = false;
				return {
					ok: true,
					operation: "session.list",
					result: {
						indexSeq: 1,
						sessions: [
							{
								sessionId: tenant.sessionId,
								cwd: tenant.canonicalWorkspace,
								endpointGeneration: tenant.generation,
							},
						],
						warnings: [],
					},
				};
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		try {
			await expect(f.runtime.listLifecycleSessions(tenant, listRequest())).rejects.toThrow("fence was lost");
			expect(f.listCalls).toHaveLength(1);
		} finally {
			await f.runtime.stop();
		}
	});

	test.each(["prepared", "create", "resume"] as const)(
		"%s external lifecycle separates small logical budgets from unchanged readiness configuration",
		async method => {
			const f = fixture();
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			for (const timeout of [15, 500]) {
				for (const readiness of [{}, { readinessTimeoutMs: 4_000 }, { readinessTimeoutMs: 60_000 }]) {
					await invokeExternal(f.runtime, method, readiness, timeout);
					const request = [...f.createCalls, ...f.resumeCalls].at(-1)!;
					expect(request).not.toHaveProperty("timeoutMs");
					if ("readinessTimeoutMs" in readiness)
						expect(request.readinessTimeoutMs).toBe(readiness.readinessTimeoutMs);
					else expect(request).not.toHaveProperty("readinessTimeoutMs");
				}
			}
			expect(f.createCalls.length + f.resumeCalls.length).toBe(6);
			await f.runtime.stop();
		},
	);

	test.each(["prepared", "create", "resume"] as const)(
		"%s external lifecycle rejects invalid readiness and undeclared public timeout without invocation",
		async method => {
			const f = fixture();
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			for (const invalid of [3_999, 60_001, 4_000.5, 500, 15, 0, -1, Infinity, NaN, null, "4000"]) {
				const readiness = {};
				Reflect.set(readiness, "readinessTimeoutMs", invalid);
				await expect(invokeExternal(f.runtime, method, readiness, 500)).rejects.toThrow("readinessTimeoutMs");
			}
			for (const timeoutMs of [15, undefined]) {
				const readiness = { timeoutMs };
				await expect(
					invokeExternal(f.runtime, method, { ...readiness, readinessTimeoutMs: 4_000 }, 500),
				).rejects.toThrow("internal operation budget");
			}
			expect(f.createCalls).toEqual([]);
			expect(f.resumeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test.each(["prepared", "create", "resume"] as const)(
		"%s external lifecycle uses the unchanged 30s default budget, not configured readiness",
		async method => {
			for (const elapsed of [4_500, 30_001]) {
				const entered = deferred<void>();
				const release = deferred<boolean>();
				const wait = () => {
					entered.resolve();
					return release.promise;
				};
				const f = fixture({ fence: wait, preparedFence: wait });
				f.runtime.registerTenant(tenant);
				await f.runtime.start();
				let now = performance.now();
				const clock = spyOn(performance, "now").mockImplementation(() => now);
				try {
					const call = invokeExternal(f.runtime, method, { readinessTimeoutMs: 4_000 });
					const result = call.catch(error => error);
					await entered.promise;
					now += elapsed;
					release.resolve(true);
					const outcome = await result;
					if (elapsed === 30_001) {
						expect(outcome).toMatchObject({ code: "timeout" });
						expect(f.createCalls.length + f.resumeCalls.length).toBe(0);
					} else {
						expect(outcome).not.toBeInstanceOf(Error);
						expect([...f.createCalls, ...f.resumeCalls][0]?.readinessTimeoutMs).toBe(4_000);
					}
				} finally {
					clock.mockRestore();
					await f.runtime.stop();
				}
			}
		},
	);

	test.each(["prepared", "create", "resume"] as const)(
		"%s external logical deadline rejects late authorization without public effects",
		async method => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const wait = () => {
				entered.resolve();
				return release.promise;
			};
			const f = fixture({ fence: wait, preparedFence: wait });
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const result = invokeExternal(f.runtime, method, { readinessTimeoutMs: 60_000 }, 15).catch(error => error);
			await entered.promise;
			expect(await result).toMatchObject({ code: "timeout" });
			release.resolve(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(f.createCalls).toEqual([]);
			expect(f.resumeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test.each(["prepared", "create", "resume"] as const)(
		"%s external readiness is snapshotted rather than decremented after awaited admission",
		async method => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const wait = () => {
				entered.resolve();
				return release.promise;
			};
			const f = fixture({ fence: wait, preparedFence: wait });
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const readiness = { readinessTimeoutMs: 4_000 };
			let now = performance.now();
			const clock = spyOn(performance, "now").mockImplementation(() => now);
			try {
				const call = invokeExternal(f.runtime, method, readiness, 500);
				await entered.promise;
				readiness.readinessTimeoutMs = 60_001;
				now += 200;
				release.resolve(true);
				await call;
				const request = [...f.createCalls, ...f.resumeCalls][0]!;
				expect(request.readinessTimeoutMs).toBe(4_000);
				expect(request).not.toHaveProperty("timeoutMs");
			} finally {
				clock.mockRestore();
				await f.runtime.stop();
			}
		},
	);

	test.each(["prepared", "create", "resume"] as const)(
		"%s external logical budget validation is independent of valid readiness",
		async method => {
			const f = fixture();
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			for (const timeout of [0, -1, 1.5, Infinity, NaN, 2_147_483_648])
				await expect(invokeExternal(f.runtime, method, { readinessTimeoutMs: 4_000 }, timeout)).rejects.toThrow(
					"Managed timeout",
				);
			expect(f.createCalls).toEqual([]);
			expect(f.resumeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test.each(["create", "resume"] as const)(
		"%s wrapped external request preserves readiness and accepts a separate third budget",
		async method => {
			const f = fixture();
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			if (method === "create")
				await f.runtime.createExternalLifecycleSession({ tenant, request: createRequest() }, undefined, 500);
			else
				await f.runtime.resumeExternalLifecycleSession(
					{
						tenant,
						request: {
							actor: closeRequest().actor,
							capability: "session.resume",
							requestKey: "resume-1",
							target: { sessionIdOrPrefix: tenant.sessionId, path: tenant.canonicalWorkspace },
							readinessTimeoutMs: 60_000,
						},
					},
					undefined,
					500,
				);
			const request = [...f.createCalls, ...f.resumeCalls][0]!;
			expect(request.readinessTimeoutMs).toBe(method === "create" ? 4_000 : 60_000);
			expect(request).not.toHaveProperty("timeoutMs");
			await f.runtime.stop();
		},
	);

	test.each(["create", "resume", "fork"] as const)(
		"nonexternal %s validates configured target readiness while shrinking public timeout",
		async method => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const f = fixture({
				fence: () => {
					entered.resolve();
					return release.promise;
				},
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const invoke = (readinessTimeoutMs: number) => {
				const common = { actor: closeRequest().actor, requestKey: "lifecycle-1", timeoutMs: 500 };
				if (method === "create")
					return f.runtime.createLifecycleSession(tenant, {
						...common,
						capability: "session.create",
						target: { cwd: tenant.canonicalWorkspace, readinessTimeoutMs },
					});
				if (method === "fork")
					return f.runtime.forkLifecycleSession(tenant, {
						...common,
						capability: "session.fork",
						target: { cwd: tenant.canonicalWorkspace, sourceSessionId: tenant.sessionId, readinessTimeoutMs },
					});
				return f.runtime.resumeLifecycleSession(tenant, {
					...common,
					capability: "session.resume",
					target: { cwd: tenant.canonicalWorkspace, sessionId: tenant.sessionId, readinessTimeoutMs },
				});
			};
			let now = 1_000;
			const clock = spyOn(performance, "now").mockImplementation(() => now);
			try {
				const call = invoke(4_000);
				await entered.promise;
				now += 200;
				release.resolve(true);
				await call;
				const requests = [...f.internalCreateCalls, ...f.historicalResumeCalls, ...f.forkCalls];
				expect(requests).toHaveLength(1);
				expect(requests[0]?.timeoutMs).toBe(300);
				expect(requests[0]?.target.readinessTimeoutMs).toBe(4_000);
				for (const invalid of [3_999, 60_001, 4_000.5])
					await expect(invoke(invalid)).rejects.toThrow("readinessTimeoutMs");
				expect(f.internalCreateCalls.length + f.historicalResumeCalls.length + f.forkCalls.length).toBe(1);
			} finally {
				clock.mockRestore();
				await f.runtime.stop();
			}
		},
	);

	test.each(["list", "resume", "disclosure"] as const)(
		"historical %s denies runtime stop inside its synchronous fence",
		async phase => {
			let checks = 0;
			let stopping: Promise<void> | undefined;
			const fence = () => {
				checks += 1;
				if (phase !== "disclosure" || checks === 2) stopping = f.runtime.stop();
				return true;
			};
			const f = fixture({
				historicalSelectionFence: () => true,
				historicalResumeFence: () => true,
				historicalSelectionFenceSync: fence,
				historicalResumeFenceSync: fence,
				list: async () => historicalList(),
			});
			await f.runtime.start();
			try {
				await expect(
					phase === "resume"
						? f.runtime.resumeHistoricalSession(
								"migration:resume:attempt-1",
								historicalEvidence(),
								f.observeHistoricalOutcome,
							)
						: f.runtime.selectHistoricalSession(historicalSelection()),
				).rejects.toThrow();
				expect(f.listCalls).toHaveLength(phase === "disclosure" ? 1 : 0);
				expect(f.historicalResumeCalls).toEqual([]);
				expect(f.historicalOutcomes).toEqual([]);
			} finally {
				await stopping;
				await f.runtime.dispose();
			}
		},
	);

	test("historical disclosure checks deadline after its synchronous fence", async () => {
		let checks = 0;
		let now = performance.now();
		const f = fixture({
			historicalSelectionFence: () => true,
			historicalSelectionFenceSync: () => {
				checks += 1;
				if (checks === 2) now += 501;
				return true;
			},
			list: async () => historicalList(),
		});
		await f.runtime.start();
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			await expect(f.runtime.selectHistoricalSession(historicalSelection(), 500)).rejects.toMatchObject({
				code: "timeout",
			});
			expect(checks).toBe(2);
			expect(f.listCalls).toHaveLength(1);
		} finally {
			clock.mockRestore();
			await f.runtime.dispose();
		}
	});

	test.each(["list", "resume", "disclosure"] as const)(
		"historical %s rechecks synchronous authority after final async fence",
		async phase => {
			let live = true;
			let selections = 0;
			const f = fixture({
				historicalSelectionFence: async () => {
					selections += 1;
					const admitted = live;
					if ((phase === "list" && selections === 1) || (phase === "disclosure" && selections === 2))
						queueMicrotask(() => {
							live = false;
						});
					return admitted;
				},
				historicalSelectionFenceSync: () => live,
				historicalResumeFence: async () => {
					const admitted = live;
					queueMicrotask(() => {
						live = false;
					});
					return admitted;
				},
				historicalResumeFenceSync: () => live,
				list: async () => historicalList(),
			});
			await f.runtime.start();
			try {
				await expect(
					phase === "resume"
						? f.runtime.resumeHistoricalSession(
								"migration:resume:attempt-1",
								historicalEvidence(),
								f.observeHistoricalOutcome,
							)
						: f.runtime.selectHistoricalSession(historicalSelection()),
				).rejects.toThrow("synchronous authority");
				expect(f.listCalls).toHaveLength(phase === "disclosure" ? 1 : 0);
				expect(f.historicalResumeCalls).toHaveLength(0);
				expect(f.historicalOutcomes).toEqual([]);
			} finally {
				await f.runtime.dispose();
			}
		},
	);

	test.each(["list", "resume"] as const)(
		"historical %s denies missing synchronous fence before SDK effect",
		async phase => {
			const f = fixture({
				historicalSelectionFence: () => true,
				historicalResumeFence: () => true,
				omitHistoricalSync: true,
				list: async () => historicalList(),
			});
			await f.runtime.start();
			try {
				await expect(
					phase === "resume"
						? f.runtime.resumeHistoricalSession(
								"migration:resume:attempt-1",
								historicalEvidence(),
								f.observeHistoricalOutcome,
							)
						: f.runtime.selectHistoricalSession(historicalSelection()),
				).rejects.toThrow("synchronous authority");
				expect(f.listCalls).toEqual([]);
				expect(f.historicalResumeCalls).toEqual([]);
			} finally {
				await f.runtime.dispose();
			}
		},
	);

	test.each(["list", "resume", "disclosure"] as const)(
		"historical %s denies false or throwing synchronous fences",
		async phase => {
			for (const mode of ["false", "throw"] as const) {
				let checks = 0;
				const deny = () => {
					checks += 1;
					if (phase === "disclosure" && checks === 1) return true;
					if (mode === "throw") throw new Error("synchronous authority revoked");
					return false;
				};
				const f = fixture({
					historicalSelectionFence: () => true,
					historicalResumeFence: () => true,
					historicalSelectionFenceSync: deny,
					historicalResumeFenceSync: deny,
					list: async () => historicalList(),
				});
				await f.runtime.start();
				try {
					await expect(
						phase === "resume"
							? f.runtime.resumeHistoricalSession(
									"migration:resume:attempt-1",
									historicalEvidence(),
									f.observeHistoricalOutcome,
								)
							: f.runtime.selectHistoricalSession(historicalSelection()),
					).rejects.toThrow("synchronous authority");
					expect(checks).toBe(phase === "disclosure" ? 2 : 1);
					expect(f.listCalls).toHaveLength(phase === "disclosure" ? 1 : 0);
					expect(f.historicalResumeCalls).toEqual([]);
					expect(f.historicalOutcomes).toEqual([]);
				} finally {
					await f.runtime.dispose();
				}
			}
		},
	);

	test("historical fences retain original callbacks and dependency receivers", async () => {
		const receivers: ManagedSdkRuntimeDeps[] = [];
		const checks: string[] = [];
		const replacement = () => {
			throw new Error("replacement fence must not run");
		};
		const f = fixture({
			async historicalSelectionFence(this: ManagedSdkRuntimeDeps) {
				receivers.push(this);
				checks.push("selection");
				Reflect.set(this, "historicalSelectionFence", replacement);
				Reflect.set(this, "historicalSelectionFenceSync", replacement);
				await Promise.resolve();
				return true;
			},
			historicalSelectionFenceSync(this: ManagedSdkRuntimeDeps) {
				receivers.push(this);
				checks.push("selection-sync");
				return true;
			},
			async historicalResumeFence(this: ManagedSdkRuntimeDeps) {
				receivers.push(this);
				checks.push("resume");
				Reflect.set(this, "historicalResumeFence", replacement);
				Reflect.set(this, "historicalResumeFenceSync", replacement);
				await Promise.resolve();
				return true;
			},
			historicalResumeFenceSync(this: ManagedSdkRuntimeDeps) {
				receivers.push(this);
				checks.push("resume-sync");
				return true;
			},
			list: async () => historicalList(),
		});
		await f.runtime.start();
		try {
			expect(await f.runtime.selectHistoricalSession(historicalSelection())).toEqual(savedSession());
			await f.runtime.resumeHistoricalSession(
				"migration:resume:attempt-1",
				historicalEvidence(),
				f.observeHistoricalOutcome,
			);
			expect(checks).toEqual([
				"selection",
				"selection-sync",
				"selection",
				"selection-sync",
				"resume",
				"resume-sync",
			]);
			for (const receiver of receivers) {
				expect(receiver).toBe(receivers[0]);
				expect(receiver.createLifecycleService).toBeFunction();
			}
			expect(f.listCalls).toHaveLength(1);
			expect(f.historicalResumeCalls).toHaveLength(1);
			expect(f.historicalOutcomes).toHaveLength(1);
		} finally {
			await f.runtime.dispose();
		}
	});

	test("selects only the exact public saved receipt and resumes without creating routing authority", async () => {
		const selection = historicalSelection();
		const evidence = historicalEvidence();
		const listed = savedSession();
		let selectionFences = 0;
		let resumeFences = 0;
		let ordinaryFences = 0;
		const f = fixture({
			fence: () => {
				ordinaryFences += 1;
				return false;
			},
			preparedFence: () => {
				ordinaryFences += 1;
				return false;
			},
			historicalSelectionFence: value => {
				expect(value).toEqual(selection);
				expect(Object.isFrozen(value.historicalBinding.provenance)).toBe(true);
				selectionFences += 1;
				return true;
			},
			historicalResumeFence: (id, value) => {
				expect(id).toBe("migration:resume:attempt-1");
				expect(value).toEqual(evidence);
				expect(Object.isFrozen(value.target.sessionIdentity)).toBe(true);
				resumeFences += 1;
				return true;
			},
			list: async () => historicalList(listed),
		});
		await f.runtime.start();
		const receipt = await f.runtime.selectHistoricalSession(selection, 500);
		expect(receipt).toEqual(listed);
		expect(receipt).not.toBe(listed);
		expect(receipt.identity).not.toBe(listed.identity);
		expect(Object.keys(receipt).sort()).toEqual(["id", "identity", "path"]);
		expect(f.listCalls).toHaveLength(1);
		const { timeoutMs: listTimeout, ...listRequest } = f.listCalls[0]!;
		expect(listTimeout).toBeGreaterThan(0);
		expect(listTimeout!).toBeLessThanOrEqual(500);
		expect(listRequest).toEqual({
			actor: evidence.actor,
			capability: "session.list",
			target: { cwd: tenant.canonicalWorkspace, resolveSessionId: tenant.sessionId },
		});
		expect(selectionFences).toBe(2);
		const outcome = await f.runtime.resumeHistoricalSession(
			"migration:resume:attempt-1",
			evidence,
			f.observeHistoricalOutcome,
			500,
		);
		expect(outcome).toEqual({
			ok: true,
			operation: "session.resume",
			result: { sessionId: tenant.sessionId, endpointGeneration: 1 },
		});
		const { timeoutMs: resumeTimeout, ...resumeRequest } = f.historicalResumeCalls[0]!;
		expect(resumeTimeout).toBeGreaterThan(0);
		expect(resumeTimeout!).toBeLessThanOrEqual(500);
		expect({ ...resumeRequest, target: { ...resumeRequest.target } } as Record<string, unknown>).toEqual({
			actor: evidence.actor,
			capability: "session.resume",
			requestKey: evidence.requestKey,
			target: evidence.target,
		});
		expect(resumeRequest.target.sessionIdentity).not.toHaveProperty("nlink");
		expect(resumeRequest.target.sessionIdentity).not.toHaveProperty("ctimeNs");
		expect(resumeFences).toBe(1);
		expect(ordinaryFences).toBe(0);
		expect(selection.historicalBinding).not.toHaveProperty("generation");
		expect(evidence.preparedAuthority).not.toHaveProperty("generation");
		expect(f.calls).toEqual(["start"]);
		expect(f.resumeCalls).toEqual([]);
		expect(f.createCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("not registered");
		const forged = { tenant, generation: tenant.generation, isCurrent: () => true };
		await expect(f.runtime.request(forged, { type: "query_request", query: "session.state" })).rejects.toThrow(
			"not registered",
		);
		expect(() => f.runtime.subscribeFrames(forged, "turn", { commandId: "command" }, () => {})).toThrow(
			"Registered current tenant",
		);
		await f.emit(observedFrame(1));
		expect(f.runtime.frameDiagnostics().foreign).toBe(1);
		await f.runtime.stop();
	});

	test.each(["missing", "denied"] as const)(
		"historical operations deny %s dedicated fences even with active and prepared authorization",
		async mode => {
			const f = fixture({
				historicalSelectionFence: mode === "missing" ? undefined : () => false,
				historicalResumeFence: mode === "missing" ? undefined : () => false,
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			await expect(f.runtime.selectHistoricalSession(historicalSelection())).rejects.toThrow(
				"selection authority fence",
			);
			await expect(
				f.runtime.resumeHistoricalSession(
					"migration:resume:attempt-1",
					historicalEvidence(),
					f.observeHistoricalOutcome,
				),
			).rejects.toThrow("resume authority fence");
			expect(f.listCalls).toEqual([]);
			expect(f.historicalResumeCalls).toEqual([]);
			expect(f.calls).toEqual(["start"]);
			await f.runtime.stop();
		},
	);

	test("historical selection rejects malformed and cross-tenant sources before listing", async () => {
		let fenced = 0;
		const f = fixture({
			historicalSelectionFence: () => {
				fenced += 1;
				return true;
			},
		});
		await f.runtime.start();
		const mutations: Array<(value: ManagedSdkHistoricalSelection) => void> = [
			value => {
				Reflect.deleteProperty(value, "manifestDigest");
			},
			value => {
				Reflect.set(value, "manifestDigest", "x".repeat(64));
			},
			value => {
				Reflect.set(value, "manifestDigest", "a".repeat(63));
			},
			value => {
				Reflect.set(value, "raw", {});
			},
			value => {
				Reflect.deleteProperty(value, "historicalBinding");
			},
			value => {
				Reflect.set(value.historicalBinding, "sessionId", "");
			},
			value => {
				Reflect.deleteProperty(value.historicalBinding, "sessionId");
			},
			value => {
				Reflect.set(value.historicalBinding, "sessionId", "session-1\n");
			},
			value => {
				Reflect.set(value.historicalBinding, "generation", 1);
			},
			value => {
				Reflect.set(value.historicalBinding, "sessionFile", "/adapter/path");
			},
			value => {
				Reflect.set(value.historicalBinding, "projectId", "foreign");
			},
			value => {
				Reflect.set(value.historicalBinding, "chatId", "foreign");
			},
			value => {
				Reflect.set(value.historicalBinding, "principalId", "foreign");
			},
			value => {
				Reflect.set(value.historicalBinding, "canonicalWorkspace", "/foreign");
			},
			value => {
				Reflect.set(value.historicalBinding.provenance, "nodeRef", "/invalid/0");
			},
			value => {
				Reflect.set(value.historicalBinding.provenance, "documentHash", "not-a-hash");
			},
			value => {
				Reflect.deleteProperty(value.preparedAuthority, "leaseId");
			},
			value => {
				Reflect.set(value.preparedAuthority, "epoch", "");
			},
			value => {
				Reflect.set(value.preparedAuthority, "requestKey", " ");
			},
			value => {
				Reflect.set(value.preparedAuthority, "generation", 1);
			},
			value => {
				Reflect.set(value.preparedAuthority, "canonicalWorkspace", "relative");
			},
			value => {
				Reflect.set(value.preparedAuthority, "canonicalWorkspace", "/workspace/../project-1");
			},
		];
		for (const mutate of mutations) {
			const selection = historicalSelection();
			mutate(selection);
			await expect(f.runtime.selectHistoricalSession(selection)).rejects.toThrow();
		}
		expect(fenced).toBe(0);
		expect(f.listCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("historical owner rejects well-formed but different manifest, source and attempt authority", async () => {
		const expected = historicalSelection();
		const f = fixture({
			historicalSelectionFence: value => JSON.stringify(value) === JSON.stringify(expected),
			historicalResumeFence: (id, value) =>
				id === "migration:resume:attempt-1" &&
				value.requestKey === expected.preparedAuthority.requestKey &&
				value.historicalSource?.manifestDigest === expected.manifestDigest &&
				value.payloadHash === "e".repeat(64),
		});
		await f.runtime.start();
		for (const selection of [
			{ ...expected, manifestDigest: "f".repeat(64) },
			{ ...expected, historicalBinding: { ...expected.historicalBinding, sessionId: "different-full-id" } },
			{
				...expected,
				historicalBinding: {
					...expected.historicalBinding,
					provenance: { ...expected.historicalBinding.provenance, nodeRef: "/mappings/1" },
				},
			},
			{ ...expected, preparedAuthority: { ...expected.preparedAuthority, leaseId: "new-lease" } },
		])
			await expect(f.runtime.selectHistoricalSession(selection)).rejects.toThrow("selection authority fence");
		await expect(
			f.runtime.resumeHistoricalSession(
				"migration:resume:attempt-2",
				historicalEvidence(),
				f.observeHistoricalOutcome,
			),
		).rejects.toThrow("resume authority fence");
		for (const patch of [
			{ payloadHash: "f".repeat(64) },
			{ historicalSource: { ...historicalEvidence().historicalSource!, manifestDigest: "f".repeat(64) } },
		])
			await expect(
				f.runtime.resumeHistoricalSession(
					"migration:resume:attempt-1",
					{ ...historicalEvidence(), ...patch },
					f.observeHistoricalOutcome,
				),
			).rejects.toThrow("resume authority fence");
		expect(f.listCalls).toEqual([]);
		expect(f.historicalResumeCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("historical selection requires exact public receipt identity and canonical in-workspace path", async () => {
		let receipt: unknown;
		const f = fixture({
			historicalSelectionFence: () => true,
			list: async () => {
				const outcome = historicalList();
				if (!outcome.ok) throw new Error("Expected list fixture success.");
				Reflect.set(outcome.result, "savedSession", receipt);
				return outcome;
			},
		});
		await f.runtime.start();
		const malformed: unknown[] = [
			undefined,
			null,
			{},
			{ ...savedSession(), id: "session" },
			{ ...savedSession(), raw: "forbidden" },
		];
		for (const path of [
			"relative",
			"/foreign/session.jsonl",
			tenant.canonicalWorkspace,
			"/workspace/project-10/session",
			"/workspace/project-1/../foreign/session",
			"/workspace/project-1/./saved",
			"/workspace/project-1/saved\n",
		])
			malformed.push({ ...savedSession(), path });
		for (const field of ["dev", "ino", "size", "mtimeMs", "mtimeNs", "sha256", "nlink", "ctimeNs"]) {
			const saved = savedSession();
			Reflect.deleteProperty(saved.identity, field);
			malformed.push(saved);
		}
		for (const change of [
			{ dev: 1 },
			{ ino: "-1" },
			{ size: -1 },
			{ size: 1.5 },
			{ mtimeMs: Infinity },
			{ mtimeMs: -1 },
			{ mtimeNs: "1.2" },
			{ sha256: "bad" },
			{ nlink: "" },
			{ ctimeNs: "x" },
			{ raw: "secret" },
		])
			malformed.push({ ...savedSession(), identity: { ...savedSession().identity, ...change } });
		for (receipt of malformed)
			await expect(f.runtime.selectHistoricalSession(historicalSelection())).rejects.toMatchObject({
				code: "invalid_result",
			});
		expect(f.historicalResumeCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("historical listing failures and absent saved receipt cannot fall back to live sessions", async () => {
		for (const list of [
			async () => ({
				ok: false as const,
				operation: "session.list" as const,
				certainty: "retryable" as const,
				error: { code: "missing", message: "not selected" },
			}),
			async () => ({
				ok: true as const,
				operation: "session.list" as const,
				result: {
					indexSeq: 1,
					warnings: [],
					sessions: [{ sessionId: tenant.sessionId, endpointGeneration: 1, cwd: tenant.canonicalWorkspace }],
				},
			}),
		]) {
			const f = fixture({ list, historicalSelectionFence: () => true });
			await f.runtime.start();
			await expect(f.runtime.selectHistoricalSession(historicalSelection())).rejects.toThrow();
			expect(f.listCalls).toHaveLength(1);
			expect(f.historicalResumeCalls).toEqual([]);
			expect(f.calls).toEqual(["start"]);
			await f.runtime.stop();
		}
	});

	test.each(["selection", "resume"] as const)(
		"historical %s does not invoke after pending admission times out",
		async mode => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const fence = () => {
				entered.resolve();
				return release.promise;
			};
			const f = fixture({ historicalSelectionFence: fence, historicalResumeFence: fence });
			await f.runtime.start();
			const pending =
				mode === "selection"
					? f.runtime.selectHistoricalSession(historicalSelection(), 15)
					: f.runtime.resumeHistoricalSession(
							"migration:resume:attempt-1",
							historicalEvidence(),
							f.observeHistoricalOutcome,
							15,
						);
			const failure = pending.catch(error => error);
			await entered.promise;
			expect(await failure).toMatchObject({ code: "timeout" });
			release.resolve(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(f.listCalls).toEqual([]);
			expect(f.historicalResumeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test.each(["selection", "resume"] as const)(
		"historical %s rechecks running ownership after admission",
		async mode => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const fence = () => {
				entered.resolve();
				return release.promise;
			};
			const f = fixture({ historicalSelectionFence: fence, historicalResumeFence: fence });
			await f.runtime.start();
			const pending = (
				mode === "selection"
					? f.runtime.selectHistoricalSession(historicalSelection())
					: f.runtime.resumeHistoricalSession(
							"migration:resume:attempt-1",
							historicalEvidence(),
							f.observeHistoricalOutcome,
						)
			).catch(error => error);
			await entered.promise;
			const stopped = f.runtime.stop();
			release.resolve(true);
			expect(await pending).toMatchObject({ code: "runtime_interrupted" });
			await stopped;
			expect(f.listCalls).toEqual([]);
			expect(f.historicalResumeCalls).toEqual([]);
		},
	);

	test("historical selection snapshots caller authority and saved receipt around awaited fences", async () => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		const postEntered = deferred<void>();
		const postRelease = deferred<boolean>();
		let fences = 0;
		const seen: ManagedSdkHistoricalSelection[] = [];
		const listed = savedSession();
		const expected = savedSession();
		const f = fixture({
			historicalSelectionFence: value => {
				seen.push(value);
				if (++fences === 1) {
					entered.resolve();
					return release.promise;
				}
				postEntered.resolve();
				return postRelease.promise;
			},
			list: async () => historicalList(listed),
		});
		await f.runtime.start();
		const selection = historicalSelection();
		const selecting = f.runtime.selectHistoricalSession(selection);
		await entered.promise;
		Reflect.set(selection.preparedAuthority, "canonicalWorkspace", "/foreign");
		Reflect.set(selection.historicalBinding, "sessionId", "foreign");
		release.resolve(true);
		await postEntered.promise;
		Reflect.set(listed.identity, "sha256", "f".repeat(64));
		Reflect.set(listed, "path", "/foreign");
		postRelease.resolve(true);
		expect(await selecting).toEqual(expected);
		expect(seen[0]).toEqual(historicalSelection());
		expect(seen[1]).toBe(seen[0]);
		expect(f.listCalls[0]?.target).toEqual({ cwd: tenant.canonicalWorkspace, resolveSessionId: tenant.sessionId });
		await f.runtime.stop();
	});

	test("selection revocation after listing denies receipt publication", async () => {
		let granted = true;
		const f = fixture({
			historicalSelectionFence: () => granted,
			list: async () => {
				granted = false;
				return historicalList();
			},
		});
		await f.runtime.start();
		await expect(f.runtime.selectHistoricalSession(historicalSelection())).rejects.toThrow("fence was lost");
		expect(f.listCalls).toHaveLength(1);
		expect(f.historicalResumeCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("historical resume validates namespace, persisted phase, receipt and request before admission", async () => {
		let fences = 0;
		const f = fixture({
			historicalResumeFence: () => {
				fences += 1;
				return true;
			},
		});
		await f.runtime.start();
		for (const id of [
			"",
			"migration:resume:",
			"resume:attempt-1",
			" migration:resume:attempt-1",
			"migration:resume:attempt-1\n",
		])
			await expect(
				f.runtime.resumeHistoricalSession(id, historicalEvidence(), f.observeHistoricalOutcome),
			).rejects.toThrow();
		const mutations: Array<(value: ReturnType<typeof historicalEvidence>) => void> = [
			value => {
				Reflect.set(value, "state", "intent_prepared");
			},
			value => {
				Reflect.set(value, "state", "uncertain");
			},
			value => {
				Reflect.deleteProperty(value, "historicalSource");
			},
			value => {
				Reflect.set(value, "requestKey", "other");
			},
			value => {
				Reflect.set(value.actor, "id", "foreign");
			},
			value => {
				Reflect.set(value.target, "cwd", "/foreign");
			},
			value => {
				Reflect.set(value.target, "sessionId", "session");
			},
			value => {
				Reflect.set(value.target, "sessionPath", "/metadata/path");
			},
			value => {
				Reflect.set(value.target, "sessionIdentity", { ...savedSession().identity });
			},
			value => {
				Reflect.set(value.target, "stateRoot", "/private");
			},
			value => {
				Reflect.set(value.preparedAuthority, "generation", 1);
			},
			value => {
				Reflect.set(value.historicalSource!.savedSession.identity, "sha256", "f".repeat(64));
			},
			value => {
				Reflect.set(value, "source", { ...tenant, requestKey: "old" });
			},
			value => {
				Reflect.set(value, "acknowledged", {
					...value.preparedAuthority,
					sessionId: tenant.sessionId,
					generation: 1,
				});
			},
		];
		for (const mutate of mutations) {
			const value = historicalEvidence();
			mutate(value);
			await expect(
				f.runtime.resumeHistoricalSession("migration:resume:attempt-1", value, f.observeHistoricalOutcome),
			).rejects.toThrow();
		}
		expect(fences).toBe(0);
		expect(f.historicalResumeCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("historical resume snapshots input and returns raw acknowledgement without a post-effect fence", async () => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		const never = deferred<boolean>();
		const evidence = historicalEvidence();
		const expected = structuredClone(evidence);
		let fences = 0;
		const outcome: Awaited<ReturnType<LifecycleService["resume"]>> = {
			ok: true,
			operation: "session.resume",
			result: { sessionId: "foreign-result-for-caller-to-reject", endpointGeneration: 1 },
		};
		const f = fixture({
			historicalResumeFence: (_id, value) => {
				expect(value).toEqual(expected);
				if (++fences === 1) {
					entered.resolve();
					return release.promise;
				}
				return never.promise;
			},
			historicalResume: async () => outcome,
		});
		await f.runtime.start();
		const pending = f.runtime.resumeHistoricalSession(
			"migration:resume:attempt-1",
			evidence,
			f.observeHistoricalOutcome,
			500,
		);
		await entered.promise;
		Reflect.set(evidence.target, "sessionPath", "/foreign");
		Reflect.set(evidence.preparedAuthority, "leaseId", "foreign");
		Reflect.set(evidence.actor, "id", "foreign");
		release.resolve(true);
		expect(await pending).toBe(outcome);
		expect(fences).toBe(1);
		expect(f.historicalResumeCalls[0]).toMatchObject({
			actor: expected.actor,
			requestKey: expected.requestKey,
			target: expected.target,
		});
		expect(f.calls).toEqual(["start"]);
		await f.runtime.stop();
	});

	test("historical invocation failure is not retried and repeat admission is owner-controlled", async () => {
		const failure = new Error("transport failed after dispatch");
		let admitted = false;
		const f = fixture({
			historicalResumeFence: () => {
				if (admitted) return false;
				admitted = true;
				return true;
			},
			historicalResume: async () => {
				throw failure;
			},
		});
		await f.runtime.start();
		await expect(
			f.runtime.resumeHistoricalSession(
				"migration:resume:attempt-1",
				historicalEvidence(),
				f.observeHistoricalOutcome,
			),
		).rejects.toBe(failure);
		await expect(
			f.runtime.resumeHistoricalSession(
				"migration:resume:attempt-1",
				historicalEvidence(),
				f.observeHistoricalOutcome,
			),
		).rejects.toThrow("resume authority fence");
		expect(f.historicalResumeCalls).toHaveLength(1);
		expect(f.calls).toEqual(["start"]);
		await f.runtime.stop();
	});

	test.each(["selection", "resume"] as const)(
		"historical %s awaits lease admission and denies a late negative result",
		async mode => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const fence = () => {
				entered.resolve();
				return release.promise;
			};
			const f = fixture({ historicalSelectionFence: fence, historicalResumeFence: fence });
			await f.runtime.start();
			const pending = (
				mode === "selection"
					? f.runtime.selectHistoricalSession(historicalSelection())
					: f.runtime.resumeHistoricalSession(
							"migration:resume:attempt-1",
							historicalEvidence(),
							f.observeHistoricalOutcome,
						)
			).catch(error => error);
			await entered.promise;
			expect(f.listCalls).toEqual([]);
			expect(f.historicalResumeCalls).toEqual([]);
			release.resolve(false);
			expect(await pending).toBeInstanceOf(Error);
			expect(f.listCalls).toEqual([]);
			expect(f.historicalResumeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test("historical resume returns unsuccessful raw acknowledgement without fence reentry or retry", async () => {
		const outcome: Awaited<ReturnType<LifecycleService["resume"]>> = {
			ok: false,
			operation: "session.resume",
			certainty: "uncertain",
			error: { code: "lost", message: "possibly applied" },
		};
		let fences = 0;
		const f = fixture({
			historicalResumeFence: () => {
				fences += 1;
				return fences === 1;
			},
			historicalResume: async () => outcome,
		});
		await f.runtime.start();
		expect(
			await f.runtime.resumeHistoricalSession(
				"migration:resume:attempt-1",
				historicalEvidence(),
				f.observeHistoricalOutcome,
			),
		).toBe(outcome);
		expect(fences).toBe(1);
		expect(f.historicalResumeCalls).toHaveLength(1);
		expect(f.calls).toEqual(["start"]);
		await f.runtime.stop();
	});

	test("historical resume timeout keeps the single possibly-applied invocation without late proof effects", async () => {
		const entered = deferred<void>();
		const release = deferred<Awaited<ReturnType<LifecycleService["resume"]>>>();
		let fences = 0;
		const f = fixture({
			historicalResumeFence: () => {
				fences += 1;
				return true;
			},
			historicalResume: async () => {
				entered.resolve();
				return release.promise;
			},
		});
		await f.runtime.start();
		const failure = f.runtime
			.resumeHistoricalSession("migration:resume:attempt-1", historicalEvidence(), f.observeHistoricalOutcome, 15)
			.catch(error => error);
		await entered.promise;
		expect(await failure).toMatchObject({ code: "timeout" });
		release.resolve({
			ok: true,
			operation: "session.resume",
			result: { sessionId: tenant.sessionId, endpointGeneration: 1 },
		});
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fences).toBe(1);
		expect(f.historicalResumeCalls).toHaveLength(1);
		expect(f.calls).toEqual(["start"]);
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("not registered");
		expect(f.historicalOutcomes).toEqual([
			{ ok: true, operation: "session.resume", result: { sessionId: tenant.sessionId, endpointGeneration: 1 } },
		]);
		await f.runtime.stop();
	});

	test.each(["success", "failure"] as const)(
		"historical raw %s observer stays owned after timeout and shutdown",
		async mode => {
			const entered = deferred<void>();
			const observed = deferred<void>();
			const release = deferred<Awaited<ReturnType<LifecycleService["resume"]>>>();
			const persist = deferred<void>();
			const persistenceError = new Error("original receipt write failed");
			let fences = 0;
			let live = true;
			let syncFences = 0;
			const f = fixture({
				historicalResumeFence: () => {
					fences += 1;
					return fences === 1;
				},
				historicalResumeFenceSync: () => {
					syncFences += 1;
					return live;
				},
				historicalResume: () => {
					live = false;
					entered.resolve();
					return release.promise;
				},
			});
			await f.runtime.start();
			const scope = f.runtime.createProducerScope();
			const pending = scope
				.run(() =>
					f.runtime.resumeHistoricalSession(
						"migration:resume:attempt-1",
						historicalEvidence(),
						async value => {
							f.observeHistoricalOutcome(value);
							observed.resolve();
							await persist.promise;
						},
						15,
					),
				)
				.catch(error => error);
			await entered.promise;
			expect(await pending).toMatchObject({ code: "timeout" });
			const scopeSettled = scope.seal();
			const disposed = f.runtime.dispose();
			let completed = false;
			void disposed.then(
				() => {
					completed = true;
				},
				() => {
					completed = true;
				},
			);
			const outcome: Awaited<ReturnType<LifecycleService["resume"]>> = {
				ok: true,
				operation: "session.resume",
				result: { sessionId: tenant.sessionId, endpointGeneration: 7 },
			};
			release.resolve(outcome);
			await observed.promise;
			expect(completed).toBe(false);
			expect(f.historicalOutcomes).toEqual([outcome]);
			expect(f.historicalOutcomes[0]).not.toBe(outcome);
			expect(f.historicalOutcomes[0]!.ok && f.historicalOutcomes[0]!.result).not.toBe(outcome.result);
			expect(fences).toBe(1);
			expect(syncFences).toBe(1);
			if (mode === "success") {
				persist.resolve();
				await scopeSettled;
				await disposed;
			} else {
				persist.reject(persistenceError);
				await expect(scopeSettled).rejects.toThrow("persistence failed");
				await expect(disposed).rejects.toThrow("persistence failed");
			}
			expect(f.historicalResumeCalls).toHaveLength(1);
			expect(f.calls).not.toContain("reconcile");
			expect(f.closeCalls).toEqual([]);
		},
	);

	test.each([false, true])(
		"retirement raw observer remains owned after timeout with persistence failure=%s",
		async fail => {
			const entered = deferred<void>();
			const response = deferred<Awaited<ReturnType<LifecycleService["close"]>>>();
			const observed = deferred<void>();
			const persist = deferred<void>();
			const error = new Error("close acknowledgement persistence failed");
			const f = fixture({
				close: async () => {
					entered.resolve();
					return response.promise;
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const scope = f.runtime.createProducerScope();
			const original = {
				ok: true as const,
				operation: "session.close" as const,
				result: { sessionId: tenant.sessionId },
			};
			const pending = scope
				.run(() =>
					f.runtime.retireLifecycleSession(
						tenant,
						{ ...closeRequest(), timeoutMs: 15 },
						operationIdentity(),
						async outcome => {
							expect(outcome).toEqual(original);
							expect(outcome).not.toBe(original);
							observed.resolve();
							await persist.promise;
						},
					),
				)
				.catch(error => error);
			await entered.promise;
			expect(await pending).toMatchObject({ code: "timeout" });
			const settled = scope.seal();
			const disposal = f.runtime.dispose();
			let done = false;
			void disposal.then(
				() => {
					done = true;
				},
				() => {
					done = true;
				},
			);
			response.resolve(original);
			await observed.promise;
			expect(done).toBe(false);
			if (fail) {
				persist.reject(error);
				await expect(settled).rejects.toThrow("persistence failed");
				await expect(disposal).rejects.toThrow("persistence failed");
			} else {
				persist.resolve();
				await settled;
				await disposal;
			}
			expect(f.closeCalls).toHaveLength(1);
			expect(f.statusCalls).toEqual([]);
		},
	);

	test("retirement denies a missing original observer before authorization", async () => {
		const f = fixture();
		await f.runtime.start();
		try {
			await expect(
				Reflect.apply(f.runtime.retireLifecycleSession, f.runtime, [tenant, closeRequest(), operationIdentity()]),
			).rejects.toThrow("original outcome observer");
			expect(f.closeCalls).toEqual([]);
		} finally {
			await f.runtime.dispose();
		}
	});

	test("historical resume rejects a missing original observer before any admission", async () => {
		let fences = 0;
		const f = fixture({
			historicalResumeFence: () => {
				fences += 1;
				return true;
			},
		});
		await f.runtime.start();
		await expect(
			Reflect.apply(f.runtime.resumeHistoricalSession, f.runtime, [
				"migration:resume:attempt-1",
				historicalEvidence(),
			]),
		).rejects.toThrow("original outcome observer");
		expect(fences).toBe(0);
		expect(f.historicalResumeCalls).toEqual([]);
		await f.runtime.dispose();
	});

	test("purpose-only grants prove identity and retirement but never authorize active traffic", async () => {
		const operation = operationIdentity();
		const accesses: ManagedSdkAccess[] = [];
		const f = fixture({
			fence: (key, access) => {
				accesses.push(access);
				return (
					JSON.stringify(key) === JSON.stringify(tenant) &&
					access.kind !== "active" &&
					access.operationId === operation.operationId &&
					access.requestKey === operation.requestKey &&
					access.payloadHash === operation.payloadHash
				);
			},
		});
		await f.runtime.start();
		const token = await f.runtime.proveLifecycleTenant(tenant, operation);
		expect(await f.runtime.proveLifecycleTenant(tenant, operation)).toBe(token);
		expect(Object.keys(token).sort()).toEqual(["generation", "isCurrent", "tenant"]);
		for (const frame of [
			{ type: "control_request", operation: "turn.prompt" },
			{ type: "query_request", query: "session.state" },
		])
			await expect(f.runtime.request(token, frame)).rejects.toThrow("fence was lost");
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await expect(f.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
		await expect(f.runtime.generationStatus(tenant)).rejects.toThrow("fence was lost");
		expect(() => f.runtime.subscribeFrames(token, "turn", { commandId: "queued-command" }, () => {})).toThrow(
			"Active tenant acquisition",
		);
		expect(() => f.runtime.prepareFrameSubscription(token, "turn", () => {})).toThrow("Active tenant acquisition");
		const request = {
			...closeRequest(),
			target: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
		};
		await expect(f.runtime.retireLifecycleSession(tenant, request, operation, () => undefined)).rejects.toMatchObject(
			{
				code: "exact_close_authority_unavailable",
			},
		);
		expect(f.closeCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		expect(f.calls).not.toContain("request");
		await expect(f.runtime.retirementGenerationStatus(tenant, operation)).resolves.toMatchObject({
			status: "retired",
		});
		expect(f.statusCalls).toEqual([{ sessionId: tenant.sessionId, generation: tenant.generation }]);
		expect(accesses).toContainEqual({ ...operation, kind: "adoption-proof" });
		expect(accesses).toContainEqual({ ...operation, kind: "retirement", action: "close" });
		expect(accesses).toContainEqual({ ...operation, kind: "retirement", action: "generation-status" });
		expect(accesses.every(Object.isFrozen)).toBe(true);
		await f.runtime.stop();
	});

	test("promotes the same proof token only after active acquisition and rechecks revocation before buffered delivery", async () => {
		let active = false;
		const accesses: ManagedSdkAccess[] = [];
		const f = fixture({
			fence: (_key, access) => {
				accesses.push(access);
				return access.kind === "active" ? active : true;
			},
		});
		await f.runtime.start();
		const token = await f.runtime.proveLifecycleTenant(tenant, operationIdentity());
		expect(() => f.runtime.prepareFrameSubscription(token, "turn", () => {})).toThrow();
		active = true;
		expect(await f.runtime.acquireAttachment(tenant)).toBe(token);
		await expect(f.runtime.request(token, { type: "query_request", query: "session.state" })).resolves.toEqual({
			ok: true,
		});
		const received: number[] = [];
		const subscription = f.runtime.prepareFrameSubscription(token, "turn", observed => {
			received.push(observed.frame.seq!);
		});
		active = false;
		accesses.length = 0;
		await f.emit(observedFrame(1));
		await expect(subscription.drain()).rejects.toThrow("fence was lost");
		subscription.bind({ commandId: "queued-command" });
		await expect(subscription.drain()).rejects.toThrow("fence was lost");
		expect(received).toEqual([]);
		expect(accesses).toEqual([{ kind: "active" }]);
		subscription();
		await f.runtime.stop();
	});

	test("flushes earlier authorized pre-ack frames before a later queued frame at binding", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const received: number[] = [];
		const token = await f.runtime.acquireAttachment(tenant);
		const subscription = f.runtime.prepareFrameSubscription(token, "turn", observed => {
			received.push(observed.frame.seq!);
		});
		await f.emit(observedFrame(1));
		await subscription.drain();
		expect(received).toEqual([]);
		await f.emit(observedFrame(2));
		subscription.bind({ commandId: "queued-command" });
		await subscription.drain();
		expect(received).toEqual([1, 2]);
		subscription();
		await f.runtime.stop();
	});

	test("rechecks active authority between buffered listener deliveries", async () => {
		let allowed = true;
		const f = fixture({ fence: (_key, access) => access.kind === "active" && allowed });
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const received: number[] = [];
		const subscription = f.runtime.prepareFrameSubscription(
			await f.runtime.acquireAttachment(tenant),
			"turn",
			observed => {
				received.push(observed.frame.seq!);
				allowed = false;
			},
		);
		await f.emit(observedFrame(1));
		await subscription.drain();
		await f.emit(observedFrame(2));
		await subscription.drain();
		subscription.bind({ commandId: "queued-command" });
		await expect(subscription.drain()).rejects.toThrow("fence was lost");
		expect(received).toEqual([1]);
		subscription();
		await f.runtime.stop();
	});

	test("validates durable operation identities and retirement request-key binding before effects", async () => {
		let authorized = 0;
		const f = fixture({
			fence: () => {
				authorized += 1;
				return true;
			},
		});
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		for (const change of [
			{ operationId: "" },
			{ operationId: " x" },
			{ requestKey: "" },
			{ requestKey: "bad\nkey" },
			{ payloadHash: "a".repeat(63) },
			{ payloadHash: "A".repeat(64) },
			{ payloadHash: `sha256:${"a".repeat(64)}` },
			{ payloadHash: `${"a".repeat(64)}\n` },
		]) {
			const operation = { ...operationIdentity(), ...change };
			await expect(f.runtime.proveLifecycleTenant(tenant, operation)).rejects.toBeInstanceOf(TypeError);
			await expect(
				f.runtime.retireLifecycleSession(tenant, closeRequest(), operation, () => undefined),
			).rejects.toBeInstanceOf(TypeError);
			await expect(f.runtime.retirementGenerationStatus(tenant, operation)).rejects.toBeInstanceOf(TypeError);
		}
		await expect(
			f.runtime.retireLifecycleSession(
				tenant,
				closeRequest(),
				{ ...operationIdentity(), requestKey: "other" },
				() => undefined,
			),
		).rejects.toThrow("request key");
		expect(authorized).toBe(0);
		expect(f.calls).toEqual(["start"]);
		expect(f.closeCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		await f.runtime.stop();
	});

	test.each(["adoption", "retirement", "status"] as const)(
		"retains %s outcome without turning revoked authority into proof",
		async mode => {
			let allowed = true;
			const revoke = async () => {
				allowed = false;
			};
			const f = fixture({
				fence: (_key, access) => access.kind !== "active" && allowed,
				reconcile: mode === "adoption" ? revoke : undefined,
				close: async request => {
					await revoke();
					return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
				},
				generationStatus: async () => {
					await revoke();
					return { status: "unknown", reason: "session_not_observed" };
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const result =
				mode === "adoption"
					? f.runtime.proveLifecycleTenant(tenant, operationIdentity())
					: mode === "retirement"
						? f.runtime.retireLifecycleSession(tenant, closeRequest(), operationIdentity(), () => undefined)
						: f.runtime.retirementGenerationStatus(tenant, operationIdentity());
			if (mode === "retirement") {
				const receipt = await result;
				expect(receipt).toEqual({ ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } });
				await expect(f.runtime.retirementGenerationStatus(tenant, operationIdentity())).rejects.toThrow(
					"fence was lost",
				);
			} else await expect(result).rejects.toThrow("fence was lost");
			expect(f.closeCalls).toHaveLength(mode === "retirement" ? 1 : 0);
			await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
			await f.runtime.stop();
		},
	);

	test("rechecks adoption authorization before a serialized reconcile effect", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const admitted = deferred<void>();
		let allowed = true;
		const f = fixture({
			fence: (_key, access) => {
				admitted.resolve();
				return access.kind === "adoption-proof" && allowed;
			},
			reconcile: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		await f.runtime.start();
		const prior = f.runtime.reconcile();
		await entered.promise;
		const proving = f.runtime.proveLifecycleTenant(tenant, operationIdentity()).catch(error => error);
		await admitted.promise;
		allowed = false;
		release.resolve();
		await prior;
		expect(await proving).toBeInstanceOf(Error);
		expect(f.calls.filter(call => call === "reconcile")).toHaveLength(1);
		await f.runtime.stop();
	});

	test.each(["adoption", "retirement", "status"] as const)(
		"rejects %s when registration is replaced during purpose authorization",
		async mode => {
			const entered = deferred<void>();
			const release = deferred<boolean>();
			const f = fixture({
				fence: () => {
					entered.resolve();
					return release.promise;
				},
			});
			await f.runtime.start();
			f.runtime.registerTenant(tenant);
			const pending = (
				mode === "adoption"
					? f.runtime.proveLifecycleTenant(tenant, operationIdentity())
					: mode === "retirement"
						? f.runtime.retireLifecycleSession(tenant, closeRequest(), operationIdentity(), () => undefined)
						: f.runtime.retirementGenerationStatus(tenant, operationIdentity())
			).catch(error => error);
			await entered.promise;
			f.runtime.unregisterTenant(tenant);
			f.runtime.registerTenant({ ...tenant, leaseId: "replacement" });
			release.resolve(true);
			expect(await pending).toBeInstanceOf(Error);
			expect(f.closeCalls).toEqual([]);
			expect(f.statusCalls).toEqual([]);
			expect(f.calls).toEqual(["start"]);
			await f.runtime.stop();
		},
	);

	test("a close-only grant does not authorize generation status or caller-supplied active-purpose overrides", async () => {
		const seen: ManagedSdkAccess[] = [];
		const f = fixture({
			fence: (_key, access) => {
				seen.push(access);
				return access.kind === "retirement" && access.action === "close";
			},
		});
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		await expect(f.runtime.retirementGenerationStatus(tenant, operationIdentity())).rejects.toThrow("fence was lost");
		const attempted = { ...closeRequest(), access: { ...operationIdentity(), kind: "retirement", action: "close" } };
		await expect(f.runtime.closeLifecycleSession(tenant, attempted)).rejects.toThrow("fence was lost");
		expect(seen).toEqual([
			{ ...operationIdentity(), kind: "retirement", action: "generation-status" },
			{ kind: "active" },
		]);
		expect(f.closeCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("adoption proof cannot retain active subscription eligibility across registration replacement", async () => {
		let active = true;
		const f = fixture({ fence: (_key, access) => (access.kind === "active" ? active : true) });
		await f.runtime.start();
		f.runtime.registerTenant(tenant);
		const original = await f.runtime.acquireAttachment(tenant);
		f.runtime.unregisterTenant(tenant);
		active = false;
		const proof = await f.runtime.proveLifecycleTenant(tenant, operationIdentity());
		expect(proof).not.toBe(original);
		expect(original.isCurrent()).toBe(false);
		expect(() => f.runtime.prepareFrameSubscription(proof, "turn", () => {})).toThrow("Active tenant acquisition");
		await f.runtime.stop();
	});

	test("bounded stop invalidates queued proof authorization before a late reconcile", async () => {
		const entered = deferred<void>();
		const release = deferred<boolean>();
		const f = fixture({
			drainTimeoutMs: 15,
			fence: () => {
				entered.resolve();
				return release.promise;
			},
		});
		await f.runtime.start();
		const proof = f.runtime.proveLifecycleTenant(tenant, operationIdentity()).catch(error => error);
		await entered.promise;
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(await proof).toMatchObject({ code: "runtime_interrupted" });
		release.resolve(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.calls).toEqual(["start", "stop"]);
	});
	test("issues stable manager-only capabilities and revokes tokens after replacement or registration loss", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		expect(Object.keys(token).sort()).toEqual(["generation", "isCurrent", "tenant"]);
		expect(token).not.toHaveProperty("attachment");
		expect(token).not.toHaveProperty("send");
		expect(await f.runtime.acquireAttachment(tenant)).toBe(token);
		const reordered = {
			generation: tenant.generation,
			sessionId: tenant.sessionId,
			epoch: tenant.epoch,
			leaseId: tenant.leaseId,
			chatId: tenant.chatId,
			canonicalWorkspace: tenant.canonicalWorkspace,
			projectId: tenant.projectId,
			principalId: tenant.principalId,
		};
		expect(await f.runtime.acquireAttachment(reordered)).toBe(token);
		await expect(f.runtime.request({ ...token }, {})).rejects.toThrow("Manager-issued");
		f.replaceAttachment();
		expect(token.isCurrent()).toBe(false);
		const replacement = await f.runtime.acquireAttachment(tenant);
		expect(replacement).not.toBe(token);
		f.runtime.unregisterTenant(tenant);
		f.runtime.registerTenant(tenant);
		expect(replacement.isCurrent()).toBe(false);
		await f.runtime.stop();
	});

	test.each(["missing", "denied"] as const)("fails closed with %s prepared and registered fences", async mode => {
		const f = fixture({
			omitTenantFence: mode === "missing",
			omitPreparedFence: mode === "missing",
			fence: () => false,
			preparedFence: () => false,
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await expect(f.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
		await expect(f.runtime.listLifecycleSessions(tenant, listRequest())).rejects.toThrow("fence was lost");
		await expect(f.runtime.proveLifecycleTenant(tenant, operationIdentity())).rejects.toThrow("fence was lost");
		await expect(
			f.runtime.retireLifecycleSession(tenant, closeRequest(), operationIdentity(), () => undefined),
		).rejects.toThrow("fence was lost");
		await expect(f.runtime.retirementGenerationStatus(tenant, operationIdentity())).rejects.toThrow("fence was lost");
		await expect(
			f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest()),
		).rejects.toThrow("fence was lost");
		expect(f.createCalls).toEqual([]);
		expect(f.closeCalls).toEqual([]);
		expect(f.listCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("validates prepared actor, key and workspace without inventing a session identity", async () => {
		const seen: ManagedPreparedTurnAuthority[] = [];
		const f = fixture({
			preparedFence: authority => {
				seen.push(authority);
				return true;
			},
		});
		await f.runtime.start();
		for (const changed of [
			{ actor: { ...createRequest().actor, id: "foreign" } },
			{ actor: { ...createRequest().actor, namespace: "foreign" } },
			{ requestKey: "foreign" },
			{ target: { kind: "existing_path" as const, path: "/foreign" } },
		])
			await expect(
				f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), { ...createRequest(), ...changed }),
			).rejects.toThrow();
		await expect(
			f.runtime.createPreparedExternalLifecycleSession(
				{ ...preparedAuthority(), sessionId: "invented" } as never,
				createRequest(),
			),
		).rejects.toThrow();
		expect(f.createCalls).toEqual([]);
		await f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest());
		expect(seen).toEqual([preparedAuthority()]);
		expect(f.createCalls[0]!.readinessTimeoutMs).toBe(4_000);
		await f.runtime.stop();
	});

	test.each(["prepared", "registered"] as const)(
		"never dispatches after a late %s authorization deadline",
		async kind => {
			const fence = deferred<boolean>();
			const entered = deferred<void>();
			const wait = () => {
				entered.resolve();
				return fence.promise;
			};
			const f = fixture({ fence: wait, preparedFence: wait });
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const call =
				kind === "prepared"
					? f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest(), 15)
					: f.runtime.closeLifecycleSession(tenant, { ...closeRequest(), timeoutMs: 15 });
			await entered.promise;
			await expect(call).rejects.toMatchObject({ code: "timeout" });
			fence.resolve(true);
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(f.createCalls).toEqual([]);
			expect(f.closeCalls).toEqual([]);
			await f.runtime.stop();
		},
	);

	test("rejects a prepared lease lost during asynchronous admission", async () => {
		const fence = deferred<boolean>();
		const f = fixture({ preparedFence: () => fence.promise });
		await f.runtime.start();
		const creating = f.runtime.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest());
		fence.resolve(false);
		await expect(creating).rejects.toThrow("fence was lost");
		expect(f.createCalls).toEqual([]);
		await f.runtime.stop();
	});

	test("binds external resume to the complete session id and workspace and rejects broad list targets", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const resume: ResumeRequest = {
			actor: closeRequest().actor,
			capability: "session.resume",
			requestKey: "resume",
			target: { sessionIdOrPrefix: tenant.sessionId, path: tenant.canonicalWorkspace },
			readinessTimeoutMs: 4_000,
		};
		for (const target of [
			{ ...resume.target, sessionIdOrPrefix: "session" },
			{ ...resume.target, path: "/foreign" },
		])
			await expect(f.runtime.resumeExternalLifecycleSession(tenant, { ...resume, target })).rejects.toThrow();
		for (const target of [
			undefined,
			{ cwd: tenant.canonicalWorkspace },
			{ ...listRequest().target, scope: { kind: "all" } },
			{ ...listRequest().target, resolveSessionId: "foreign" },
		])
			await expect(f.runtime.listLifecycleSessions(tenant, { ...listRequest(), target } as never)).rejects.toThrow();
		expect(f.resumeCalls).toEqual([]);
		expect(f.listCalls).toEqual([]);
		await f.runtime.resumeExternalLifecycleSession(tenant, resume);
		expect(f.resumeCalls[0]?.target).toEqual(resume.target);
		await f.runtime.stop();
	});

	test("filters declared list authority without leaking global evidence", async () => {
		const exact = {
			sessionId: tenant.sessionId,
			endpointGeneration: tenant.generation,
			cwd: tenant.canonicalWorkspace,
		};
		const f = fixture({
			list: async () => ({
				ok: true,
				operation: "session.list",
				result: {
					indexSeq: 3,
					sessions: [
						exact,
						{ ...exact, sessionId: "foreign" },
						{ ...exact, endpointGeneration: 8 },
						{ ...exact, cwd: "/foreign" },
					],
					warnings: ["foreign workspace secret"],
				},
			}),
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const result = await f.runtime.listLifecycleSessions(tenant, {
			...listRequest(),
			target: { ...listRequest().target, cursor: "opaque" },
		});
		expect(result).toEqual({
			ok: true,
			operation: "session.list",
			result: { indexSeq: 3, sessions: [exact], warnings: [] },
		});
		await f.runtime.stop();
	});

	test("rejects unfilterable list output and always blocks public delete before effect", async () => {
		const f = fixture({
			list: async () => ({ ok: true, operation: "session.list", result: { items: ["foreign"] } }) as never,
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		await expect(f.runtime.listLifecycleSessions(tenant, listRequest())).rejects.toMatchObject({
			code: "invalid_result",
		});
		await expect(
			f.runtime.deleteLifecycleSession(tenant, {
				actor: closeRequest().actor,
				capability: "session.delete",
				requestKey: "delete",
				target: { sessionId: tenant.sessionId },
			}),
		).rejects.toMatchObject({ code: "exact_delete_authority_unavailable" });
		expect(f.calls).not.toContain("delete");
		await f.runtime.stop();
	});

	test.each(["replacement", "lease", "unregister"] as const)(
		"drops queued frames after %s and records failed observation",
		async change => {
			let allowed = true;
			const f = fixture({ fence: () => allowed });
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const first = deferred<void>();
			const release = deferred<void>();
			const received: number[] = [];
			const subscription = f.runtime.subscribeFrames(
				await f.runtime.acquireAttachment(tenant),
				"turn",
				{ commandId: "queued-command" },
				async value => {
					received.push(value.frame.seq!);
					first.resolve();
					await release.promise;
				},
			);
			await f.emit(observedFrame(1));
			await first.promise;
			await f.emit(observedFrame(2));
			if (change === "replacement") f.replaceAttachment();
			else if (change === "lease") allowed = false;
			else f.runtime.unregisterTenant(tenant);
			release.resolve();
			await expect(subscription.drain()).rejects.toThrow();
			expect(received).toEqual([1]);
			expect(f.runtime.frameDiagnostics().listenerError).toBe(1);
			subscription();
			await f.runtime.stop();
		},
	);

	test.each(["request", "lifecycle", "authorization"] as const)(
		"bounds shutdown for a hanging %s without later dispatch",
		async kind => {
			const entered = deferred<void>();
			const result = deferred<Record<string, unknown>>();
			const fence = deferred<boolean>();
			let blockFence = false;
			const f = fixture({
				drainTimeoutMs: 15,
				fence: () => {
					if (!blockFence) return true;
					entered.resolve();
					return fence.promise;
				},
				request: () => {
					entered.resolve();
					return result.promise;
				},
				close: async () => {
					entered.resolve();
					await result.promise;
					return { ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } };
				},
			});
			f.runtime.registerTenant(tenant);
			await f.runtime.start();
			const token = await f.runtime.acquireAttachment(tenant);
			blockFence = kind === "authorization";
			const pending = (
				kind === "request"
					? f.runtime.request(token, {}, { timeoutMs: 500 })
					: f.runtime.closeLifecycleSession(tenant, closeRequest())
			).catch(error => error);
			await entered.promise;
			const stopped = f.runtime.stop();
			await expect(stopped).rejects.toMatchObject({ code: "drain_timeout" });
			expect(await pending).toMatchObject({ code: "runtime_interrupted" });
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
			fence.resolve(true);
			result.resolve({ ok: true });
			await new Promise(resolve => setTimeout(resolve, 0));
			if (kind === "authorization") expect(f.closeCalls).toEqual([]);
			expect(token.isCurrent()).toBe(false);
		},
	);

	test("bounds a hanging Router stop and never remotely closes sessions", async () => {
		const f = fixture({ drainTimeoutMs: 15, stop: () => new Promise(() => {}) });
		await f.runtime.start();
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(f.runtime.state).toBe("stopping");
		expect(f.closeCalls).toEqual([]);
	});

	test("graceful drain and local Router stop consume one deadline", async () => {
		const entered = deferred<void>();
		const response = deferred<Record<string, unknown>>();
		const stopped = deferred<void>();
		const f = fixture({
			drainTimeoutMs: 1000,
			request: () => {
				entered.resolve();
				return response.promise;
			},
			stop: () => stopped.promise,
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		const call = f.runtime.request(token, {});
		await entered.promise;
		let now = performance.now();
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const shutdown = f.runtime.stop();
			expect(f.runtime.stop()).toBe(shutdown);
			now += 400;
			response.resolve({ ok: true });
			await call;
			for (let i = 0; i < 20 && !f.calls.includes("stop"); i += 1) await Promise.resolve();
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
			now += 700;
			stopped.resolve();
			await expect(shutdown).rejects.toMatchObject({ code: "drain_timeout" });
			await f.runtime.dispose();
			expect(f.runtime.state).toBe("stopped");
			expect(f.closeCalls).toEqual([]);
		} finally {
			clock.mockRestore();
			response.resolve({ ok: true });
			stopped.resolve();
		}
	});

	test("an exhausted shutdown budget cannot invoke the next local effect", async () => {
		const entered = deferred<void>();
		const response = deferred<Record<string, unknown>>();
		const f = fixture({
			drainTimeoutMs: 1000,
			request: () => {
				entered.resolve();
				return response.promise;
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		const call = f.runtime.request(token, {});
		await entered.promise;
		let now = performance.now();
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const shutdown = f.runtime.stop();
			now += 1001;
			response.resolve({ ok: true });
			await call;
			await expect(shutdown).rejects.toMatchObject({ code: "drain_timeout" });
			expect(f.calls).not.toContain("stop");
			expect(f.runtime.state).toBe("failed");
			expect(token.isCurrent()).toBe(false);
		} finally {
			clock.mockRestore();
			response.resolve({ ok: true });
		}
	});

	test("never starts tracked work after stop wins the admission microtask", async () => {
		const f = fixture();
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const call = f.runtime.closeLifecycleSession(tenant, closeRequest()).catch(error => error);
		await f.runtime.stop();
		expect(await call).toMatchObject({ code: "runtime_interrupted" });
		expect(f.closeCalls).toEqual([]);
	});

	test("settles an already dispatched request during drain while rejecting new work", async () => {
		const entered = deferred<void>();
		const response = deferred<Record<string, unknown>>();
		const f = fixture({
			request: () => {
				entered.resolve();
				return response.promise;
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const token = await f.runtime.acquireAttachment(tenant);
		const accepted = f.runtime.request(token, {});
		await entered.promise;
		const stopping = f.runtime.stop();
		await expect(f.runtime.request(token, {})).rejects.toMatchObject({ code: "runtime_interrupted" });
		response.resolve({ ok: true });
		await expect(accepted).resolves.toEqual({ ok: true });
		await stopping;
		expect(f.calls.filter(call => call === "request")).toHaveLength(1);
	});

	test("invalidates a prepared authorization still pending when drain expires", async () => {
		const entered = deferred<void>();
		const fence = deferred<boolean>();
		const f = fixture({
			drainTimeoutMs: 15,
			preparedFence: () => {
				entered.resolve();
				return fence.promise;
			},
		});
		await f.runtime.start();
		const call = f.runtime
			.createPreparedExternalLifecycleSession(preparedAuthority(), createRequest())
			.catch(error => error);
		await entered.promise;
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(await call).toMatchObject({ code: "runtime_interrupted" });
		fence.resolve(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(f.createCalls).toEqual([]);
	});

	test("bounds stop without overlapping a late start or forgetting a queued delivery", async () => {
		const startGate = deferred<void>();
		const starting = fixture({ drainTimeoutMs: 15, start: () => startGate.promise });
		void starting.runtime.start();
		await expect(starting.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		expect(starting.calls).toEqual(["start"]);
		expect(starting.runtime.state).toBe("stopping");
		const disposal = starting.runtime.dispose();
		let settled = false;
		void disposal.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		startGate.resolve();
		await expect(disposal).rejects.toMatchObject({ code: "drain_timeout" });
		expect(starting.runtime.state).toBe("failed");
		expect(starting.calls).toEqual(["start"]);
		let blocked = false;
		const fence = deferred<boolean>();
		const f = fixture({ drainTimeoutMs: 15, fence: () => (blocked ? fence.promise : true) });
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		let delivered = false;
		const token = await f.runtime.acquireAttachment(tenant);
		const subscription = f.runtime.subscribeFrames(token, "turn", { commandId: "queued-command" }, () => {
			delivered = true;
		});
		blocked = true;
		await f.emit(observedFrame(1));
		await expect(f.runtime.stop()).rejects.toMatchObject({ code: "drain_timeout" });
		fence.resolve(true);
		await expect(subscription.drain()).rejects.toThrow();
		await f.runtime.dispose();
		expect(delivered).toBe(false);
	});

	test("returns close acknowledgement after revocation but rejects fresh live proof", async () => {
		let allowed = true;
		const f = fixture({
			fence: () => allowed,
			close: async request => {
				allowed = false;
				return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
			},
		});
		f.runtime.registerTenant(tenant);
		await f.runtime.start();
		const receipt = await f.runtime.closeLifecycleSession(tenant, closeRequest());
		expect(receipt).toEqual({ ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } });
		await expect(f.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await expect(f.runtime.generationStatus(tenant)).rejects.toThrow("fence was lost");
		expect(f.closeCalls).toHaveLength(1);
		await f.runtime.stop();
	});

	test("shares start/stop races, admits bootstrap only while starting, and records start failure", async () => {
		const startGate = deferred<void>();
		const active = fixture({ start: async () => await startGate.promise });
		active.runtime.registerTenant(tenant);
		const firstStart = active.runtime.start();
		expect(active.runtime.start()).toBe(firstStart);
		expect(active.runtime.bootstrapAdmissionOpen).toBe(true);
		await expect(active.runtime.acquireAttachment(tenant)).resolves.toMatchObject({ generation: 7 });
		const stopping = active.runtime.stop();
		expect(active.runtime.bootstrapAdmissionOpen).toBe(false);
		startGate.resolve();
		await Promise.all([firstStart, stopping]);
		expect(active.runtime.state).toBe("stopped");
		expect(active.calls).toEqual(["start", "stop"]);

		const failed = fixture({
			start: async () => {
				throw new Error("start failed");
			},
		});
		await expect(failed.runtime.start()).rejects.toThrow("start failed");
		expect(failed.runtime.state).toBe("failed");
	});

	test("requires full registered tenant fencing, exact positive generation, and a current attachment", async () => {
		const current = fixture();
		await current.runtime.start();
		await expect(current.runtime.acquireAttachment(tenant)).rejects.toThrow("not registered");
		current.runtime.registerTenant(tenant);
		const managed = await current.runtime.acquireAttachment(tenant);
		await expect(current.runtime.acquireAttachment({ ...tenant, generation: 0 })).rejects.toThrow(
			"positive generation",
		);
		await expect(current.runtime.acquireAttachment({ ...tenant, leaseId: "wrong" })).rejects.toThrow(
			"not registered",
		);
		await expect(current.runtime.request({ ...managed, generation: 8 }, {})).rejects.toThrow(
			"Exact tenant generation",
		);
		(current.attachment as unknown as { isCurrent: () => boolean }).isCurrent = () => false;
		await expect(current.runtime.request(managed, {})).rejects.toThrow("Current Router attachment");
		await current.runtime.stop();

		const fenced = fixture({ fence: () => false });
		fenced.runtime.registerTenant(tenant);
		await fenced.runtime.start();
		await expect(fenced.runtime.acquireAttachment(tenant)).rejects.toThrow("fence was lost");
		await fenced.runtime.stop();
	});

	test("reserves one complete tenant for each session generation and rejects foreign boundaries", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		expect(() => current.runtime.registerTenant({ ...tenant, leaseId: "foreign-lease" })).toThrow("already owned");
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const foreign = { ...managed, tenant: { ...tenant, leaseId: "foreign-lease" } };
		await expect(current.runtime.request(foreign, {})).rejects.toThrow("not registered");
		expect(() =>
			current.runtime.subscribeFrames(foreign, "turn", { commandId: "command-foreign" }, () => {}),
		).toThrow("Registered current tenant attachment");
		await current.emit(
			{
				body: {},
				name: "event",
				sessionId: tenant.sessionId,
				generation: tenant.generation,
				commandId: "command-foreign",
				seq: 1,
			},
			current.foreignAttachment,
		);
		expect(current.runtime.frameDiagnostics().foreign).toBe(1);
		await current.runtime.stop();
	});

	test("delegates request settlement solely to Router and preserves dispatch hook order", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const order: string[] = [];
		await expect(
			current.runtime.request(
				managed,
				{ type: "query_request" },
				{
					beforeDispatch: () => order.push("before"),
					onDispatch: () => order.push("after"),
				},
			),
		).resolves.toEqual({ ok: true });
		expect(order).toEqual(["before", "after"]);
		expect(current.calls).toContain("request");
		await current.runtime.stop();
	});

	test("multiplexes only matching frames with duplicate, foreign, overflow, and cleanup classification", async () => {
		const current = fixture({ maxFrames: 1 });
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const received: string[] = [];
		const listenerEntered = deferred<void>();
		const releaseListener = deferred<void>();
		const unsubscribe = current.runtime.subscribeFrames(managed, "turn", { commandId: "command-1" }, async frame => {
			received.push(String(frame.frame.seq));
			listenerEntered.resolve();
			await releaseListener.promise;
		});
		const matching = {
			body: {},
			name: "event",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			commandId: "command-1",
			seq: 1,
		};
		await current.emit(matching);
		await listenerEntered.promise;
		await current.emit(matching);
		await current.emit({ ...matching, sessionId: "foreign", seq: 2 });
		await current.emit({ ...matching, seq: 3 });
		unsubscribe();
		unsubscribe();
		await current.emit({ ...matching, seq: 4 });
		releaseListener.resolve();
		await Promise.resolve();
		expect(received).toEqual(["1"]);
		expect(current.runtime.frameDiagnostics()).toMatchObject({ duplicate: 1, foreign: 1, overflow: 1, late: 1 });
		await current.runtime.stop();
	});

	test("forwards exact-generation retirement status without retaining credential data", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		await expect(current.runtime.generationStatus(tenant)).resolves.toMatchObject({ status: "retired" });
		expect(JSON.stringify(current.runtime.frameDiagnostics())).not.toContain("token");
		expect(JSON.stringify(current.runtime.frameDiagnostics())).not.toContain("url");
		await current.runtime.dispose();
	});

	test("rejects lifecycle calls without complete managed tenant authority", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		await expect(
			current.runtime.createLifecycleSession({
				actor: { id: tenant.principalId, namespace: "adapter" },
				capability: "session.create",
				requestKey: "create-1",
				target: { cwd: tenant.canonicalWorkspace },
			} as never),
		).rejects.toThrow("Complete managed tenant authority");
		expect("lifecycleService" in current.runtime).toBeFalse();
		await current.runtime.stop();
	});

	test("rejects tenantless close even with paired endpoint authority", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(closeRequest() as never)).rejects.toThrow(
				"Complete managed tenant authority",
			);
			await expect(current.runtime.closeLifecycleSession({ request: closeRequest() } as never)).rejects.toThrow(
				"Complete managed tenant authority",
			);
			await expect(
				current.runtime.closeLifecycleSession({
					...closeRequest(),
					tenant: { sessionId: tenant.sessionId },
				} as never),
			).rejects.toThrow("Complete managed tenant authority");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test("rejects close without registration or with foreign tenant, session, generation, or fence identity", async () => {
		const current = fixture();
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("not registered");
			current.runtime.registerTenant(tenant);
			for (const foreign of [
				{ principalId: "foreign-principal" },
				{ projectId: "foreign-project" },
				{ canonicalWorkspace: "/foreign-workspace" },
				{ chatId: "foreign-chat" },
				{ sessionId: "foreign-session" },
				{ generation: tenant.generation + 1 },
				{ leaseId: "foreign-lease" },
				{ epoch: "foreign-epoch" },
			]) {
				await expect(
					current.runtime.closeLifecycleSession({ ...tenant, ...foreign }, closeRequest()),
				).rejects.toThrow("not registered");
			}
			await expect(
				current.runtime.closeLifecycleSession(tenant, {
					...closeRequest(),
					actor: { id: "foreign-principal", namespace: "adapter" },
				}),
			).rejects.toThrow("Lifecycle actor does not match");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each([
		{ name: "absent target", target: undefined },
		{ name: "empty target", target: {} },
		{
			name: "missing session",
			target: {
				endpointGeneration: tenant.generation,
				endpointIncarnation: closeRequest().target.endpointIncarnation,
			},
		},
		{ name: "foreign session", target: { ...closeRequest().target, sessionId: "foreign-session" } },
		{ name: "session-ID-only", target: { sessionId: tenant.sessionId } },
		{
			name: "incarnation without generation",
			target: { sessionId: tenant.sessionId, endpointIncarnation: closeRequest().target.endpointIncarnation },
		},
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, tenant.generation + 1, String(tenant.generation), null].map(
			generation => ({
				name: `invalid or foreign generation ${generation}`,
				target: { ...closeRequest().target, endpointGeneration: generation },
			}),
		),
	])("rejects close with $name before SDK mutation", async ({ target }) => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(
				current.runtime.closeLifecycleSession(tenant, { ...closeRequest(), target } as never),
			).rejects.toThrow(/target.*(generation|managed tenant authority)/i);
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each([
		undefined,
		null,
		"",
		"a".repeat(63),
		"a".repeat(65),
		"A".repeat(64),
		"g".repeat(64),
		`${"a".repeat(64)}\n`,
		123,
	])(
		"fails closed with an actionable unavailable diagnostic for absent or invalid incarnation %j",
		async endpointIncarnation => {
			const current = fixture();
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			try {
				await expect(
					current.runtime.closeLifecycleSession(tenant, {
						...closeRequest(),
						target: { ...closeRequest().target, endpointIncarnation },
					} as never),
				).rejects.toMatchObject({
					code: "exact_close_authority_unavailable",
					message: expect.stringContaining("Missing persisted incarnation authority"),
				});
				expect(current.closeCalls).toHaveLength(0);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test.each(["explicit", "wrapped", "flat"] as const)(
		"forwards a supplied opaque pair untouched with %s tenant admission",
		async shape => {
			let fenceChecks = 0;
			const current = fixture({
				fence: () => {
					fenceChecks += 1;
					return true;
				},
			});
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			const request = closeRequest();
			try {
				const outcome =
					shape === "explicit"
						? await current.runtime.closeLifecycleSession(tenant, request)
						: shape === "wrapped"
							? await current.runtime.closeLifecycleSession({ tenant, request })
							: await current.runtime.closeLifecycleSession({ tenant, ...request });
				expect(outcome).toEqual({ ok: true, operation: "session.close", result: { sessionId: tenant.sessionId } });
				expect(fenceChecks).toBe(1);
				expect(current.closeCalls).toHaveLength(1);
				expect(current.closeCalls[0]?.target).toEqual(request.target);
				expect(current.closeCalls[0]?.requestKey).toBe(request.requestKey);
				expect(current.closeCalls[0]?.timeoutMs).toBeGreaterThan(0);
				expect(current.closeCalls[0]!.timeoutMs!).toBeLessThanOrEqual(request.timeoutMs!);
				expect(request.timeoutMs).toBe(500);
				expect(current.calls).toEqual(["start"]);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test("does not dispatch paired close when the tenant fence is lost", async () => {
		const current = fixture({ fence: () => false });
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		try {
			await expect(current.runtime.closeLifecycleSession(tenant, closeRequest())).rejects.toThrow("fence was lost");
			expect(current.closeCalls).toHaveLength(0);
		} finally {
			await current.runtime.dispose();
		}
	});

	test.each(["fence loss", "unregistration", "registration replacement"] as const)(
		"rejects paired close after %s during authorization",
		async change => {
			const fenceEntered = deferred<void>();
			const fenceResult = deferred<boolean>();
			const current = fixture({
				fence: async () => {
					fenceEntered.resolve();
					return await fenceResult.promise;
				},
			});
			current.runtime.registerTenant(tenant);
			await current.runtime.start();
			try {
				const closing = current.runtime.closeLifecycleSession(tenant, closeRequest());
				await fenceEntered.promise;
				expect(current.closeCalls).toHaveLength(0);
				if (change !== "fence loss") current.runtime.unregisterTenant(tenant);
				if (change === "registration replacement")
					current.runtime.registerTenant({ ...tenant, leaseId: "replacement-lease" });
				fenceResult.resolve(change !== "fence loss");
				await expect(closing).rejects.toThrow(change === "fence loss" ? "fence was lost" : "registration changed");
				expect(current.closeCalls).toHaveLength(0);
			} finally {
				await current.runtime.dispose();
			}
		},
	);

	test("exposes listener failures through subscription drain and diagnostics", async () => {
		const current = fixture();
		current.runtime.registerTenant(tenant);
		await current.runtime.start();
		const managed = await current.runtime.acquireAttachment(tenant);
		const unsubscribe = current.runtime.subscribeFrames(managed, "turn", { commandId: "command-error" }, () => {
			throw new Error("listener failed");
		});
		await current.emit({
			body: {},
			name: "event",
			sessionId: tenant.sessionId,
			generation: tenant.generation,
			commandId: "command-error",
			seq: 1,
		});
		await expect(unsubscribe.drain()).rejects.toThrow("listener failed");
		expect(current.runtime.frameDiagnostics().listenerError).toBe(1);
		unsubscribe();
		await current.runtime.stop();
	});
});
