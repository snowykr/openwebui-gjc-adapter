import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import {
	createManagedLifecycleEvidence,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import { ManagedSdkRuntime, type ManagedSdkRuntimeDeps, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { routeGjcTurn } from "../src/gjc/session-turn-router";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import * as managedIdle from "../src/live/gjc-managed-idle-reaper";
import { createManagedV3GenerationStore } from "../src/live/gjc-managed-idle-reaper";
import { createManagedGjcTurnRunner } from "../src/live/gjc-managed-turn-runner";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-gateway";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { createUserWorkspaceRegistry } from "../src/security/user-workspace";
import { createWorkspaceLeaseManager, workspaceLeaseId } from "../src/security/workspace-lease";
import { writeDirectV3Authority } from "./cli-fixtures";

async function fixture(controls: { afterCreate?: () => Promise<void>; afterFork?: () => void } = {}) {
	const root = await mkdtemp(join(tmpdir(), "gjc-production-lifecycle-"));
	const stateRoot = join(root, "state");
	const sessionRoot = join(root, "sessions");
	const projectRoot = join(root, "project");
	await mkdir(projectRoot);
	await writeDirectV3Authority(sessionRoot);
	const projects = new SqliteProjectRegistrationStore(":memory:");
	const project = projects.linkProject(
		{ id: "project", name: "project", cwd: projectRoot, allowedRoot: root, createdAt: new Date() },
		"admin",
	);
	const workspace = await createUserWorkspaceRegistry({ stateRoot }).open("principal");
	const leases = createWorkspaceLeaseManager({ stateRoot });
	const lease = await leases.acquire({
		safeKey: workspace.safeKey,
		holderId: "turn-owner",
		operation: "turn",
		leaseDurationMs: 60_000,
	});
	const prepared = {
		principalId: "principal",
		projectId: project.id,
		canonicalWorkspace: workspace.root,
		chatId: "logical-chat",
		leaseId: workspaceLeaseId(lease),
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		requestKey: "ingress",
	};
	const calls: string[] = [];
	const attachments = new Map<string, router.SessionAttachment>();
	let onFrame: NonNullable<router.SessionRouterDeps["onFrame"]> | undefined;
	let deps!: ManagedSdkRuntimeDeps;
	let runtime!: ManagedSdkRuntime;
	const authorityPath = join(sessionRoot, "openwebui-session-mappings.json");
	let reaperInput!: managedIdle.CreateManagedIdleReaperInput;
	const createReaper = managedIdle.createManagedIdleReaper;
	const capture = spyOn(managedIdle, "createManagedIdleReaper").mockImplementation(input => {
		reaperInput = input;
		return createReaper(input);
	});
	const options = await buildAdapterServerOptions(
		{
			mode: "existing",
			bindHost: "127.0.0.1",
			bindPort: 8765,
			openWebUIBaseUrl: "http://127.0.0.1:3000",
			allowedProjectRoots: [projectRoot],
			projects: [],
			statePath: stateRoot,
			sessionRoot,
			gjcCommand: "/bin/true",
			turnTimeoutMs: 2_000,
		},
		{
			projectRegistrationStore: projects,
			createManagedSdkRuntime(agentDir, productionDeps) {
				deps = productionDeps;
				runtime = new ManagedSdkRuntime({
					agentDir,
					deps: {
						...productionDeps,
						createLifecycleService: () =>
							({
								async createExternal() {
									const document = JSON.parse(await readFile(authorityPath, "utf8"));
									expect(document.provisionalOperations[0].lifecycle.state).toBe("invoking");
									calls.push("create");
									attachments.set("assigned", {
										sessionId: "assigned",
										generation: 1,
										isCurrent: () => true,
									} as router.SessionAttachment);
									await controls.afterCreate?.();
									return {
										ok: true,
										operation: "session.create",
										result: { sessionId: "assigned", endpointGeneration: 1 },
									};
								},
								async fork(
									request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0],
								) {
									const document = JSON.parse(await readFile(authorityPath, "utf8"));
									expect(document.mappings[0].journal.at(-1).lifecycle.state).toBe("invoking");
									expect(request.target.sourceSessionId).toBe("assigned");
									expect(request.target.cwd).toBe(workspace.root);
									calls.push("fork");
									attachments.set("forked", {
										sessionId: "forked",
										generation: 2,
										isCurrent: () => true,
									} as router.SessionAttachment);
									controls.afterFork?.();
									return {
										ok: true,
										operation: "session.fork",
										result: { sessionId: "forked", endpointGeneration: 2 },
									};
								},
							}) as unknown as ReturnType<typeof lifecycle.createSessionLifecycleService>,
						createRouter(input) {
							onFrame = input.deps?.onFrame;
							return {
								async start() {},
								async stop() {},
								async reconcile() {},
								attachment(sessionId: string, generation: number) {
									const attachment = attachments.get(sessionId);
									return attachment?.generation === generation ? attachment : undefined;
								},
								async generationStatus() {
									return { status: "current" };
								},
								async request(
									sessionId: string,
									frame: Record<string, unknown>,
									generation: number,
									attachment: router.SessionAttachment,
									requestOptions: {
										beforeDispatch?: (value: never) => void;
										onDispatch?: (value: never) => void;
									},
								) {
									requestOptions.beforeDispatch?.({} as never);
									requestOptions.onDispatch?.({} as never);
									calls.push(String(frame.query ?? frame.operation));
									if (frame.type === "query_request")
										return { type: "query_response", ok: true, page: { items: [], complete: true } };
									await onFrame?.(attachment, {
										name: "event",
										sessionId,
										generation,
										seq: 1,
										commandId: "command",
										turnId: "turn",
										body: { type: "agent_end", finalText: "production-fenced" },
									});
									return {
										type: "control_response",
										ok: true,
										result: { commandId: "command", turnId: "turn" },
									};
								},
							} as unknown as router.SessionRouter;
						},
					},
				});
				return runtime;
			},
		},
	).finally(() => capture.mockRestore());
	const mappings = options.routes!.mappings!;
	if (!(mappings instanceof V3FileBackedSessionMappingStore))
		throw new Error("Production did not construct the canonical store.");
	return {
		root,
		project,
		prepared,
		deps,
		runtime,
		mappings,
		calls,
		attachments,
		lease,
		leases,
		workspace,
		reaperInput,
		async close() {
			await options.shutdownCleanup?.();
			await options.runtimeLock.release();
			await lease.release();
			projects.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("production fences permit create acknowledgement, proof, prompt and immutable canonical replay", async () => {
	const f = await fixture();
	try {
		expect(await f.deps.preparedTenantFence!(f.prepared)).toBe(false);
		const input = {
			project: { ...f.project, cwd: f.workspace.root, sessionRoot: f.workspace.sessionRoot },
			principalId: f.prepared.principalId,
			chatId: f.prepared.chatId,
			userMessageId: "ingress",
			text: "hello",
			preparedManagedAuthority: f.prepared,
			mappings: f.mappings,
			runner: createManagedGjcTurnRunner(f.runtime, 2_000),
		};
		const result = await routeGjcTurn(input);
		expect(result.assistantText).toBe("production-fenced");
		const operation = f.mappings.operationScoped(f.prepared, "ingress")!;
		expect(operation.lifecycle).toMatchObject({
			state: "active_generation_proven",
			requestKey: "ingress",
			preparedAuthority: f.prepared,
			acknowledged: { sessionId: "assigned", generation: 1 },
		});
		const dispatched = [...f.calls];
		expect(await routeGjcTurn({ ...input, managedAuthority: result.mapping.managedAuthority })).toEqual(result);
		expect(f.calls).toEqual(dispatched);
		const key = { ...f.prepared, sessionId: "assigned", generation: 1 };
		expect(await f.deps.tenantFence!(key, { kind: "active" })).toBe(true);
		f.mappings.beginOperationScoped(f.prepared, { id: "close", kind: "close", detail: "close-payload" });
		expect(await f.deps.tenantFence!(key, { kind: "active" })).toBe(false);
		await expect(f.runtime.acquireAttachment(key)).rejects.toThrow("fence");
		expect(f.calls).toEqual(dispatched);
	} finally {
		await f.close();
	}
});

test("production create persists its exact acknowledgement even when the lease is revoked by the effect", async () => {
	const controls: { afterCreate?: () => Promise<void> } = {};
	const f = await fixture(controls);
	controls.afterCreate = () => f.lease.release();
	try {
		await expect(
			routeGjcTurn({
				project: { ...f.project, cwd: f.workspace.root, sessionRoot: f.workspace.sessionRoot },
				principalId: f.prepared.principalId,
				chatId: f.prepared.chatId,
				userMessageId: "ingress",
				text: "hello",
				preparedManagedAuthority: f.prepared,
				mappings: f.mappings,
				runner: createManagedGjcTurnRunner(f.runtime, 2_000),
			}),
		).rejects.toThrow();
		const operation = f.mappings.provisionalOperationScoped(f.prepared, "ingress")!;
		expect(operation.state).toBe("uncertain");
		expect(operation.lifecycle?.state).toBe("uncertain");
		expect(operation.lifecycle?.acknowledged).toEqual({ ...f.prepared, sessionId: "assigned", generation: 1 });
		expect(operation.lifecycle?.proven).toBeUndefined();
		expect(operation.result).toBeUndefined();
		expect(f.calls).toEqual(["create"]);
		const key = { ...f.prepared, sessionId: "assigned", generation: 1 };
		await expect(f.runtime.acquireAttachment(key)).rejects.toThrow("fence");
		const reopened = new V3FileBackedSessionMappingStore(join(f.root, "sessions", "openwebui-session-mappings.json"));
		try {
			expect(reopened.provisionalOperationScoped(f.prepared, "ingress")).toEqual(operation);
		} finally {
			reopened.close();
		}
	} finally {
		await f.close();
	}
});

test("production branch retains its exact receipt after the effect replaces its predecessor", async () => {
	const controls: { afterFork?: () => void } = {};
	const f = await fixture(controls);
	try {
		const project = { ...f.project, cwd: f.workspace.root, sessionRoot: f.workspace.sessionRoot };
		const runner = createManagedGjcTurnRunner(f.runtime, 2_000);
		await routeGjcTurn({
			project,
			principalId: f.prepared.principalId,
			chatId: f.prepared.chatId,
			userMessageId: "ingress",
			text: "hello",
			preparedManagedAuthority: f.prepared,
			mappings: f.mappings,
			runner,
		});
		const original = f.mappings.getScoped(f.prepared)!;
		const baseline = [...f.calls];
		controls.afterFork = () => {
			f.mappings.setScoped(f.prepared, {
				...original,
				sessionId: "replacement",
				managedAuthority: { ...original.managedAuthority!, sessionId: "replacement" },
			});
		};
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: f.mappings });
		const turn = {
			project,
			prompt: "branch prompt",
			chatId: f.prepared.chatId,
			messageId: "branch",
			userMessageId: "branch",
			userMessageParentId: "ingress",
			continued: true,
			ownerUserId: f.prepared.principalId,
			control: { operation: "branch" as const },
		};
		await expect(gateway.run(turn)).rejects.toThrow("acknowledgement persistence is uncertain");
		const receipt = f.mappings.operationScoped(f.prepared, "branch")!;
		expect(receipt.state).toBe("uncertain");
		expect(receipt.lifecycle?.state).toBe("uncertain");
		expect(receipt.lifecycle?.acknowledged?.sessionId).toBe("forked");
		expect(receipt.lifecycle?.acknowledged?.generation).toBe(2);
		expect(receipt.acknowledgedSuccessor?.sessionId).toBe("forked");
		expect(receipt.lifecycle?.proven).toBeUndefined();
		expect(receipt.result).toBeUndefined();
		expect(f.mappings.getScoped(f.prepared)?.sessionId).toBe("replacement");
		await expect(
			f.runtime.acquireAttachment({ ...f.prepared, sessionId: "forked", generation: 2 }),
		).rejects.toThrow();
		const reopened = new V3FileBackedSessionMappingStore(join(f.root, "sessions", "openwebui-session-mappings.json"));
		try {
			expect(reopened.operationScoped(f.prepared, "branch")).toEqual(receipt);
			const restart = createGjcRoutingLiveGatewayRunner({ turnRunner: runner, mappings: reopened });
			await expect(restart.run(turn)).rejects.toThrow("requires reconciliation");
		} finally {
			reopened.close();
		}
		expect(f.calls).toEqual([...baseline, "fork"]);
	} finally {
		await f.close();
	}
});

test("production staged proof grants cannot authorize active requests or survive lease loss", async () => {
	const f = await fixture();
	try {
		const hash = "a".repeat(64);
		f.mappings.reserveProvisionalOperationScoped(f.prepared, {
			id: "ingress",
			ingressId: "ingress",
			kind: "create",
			chatId: f.prepared.chatId,
			projectId: f.prepared.projectId,
			detail: hash,
		});
		let evidence = createManagedLifecycleEvidence({
			operation: "session.create",
			preparedAuthority: f.prepared,
			target: { kind: "existing_path", path: f.workspace.root },
			payloadHash: hash,
		});
		const record = () => f.mappings.recordLifecycleEvidenceScoped(f.prepared, "ingress", hash, evidence);
		record();
		expect(await f.deps.preparedTenantFence!(f.prepared)).toBe(true);
		evidence = transitionManagedLifecycleEvidence(evidence, "invoking");
		record();
		const key: TenantSessionKey = {
			principalId: f.prepared.principalId,
			projectId: f.prepared.projectId,
			canonicalWorkspace: f.workspace.root,
			chatId: f.prepared.chatId,
			leaseId: f.prepared.leaseId,
			epoch: f.prepared.epoch,
			sessionId: "assigned",
			generation: 1,
		};
		f.attachments.set(key.sessionId, {
			sessionId: key.sessionId,
			generation: key.generation,
			isCurrent: () => true,
		} as router.SessionAttachment);
		evidence = transitionManagedLifecycleEvidence(evidence, "acknowledged_unproven", {
			acknowledged: { ...key, requestKey: f.prepared.requestKey },
		});
		record();
		const operation = { operationId: "ingress", requestKey: "ingress", payloadHash: hash };
		expect(
			await f.deps.tenantFence!(key, { kind: "adoption-proof", ...operation, payloadHash: "b".repeat(64) }),
		).toBe(false);
		expect(
			await f.deps.tenantFence!({ ...key, principalId: "foreign" }, { kind: "adoption-proof", ...operation }),
		).toBe(false);
		const proof = await f.runtime.proveLifecycleTenant(key, operation);
		await expect(f.runtime.acquireAttachment(key)).rejects.toThrow("fence");
		expect(() => f.runtime.prepareFrameSubscription(proof, "turn.prompt", () => {})).toThrow();
		await expect(f.runtime.request(proof, { type: "query_request", query: "session.state" })).rejects.toThrow(
			"fence",
		);
		evidence = transitionManagedLifecycleEvidence(evidence, "active_generation_proven", {
			proven: {
				kind: "managed-generation",
				sessionId: key.sessionId,
				generation: 1,
				leaseId: key.leaseId,
				epoch: key.epoch,
			},
		});
		record();
		expect(await f.runtime.acquireAttachment(key)).toBe(proof);
		await f.lease.release();
		await expect(f.runtime.acquireAttachment(key)).rejects.toThrow("fence");
		expect(f.calls).toEqual([]);
	} finally {
		await f.close();
	}
});

test.each(["intent_prepared", "invoking", "acknowledged_unproven", "active_generation_proven"] as const)(
	"canonical reopen preserves identity and phase-specific lifecycle evidence after %s interruption",
	async phase => {
		const f = await fixture();
		try {
			const hash = "c".repeat(64);
			f.mappings.reserveProvisionalOperationScoped(f.prepared, {
				id: "ingress",
				ingressId: "ingress",
				kind: "create",
				chatId: f.prepared.chatId,
				projectId: f.prepared.projectId,
				detail: hash,
			});
			let evidence = createManagedLifecycleEvidence({
				operation: "session.create",
				preparedAuthority: f.prepared,
				target: { kind: "existing_path", path: f.workspace.root },
				payloadHash: hash,
			});
			const record = () => f.mappings.recordLifecycleEvidenceScoped(f.prepared, "ingress", hash, evidence);
			record();
			if (phase !== "intent_prepared") {
				evidence = transitionManagedLifecycleEvidence(evidence, "invoking");
				record();
			}
			if (phase === "acknowledged_unproven" || phase === "active_generation_proven") {
				evidence = transitionManagedLifecycleEvidence(evidence, "acknowledged_unproven", {
					acknowledged: { ...f.prepared, sessionId: "assigned", generation: 1 },
				});
				record();
			}
			if (phase === "active_generation_proven") {
				evidence = transitionManagedLifecycleEvidence(evidence, phase, {
					proven: {
						kind: "managed-generation",
						sessionId: "assigned",
						generation: 1,
						leaseId: f.prepared.leaseId,
						epoch: f.prepared.epoch,
					},
				});
				record();
			}
			const path = join(f.root, "sessions", "openwebui-session-mappings.json");
			const reopened = new V3FileBackedSessionMappingStore(path);
			try {
				const prior = reopened.provisionalOperationScoped(f.prepared, "ingress")!;
				expect(prior.state).toBe("uncertain");
				expect(prior.lifecycle).toEqual({
					...evidence,
					state: phase === "invoking" || phase === "acknowledged_unproven" ? "uncertain" : phase,
				});
				expect(f.calls).toEqual([]);
				const bytes = await readFile(path, "utf8");
				await expect(
					routeGjcTurn({
						project: { ...f.project, cwd: f.workspace.root },
						principalId: f.prepared.principalId,
						chatId: f.prepared.chatId,
						userMessageId: "ingress",
						text: "changed",
						preparedManagedAuthority: f.prepared,
						mappings: reopened,
						runner: createManagedGjcTurnRunner(f.runtime),
					}),
				).rejects.toThrow("different ingress payload");
				expect(await readFile(path, "utf8")).toBe(bytes);
				expect(f.calls).toEqual([]);
			} finally {
				reopened.close();
			}
		} finally {
			await f.close();
		}
	},
);

test("canonical close binds source proof and atomically retains acknowledgement plus retirement", async () => {
	const f = await fixture();
	try {
		await routeGjcTurn({
			project: { ...f.project, cwd: f.workspace.root },
			principalId: f.prepared.principalId,
			chatId: f.prepared.chatId,
			userMessageId: "ingress",
			text: "hello",
			preparedManagedAuthority: f.prepared,
			mappings: f.mappings,
			runner: createManagedGjcTurnRunner(f.runtime, 2_000),
		});
		const store = createManagedV3GenerationStore(f.mappings);
		const record = (await store.active())[0]!;
		const intent = { key: "retirement", authority: record.authority, requestedAt: Date.now() };
		expect(await store.prepareClose(record, intent)).toBe(true);
		const pending = f.mappings.operationScoped(f.prepared, intent.key)!;
		expect(pending.lifecycle?.state).toBe("closing");
		expect(pending.lifecycle?.sourceProofRef?.operationId).toBe("ingress");
		expect(pending.lifecycle?.closeAcknowledgement).toBeUndefined();
		expect(pending.lifecycle?.acknowledged).toBeUndefined();
		expect(pending.detail).toMatch(/^[a-f0-9]{64}$/);
		await expect(f.runtime.acquireAttachment(record.authority)).rejects.toThrow("fence");
		const path = join(f.root, "sessions", "openwebui-session-mappings.json");
		const bytes = await readFile(path, "utf8");
		const evidence = { source: "session_index", observedIndexSeq: 3, evidenceIndexSeq: 2, event: "session_closed" };
		await expect(store.retire(record, intent, evidence)).rejects.toThrow("acknowledgement");
		expect(await readFile(path, "utf8")).toBe(bytes);
		await expect(store.acknowledge(record, intent, "replacement")).rejects.toThrow("acknowledgement");
		expect(await readFile(path, "utf8")).toBe(bytes);
		await store.acknowledge(record, intent, record.authority.sessionId);
		const acknowledged = f.mappings.operationScoped(f.prepared, intent.key)!;
		expect(acknowledged.lifecycle?.closeAcknowledgement?.sessionId).toBe(record.authority.sessionId);
		await expect(store.retire(record, intent, { ...evidence, event: "replaced" })).rejects.toThrow("retirement");
		expect(f.mappings.operationScoped(f.prepared, intent.key)).toEqual(acknowledged);
		await store.retire(record, intent, evidence);
		const completed = f.mappings.operationScoped(f.prepared, intent.key)!;
		expect(completed.state).toBe("complete");
		expect(completed.lifecycle?.state).toBe("retired");
		expect(completed.result?.correlation?.closeStatus).toBe("closed");
		const reopened = new V3FileBackedSessionMappingStore(path);
		try {
			expect(reopened.operationScoped(f.prepared, intent.key)).toEqual(completed);
			const recovery = createManagedV3GenerationStore(reopened);
			const closing = (await recovery.active())[0]!;
			expect(closing.state).toBe("closing");
			expect((await recovery.pendingRetirement(closing))?.key).toBe(intent.key);
			await recovery.evict(closing, intent);
			expect(reopened.getScoped(f.prepared)).toBeUndefined();
		} finally {
			reopened.close();
		}
	} finally {
		await f.close();
	}
});

test("production reaper uses its fresh purpose lease but cannot invent public exact-close authority", async () => {
	const f = await fixture();
	try {
		await routeGjcTurn({
			project: { ...f.project, cwd: f.workspace.root },
			principalId: f.prepared.principalId,
			chatId: f.prepared.chatId,
			userMessageId: "ingress",
			text: "hello",
			preparedManagedAuthority: f.prepared,
			mappings: f.mappings,
			runner: createManagedGjcTurnRunner(f.runtime, 2_000),
		});
		await f.lease.release();
		const calls = [...f.calls];
		const reaper = managedIdle.createManagedIdleReaper({
			...f.reaperInput,
			pollIntervalMs: undefined,
			idleTimeoutMs: 1,
			now: () => Date.now() + 60_000,
		});
		try {
			await expect(reaper.runOnce()).rejects.toMatchObject({ code: "exact_close_authority_unavailable" });
			const operation = f.mappings.operationsScoped(f.prepared).find(value => value.kind === "close")!;
			expect(operation.state).toBe("uncertain");
			expect(operation.lifecycle?.state).toBe("uncertain");
			expect(operation.lifecycle?.source?.leaseId).toBe(f.prepared.leaseId);
			expect(operation.lifecycle?.closeAcknowledgement).toBeUndefined();
			expect(operation.lifecycle?.retirement).toBeUndefined();
			expect(f.mappings.getScoped(f.prepared)?.sessionId).toBe("assigned");
			expect(f.calls).toEqual(calls);
			await reaper.runOnce();
			expect(f.calls).toEqual(calls);
			const fresh = await f.leases.acquire({
				safeKey: f.workspace.safeKey,
				holderId: "after-reaper",
				operation: "turn",
				leaseDurationMs: 10_000,
			});
			await fresh.release();
		} finally {
			await reaper.stop();
		}
	} finally {
		await f.close();
	}
});
