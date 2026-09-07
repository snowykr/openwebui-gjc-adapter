import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import {
	createManagedLifecycleEvidence,
	managedLifecycleEvidenceHash,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import { ManagedOperationDeadline } from "../src/gjc/managed-operation-deadline";
import { ManagedSdkRuntime, type ManagedSdkRuntimeDeps, type TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { routeGjcTurn } from "../src/gjc/session-turn-router";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import * as managedIdle from "../src/live/gjc-managed-idle-reaper";
import { createManagedV3GenerationStore } from "../src/live/gjc-managed-idle-reaper";
import { createManagedGjcTurnRunner } from "../src/live/gjc-managed-turn-runner";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-gateway";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";
import { createUserWorkspaceRegistry } from "../src/security/user-workspace";
import { createWorkspaceLeaseManager, WorkspaceLease, workspaceLeaseId } from "../src/security/workspace-lease";
import { writeDirectV3Authority } from "./cli-fixtures";

async function fixture(
	controls: {
		afterCreate?: () => Promise<void>;
		afterFork?: () => void;
		afterRequestDispatch?: (frame: Record<string, unknown>) => void;
		close?: (
			request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0],
		) => ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>;
		stop?: () => Promise<void>;
		drainTimeoutMs?: number;
		retired?: boolean;
		reaper?: Partial<managedIdle.CreateManagedIdleReaperInput>;
	} = {},
) {
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
	let reaper!: managedIdle.ManagedIdleReaper;
	const createReaper = managedIdle.createManagedIdleReaper;
	const capture = spyOn(managedIdle, "createManagedIdleReaper").mockImplementation(input => {
		reaperInput = { ...input, ...controls.reaper };
		reaper = createReaper(reaperInput);
		return reaper;
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
						...(controls.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: controls.drainTimeoutMs }),
						createLifecycleService: () =>
							({
								async close(
									request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0],
								) {
									calls.push("close");
									if (controls.close !== undefined) return controls.close(request);
									return {
										ok: true,
										operation: "session.close",
										result: { sessionId: request.target.sessionId },
									};
								},
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
										result: {
											sessionId: "assigned",
											endpointGeneration: 1,
											endpointIncarnation: "a".repeat(64),
										},
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
										result: {
											sessionId: "forked",
											endpointGeneration: 2,
											endpointIncarnation: "b".repeat(64),
										},
									};
								},
							}) as unknown as ReturnType<typeof lifecycle.createSessionLifecycleService>,
						createRouter(input) {
							onFrame = input.deps?.onFrame;
							return {
								async start() {},
								async stop() {
									await controls.stop?.();
								},
								async reconcile() {},
								attachment(sessionId: string, generation: number) {
									const attachment = attachments.get(sessionId);
									return attachment?.generation === generation ? attachment : undefined;
								},
								async generationStatus() {
									if (controls.retired && calls.includes("close"))
										return {
											status: "retired",
											evidence: {
												source: "session_index",
												observedIndexSeq: 3,
												evidenceIndexSeq: 2,
												event: "session_closed",
											},
										};
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
									controls.afterRequestDispatch?.(frame);
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
		reaper,
		options,
		modelReaderFactory: options.routes!.modelReaderFactory!,
		async destroy() {
			await options.runtimeLock.release();
			await lease.release();
			projects.close();
			await rm(root, { recursive: true, force: true });
		},
		async close() {
			await options.shutdownCleanup?.();
			await options.runtimeLock.release();
			await lease.release();
			projects.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("temporary catalog creation rejects missing public exact cleanup before borrowing prepared authority", async () => {
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
		const evidence = createManagedLifecycleEvidence({
			operation: "session.create",
			preparedAuthority: f.prepared,
			payloadHash: hash,
			target: { kind: "existing_path", path: f.prepared.canonicalWorkspace },
		});
		f.mappings.recordLifecycleEvidenceScoped(f.prepared, "ingress", hash, evidence);
		f.mappings.recordLifecycleEvidenceScoped(
			f.prepared,
			"ingress",
			hash,
			transitionManagedLifecycleEvidence(evidence, "invoking"),
		);
		expect(await f.deps.preparedTenantFence!(f.prepared)).toBe(true);
		const path = join(f.root, "sessions", "openwebui-session-mappings.json");
		const bytes = await readFile(path);
		let registered = 0;
		await expect(
			f.modelReaderFactory({
				principal: { userId: f.prepared.principalId, role: "user" },
				workspace: f.workspace,
				managedAuthority: f.prepared,
				lease: f.lease,
				registerSettlement: settled => {
					registered += 1;
					void settled.catch(() => undefined);
				},
			}),
		).rejects.toMatchObject({ code: "exact_close_authority_unavailable" });
		expect(registered).toBe(0);
		expect(f.calls).toEqual([]);
		expect((await readFile(path)).equals(bytes)).toBe(true);
	} finally {
		await f.close();
	}
});

test.each(["intent_prepared", "invoking"] as const)(
	"catalog %s reservation cannot authorize generic prepared creation",
	async phase => {
		const f = await fixture();
		try {
			const owner = f.mappings.reserveManagedCatalogScoped(f.prepared, {
				operationId: "catalog-create",
				prepared: f.prepared,
				payloadHash: "c".repeat(64),
			});
			if (phase === "invoking")
				f.mappings.advanceManagedCatalogScoped(
					f.prepared,
					owner,
					managedLifecycleEvidenceHash(owner.lifecycle!),
					transitionManagedLifecycleEvidence(owner.lifecycle!, phase),
				);
			const path = join(f.root, "sessions", "openwebui-session-mappings.json");
			const before = await readFile(path);
			expect(await f.deps.preparedTenantFence!(f.prepared)).toBe(false);
			await expect(
				f.runtime.createPreparedExternalLifecycleSession(
					f.prepared,
					{
						actor: { id: f.prepared.principalId, namespace: "openwebui-gjc-adapter" },
						capability: "session.create",
						requestKey: f.prepared.requestKey,
						target: { kind: "existing_path", path: f.prepared.canonicalWorkspace },
					},
					1_000,
				),
			).rejects.toThrow("Prepared tenant authority fence");
			expect(f.calls).toEqual([]);
			expect((await readFile(path)).equals(before)).toBe(true);
		} finally {
			await f.close();
		}
	},
);

test.each(["child", "lease", "dispatch", "response"] as const)(
	"production catalog purpose access observes %s revocation without active authority",
	async revoke => {
		const controls: { afterRequestDispatch?: (frame: Record<string, unknown>) => void } = {};
		const f = await fixture(controls);
		try {
			const path = join(f.root, "sessions", "openwebui-session-mappings.json");
			const stale = new V3FileBackedSessionMappingStore(path);
			try {
				const original = f.mappings.reserveManagedCatalogScoped(f.prepared, {
					operationId: "catalog-create",
					prepared: f.prepared,
					payloadHash: "c".repeat(64),
				});
				let current = f.mappings.advanceManagedCatalogScoped(
					f.prepared,
					original,
					managedLifecycleEvidenceHash(original.lifecycle!),
					transitionManagedLifecycleEvidence(original.lifecycle!, "invoking"),
				);
				const acknowledged = { ...f.prepared, sessionId: "catalog-session", generation: 7 };
				current = f.mappings.advanceManagedCatalogScoped(
					f.prepared,
					original,
					managedLifecycleEvidenceHash(current.lifecycle!),
					transitionManagedLifecycleEvidence(current.lifecycle!, "acknowledged_unproven", {
						acknowledged,
						endpointReceipt: {
							sessionId: acknowledged.sessionId,
							endpointGeneration: acknowledged.generation,
							endpointIncarnation: "c".repeat(64),
						},
					}),
				);
				const { requestKey: _requestKey, ...key } = acknowledged;
				f.attachments.set(key.sessionId, {
					sessionId: key.sessionId,
					generation: key.generation,
					isCurrent: () => true,
				} as router.SessionAttachment);
				const proofRef = { original, expectedLifecycleHash: managedLifecycleEvidenceHash(current.lifecycle!) };
				expect(await f.deps.catalogFence!(proofRef, key, { kind: "proof" })).toBe(true);
				expect(await f.deps.catalogFence!(proofRef, key, { kind: "query", name: "session.state" })).toBe(false);
				expect(
					await f.deps.catalogFence!({ ...proofRef, expectedLifecycleHash: "0".repeat(64) }, key, {
						kind: "proof",
					}),
				).toBe(false);
				expect(await f.deps.catalogFence!(proofRef, { ...key, principalId: "foreign" }, { kind: "proof" })).toBe(
					false,
				);
				const proof = await f.runtime.proveCatalogSession(proofRef, key, 1_000);
				expect(proof.kind).toBe("managed-generation");
				expect("isCurrent" in proof).toBe(false);
				current = f.mappings.advanceManagedCatalogScoped(
					f.prepared,
					original,
					managedLifecycleEvidenceHash(current.lifecycle!),
					transitionManagedLifecycleEvidence(current.lifecycle!, "active_generation_proven", { proven: proof }),
				);
				const queryRef = { original, expectedLifecycleHash: managedLifecycleEvidenceHash(current.lifecycle!) };
				expect(await f.deps.tenantFence!(key, { kind: "active" })).toBe(false);
				await expect(f.runtime.acquireAttachment(key, 1_000)).rejects.toThrow("fence");
				await f.runtime.queryCatalog(queryRef, key, "models.list/current", { timeoutMs: 1_000 });
				expect(f.calls).toEqual(["models.list/current"]);
				const reserveCleanup = () => {
					stale.reserveManagedCatalogCleanupScoped(f.prepared, original, queryRef.expectedLifecycleHash, {
						operationId: "catalog-close",
						requestKey: "catalog-close-key",
						payloadHash: "d".repeat(64),
					});
				};
				if (revoke === "dispatch") {
					await expect(
						f.runtime.queryCatalog(queryRef, key, "models.list/current", {
							timeoutMs: 1_000,
							beforeDispatch: reserveCleanup,
						}),
					).rejects.toThrow("fence");
				} else if (revoke === "response") {
					controls.afterRequestDispatch = reserveCleanup;
					await expect(
						f.runtime.queryCatalog(queryRef, key, "models.list/current", { timeoutMs: 1_000 }),
					).rejects.toThrow("fence");
					controls.afterRequestDispatch = undefined;
				} else if (revoke === "child") {
					reserveCleanup();
					expect(f.mappings.provisionalOperationScoped(f.prepared, original.id)!.cleanup).toBeUndefined();
				} else await f.lease.release();
				expect(f.deps.catalogFenceSync!(queryRef, key, { kind: "query", name: "models.list/current" })).toBe(false);
				expect(await f.deps.catalogFence!(queryRef, key, { kind: "query", name: "models.list/current" })).toBe(
					false,
				);
				await expect(
					f.runtime.queryCatalog(queryRef, key, "models.list/current", { timeoutMs: 1_000 }),
				).rejects.toThrow("fence");
				expect(f.calls).toEqual(
					revoke === "response" ? ["models.list/current", "models.list/current"] : ["models.list/current"],
				);
			} finally {
				stale.close();
			}
		} finally {
			await f.close();
		}
	},
);

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
			endpointReceipt: { sessionId: "assigned", endpointGeneration: 1, endpointIncarnation: "a".repeat(64) },
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
		expect(operation.lifecycle?.endpointReceipt).toEqual({
			sessionId: "assigned",
			endpointGeneration: 1,
			endpointIncarnation: "a".repeat(64),
		});
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
		await expect(gateway.run(turn)).rejects.toThrow("proof admission was denied");
		const receipt = f.mappings.operationScoped(f.prepared, "branch")!;
		expect(receipt.state).toBe("uncertain");
		expect(receipt.lifecycle?.state).toBe("uncertain");
		expect(receipt.lifecycle?.acknowledged?.sessionId).toBe("forked");
		expect(receipt.lifecycle?.acknowledged?.generation).toBe(2);
		expect(receipt.lifecycle?.endpointReceipt).toEqual({
			sessionId: "forked",
			endpointGeneration: 2,
			endpointIncarnation: "b".repeat(64),
		});
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

test.each(["preaborted", "dispatched"] as const)(
	"production control %s cancellation has only one dispatch-aware owner",
	async phase => {
		const controls: { afterRequestDispatch?: (frame: Record<string, unknown>) => void } = {};
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
			const baseline = [...f.calls];
			const cancellation = new AbortController();
			let abortObserved!: () => void;
			const abort = new Promise<void>(resolve => {
				abortObserved = resolve;
			});
			controls.afterRequestDispatch = frame => {
				if (frame.operation === "turn.follow_up") cancellation.abort();
				if (frame.operation === "turn.abort") abortObserved();
			};
			if (phase === "preaborted") cancellation.abort();
			const outerCancel = spyOn(runner, "cancelTurn");
			try {
				const gateway = createGjcRoutingLiveGatewayRunner({
					turnRunner: runner,
					mappings: f.mappings,
					turnTimeoutMs: 2_000,
				});
				await expect(
					gateway.run({
						project,
						prompt: "follow up",
						chatId: f.prepared.chatId,
						messageId: "control",
						userMessageId: "control",
						userMessageParentId: "ingress",
						continued: true,
						ownerUserId: f.prepared.principalId,
						control: { operation: "follow_up" },
						signal: cancellation.signal,
					}),
				).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
				if (phase === "dispatched") {
					let timer!: ReturnType<typeof setTimeout>;
					try {
						await Promise.race([
							abort,
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => reject(new Error("abort not observed")), 2_000);
							}),
						]);
					} finally {
						clearTimeout(timer);
					}
				}
				expect(outerCancel).not.toHaveBeenCalled();
				expect(f.calls.slice(baseline.length).filter(call => call === "turn.abort")).toHaveLength(
					phase === "dispatched" ? 1 : 0,
				);
				expect(f.mappings.operationScoped(f.prepared, "control")?.state).toBe(
					phase === "dispatched" ? "uncertain" : undefined,
				);
				if (phase === "preaborted") expect(f.calls).toEqual(baseline);
			} finally {
				outerCancel.mockRestore();
			}
		} finally {
			await f.close();
		}
	},
);

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
		const prepared = await store.prepareClose(record, intent);
		expect(prepared).toMatchObject({
			key: intent.key,
			target: { sessionId: record.authority.sessionId, endpointGeneration: 1, endpointIncarnation: "a".repeat(64) },
		});
		if (prepared === false) throw new Error("Expected exact prepared close");
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
		await expect(store.acknowledge(record, prepared, "replacement")).rejects.toThrow("acknowledgement");
		expect(await readFile(path, "utf8")).toBe(bytes);
		await store.acknowledge(record, prepared, record.authority.sessionId);
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

test("production reaper forwards its reserved exact receipt under a fresh purpose lease and cannot retire without proof", async () => {
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
			await expect(reaper.runOnce()).rejects.toThrow("generation status is current");
			const operation = f.mappings.operationsScoped(f.prepared).find(value => value.kind === "close")!;
			expect(operation.state).toBe("uncertain");
			expect(operation.lifecycle?.state).toBe("uncertain");
			expect(operation.lifecycle?.source?.leaseId).toBe(f.prepared.leaseId);
			expect(operation.lifecycle?.target).toEqual({
				sessionId: "assigned",
				endpointGeneration: 1,
				endpointIncarnation: "a".repeat(64),
			});
			expect(operation.lifecycle?.closeAcknowledgement).toMatchObject({ sessionId: "assigned", generation: 1 });
			expect(operation.lifecycle?.retirement).toBeUndefined();
			expect(f.mappings.getScoped(f.prepared)?.sessionId).toBe("assigned");
			expect(f.calls).toEqual([...calls, "close"]);
			await reaper.runOnce();
			expect(f.calls).toEqual([...calls, "close"]);
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

test("production reaper retires only after exact original acknowledgement and positive retirement", async () => {
	const f = await fixture({
		retired: true,
		reaper: { pollIntervalMs: undefined, idleTimeoutMs: 1, now: () => Date.now() + 60_000 },
	});
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
		const originalEvict = f.reaperInput.records.evict.bind(f.reaperInput.records);
		const evict = spyOn(f.reaperInput.records, "evict");
		evict.mockImplementation(async (record, intent) => {
			expect(f.mappings.operationScoped(f.prepared, intent.key)).toMatchObject({
				state: "complete",
				lifecycle: {
					state: "retired",
					closeAcknowledgement: { sessionId: "assigned", generation: 1 },
					retirement: { evidence: { event: "session_closed" } },
				},
			});
			await originalEvict(record, intent);
		});
		try {
			await f.reaper.runOnce();
			expect(evict).toHaveBeenCalledTimes(1);
			expect(f.calls.filter(call => call === "close")).toHaveLength(1);
			expect(f.mappings.getScoped(f.prepared)).toBeUndefined();
			const next = await f.leases.acquire({
				safeKey: f.workspace.safeKey,
				holderId: "next",
				operation: "turn",
				leaseDurationMs: 10_000,
			});
			await next.release();
		} finally {
			evict.mockRestore();
		}
	} finally {
		await f.close();
	}
});

test.each(["target", "operation", "observer"] as const)(
	"production bridge rejects changed %s before runtime close",
	async mutation => {
		const f = await fixture();
		let lease: managedIdle.ManagedIdleLease | undefined;
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
			const record = (await f.reaperInput.records.active())[0]!;
			lease = await f.reaperInput.leases.acquire(record.authority);
			expect(lease).toBeDefined();
			const prepared = await f.reaperInput.records.prepareClose(record, {
				key: "prepared-close",
				authority: record.authority,
				requestedAt: Date.now(),
			});
			if (prepared === false) throw new Error("Expected exact prepared close");
			const close = spyOn(f.runtime, "retireLifecycleSession");
			try {
				const request = {
					tenant: record.authority,
					actor: prepared.original.lifecycle!.actor,
					capability: "session.close" as const,
					requestKey: prepared.operation.requestKey,
					target:
						mutation === "target" ? { ...prepared.target, endpointIncarnation: "b".repeat(64) } : prepared.target,
				};
				const operation =
					mutation === "operation" ? { ...prepared.operation, payloadHash: "c".repeat(64) } : prepared.operation;
				await expect(
					f.reaperInput.runtime.closeLifecycleSession(
						request,
						operation,
						mutation === "observer" ? (undefined as never) : async () => undefined,
					),
				).rejects.toThrow("original canonical projection");
				expect(close).not.toHaveBeenCalled();
				expect(f.calls).not.toContain("close");
				expect(f.mappings.operationScoped(f.prepared, prepared.key)).toEqual(prepared.original);
			} finally {
				close.mockRestore();
			}
		} finally {
			await lease?.release();
			await f.close();
		}
	},
);

function controlledReaperHeartbeat() {
	const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
	const cleared = Promise.withResolvers<void>();
	let tick: (() => void) | undefined;
	const set = globalThis.setInterval;
	const clear = globalThis.clearInterval;
	const installed = spyOn(globalThis, "setInterval").mockImplementation(((
		handler: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		if (timeout !== 52_500) return Reflect.apply(set, globalThis, [handler, timeout, ...args]);
		if (typeof handler !== "function") throw new Error("Expected reaper heartbeat callback");
		if (tick !== undefined) throw new Error("Unexpected second reaper heartbeat");
		tick = () => handler(...args);
		return timer;
	}) as typeof setInterval);
	const removed = spyOn(globalThis, "clearInterval").mockImplementation(value => {
		if (value === timer) cleared.resolve();
		else Reflect.apply(clear, globalThis, [value]);
	});
	return {
		cleared: cleared.promise,
		tick() {
			if (tick === undefined) throw new Error("Reaper heartbeat was not installed");
			tick();
		},
		restore() {
			installed.mockRestore();
			removed.mockRestore();
		},
	};
}

test("production heartbeat renews the same lease during raw close and observer, then drains queued renewal before release", async () => {
	const closeEntered = Promise.withResolvers<void>();
	const closeGate = Promise.withResolvers<void>();
	const observerEntered = Promise.withResolvers<void>();
	const observerGate = Promise.withResolvers<void>();
	const uncertain = Promise.withResolvers<void>();
	const renewalGate = Promise.withResolvers<void>();
	const f = await fixture({
		retired: true,
		reaper: { pollIntervalMs: undefined, idleTimeoutMs: 1, closeTimeoutMs: 100, now: () => Date.now() + 60_000 },
		close: async request => {
			closeEntered.resolve();
			await closeGate.promise;
			return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
		},
	});
	const heartbeat = controlledReaperHeartbeat();
	const renew = WorkspaceLease.prototype.renew;
	const renewed: WorkspaceLease[] = [];
	const renewal = spyOn(WorkspaceLease.prototype, "renew").mockImplementation(async function (
		this: WorkspaceLease,
		duration,
	) {
		renewed.push(this);
		if (renewed.length === 2) await renewalGate.promise;
		return renew.call(this, duration);
	});
	const release = WorkspaceLease.prototype.release;
	const releases: WorkspaceLease[] = [];
	const released = spyOn(WorkspaceLease.prototype, "release").mockImplementation(async function (
		this: WorkspaceLease,
	) {
		if (this.operation === "reaper") releases.push(this);
		await release.call(this);
	});
	const mark = f.reaperInput.records.markUncertain.bind(f.reaperInput.records);
	const marked = spyOn(f.reaperInput.records, "markUncertain").mockImplementation(async (...args) => {
		await mark(...args);
		uncertain.resolve();
	});
	const acknowledge = f.reaperInput.records.acknowledge.bind(f.reaperInput.records);
	const observed = spyOn(f.reaperInput.records, "acknowledge").mockImplementation(async (...args) => {
		observerEntered.resolve();
		await observerGate.promise;
		await acknowledge(...args);
	});
	let scan: Promise<unknown> | undefined;
	let stopping: Promise<unknown> | undefined;
	let replacement: WorkspaceLease | undefined;
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
		let settled = false;
		scan = f.reaper
			.runOnce()
			.catch(error => error)
			.finally(() => {
				settled = true;
			});
		await closeEntered.promise;
		await uncertain.promise;
		heartbeat.tick();
		expect(renewal).toHaveBeenCalledTimes(1);
		const held = renewed[0]!;
		const identity = held.reference;
		const before = held.leaseExpiresAt;
		expect(await renewal.mock.results[0]!.value).toBe(held);
		expect(held.reference).toEqual(identity);
		expect(held.leaseExpiresAt).toBeGreaterThan(before);
		expect(settled).toBe(false);
		expect(observed).not.toHaveBeenCalled();
		closeGate.resolve();
		await observerEntered.promise;
		heartbeat.tick();
		heartbeat.tick();
		expect(renewal).toHaveBeenCalledTimes(2);
		expect(renewed[1]).toBe(held);
		expect(renewal.mock.calls).toEqual([[210_000], [210_000]]);
		expect(releases).toEqual([]);
		stopping = f.reaper.stop().catch(error => error);
		observerGate.resolve();
		await heartbeat.cleared;
		heartbeat.tick();
		expect(renewal).toHaveBeenCalledTimes(2);
		expect(settled).toBe(false);
		expect(releases).toEqual([]);
		await expect(
			f.leases.acquire({
				safeKey: f.workspace.safeKey,
				holderId: "blocked-renewal",
				operation: "turn",
				leaseDurationMs: 10_000,
			}),
		).rejects.toThrow();
		renewalGate.resolve();
		const error = await scan;
		expect(error).toMatchObject({ code: "timeout" });
		expect(await stopping).toBe(error);
		expect(await renewal.mock.results[1]!.value).toBe(held);
		expect(releases).toEqual([held]);
		expect(held.reference).toEqual(identity);
		heartbeat.tick();
		expect(renewal).toHaveBeenCalledTimes(2);
		const close = f.mappings.operationsScoped(f.prepared).find(operation => operation.kind === "close")!;
		expect(close.lifecycle).toMatchObject({
			state: "uncertain",
			closeAcknowledgement: { sessionId: "assigned", generation: 1 },
		});
		expect(close.lifecycle?.retirement).toBeUndefined();
		expect(f.calls.filter(call => call === "close")).toHaveLength(1);
		replacement = await f.leases.acquire({
			safeKey: f.workspace.safeKey,
			holderId: "replacement",
			operation: "turn",
			leaseDurationMs: 10_000,
		});
		const replacementBytes = await readFile(replacement.lockPath, "utf8");
		heartbeat.tick();
		expect(renewal).toHaveBeenCalledTimes(2);
		await expect(f.reaper.stop()).rejects.toBe(error);
		await expect(f.options.shutdownCleanup!()).rejects.toBeInstanceOf(AggregateError);
		expect(await readFile(replacement.lockPath, "utf8")).toBe(replacementBytes);
		expect(releases).toEqual([held]);
		await replacement.assertFence();
	} finally {
		closeGate.resolve();
		observerGate.resolve();
		renewalGate.resolve();
		await scan;
		await stopping;
		await replacement?.release();
		marked.mockRestore();
		observed.mockRestore();
		renewal.mockRestore();
		released.mockRestore();
		heartbeat.restore();
		await f.runtime.dispose().catch(() => undefined);
		await f.destroy();
	}
});

test.each(["renewal rejection", "replacement"] as const)(
	"production reaper retains sticky %s failure and never releases or mutates a replacement owner",
	async phase => {
		const closeEntered = Promise.withResolvers<void>();
		const closeGate = Promise.withResolvers<void>();
		const uncertain = Promise.withResolvers<void>();
		const renewalGate = Promise.withResolvers<void>();
		const failure = new Error("reaper renewal failed");
		const f = await fixture({
			retired: true,
			reaper: { pollIntervalMs: undefined, idleTimeoutMs: 1, closeTimeoutMs: 100, now: () => Date.now() + 60_000 },
			close: async request => {
				closeEntered.resolve();
				await closeGate.promise;
				return { ok: true, operation: "session.close", result: { sessionId: request.target.sessionId } };
			},
		});
		const heartbeat = controlledReaperHeartbeat();
		const renew = WorkspaceLease.prototype.renew;
		let held: WorkspaceLease | undefined;
		const renewal = spyOn(WorkspaceLease.prototype, "renew").mockImplementation(async function (
			this: WorkspaceLease,
			duration,
		) {
			held = this;
			await renewalGate.promise;
			if (phase === "renewal rejection") throw failure;
			return renew.call(this, duration);
		});
		const release = WorkspaceLease.prototype.release;
		let releases = 0;
		const released = spyOn(WorkspaceLease.prototype, "release").mockImplementation(async function (
			this: WorkspaceLease,
		) {
			if (this.operation === "reaper") releases += 1;
			await release.call(this);
		});
		const mark = f.reaperInput.records.markUncertain.bind(f.reaperInput.records);
		const marked = spyOn(f.reaperInput.records, "markUncertain").mockImplementation(async (...args) => {
			await mark(...args);
			uncertain.resolve();
		});
		let scan: Promise<unknown> | undefined;
		let stopping: Promise<unknown> | undefined;
		let replacement: WorkspaceLease | undefined;
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
			let settled = false;
			scan = f.reaper
				.runOnce()
				.catch(error => error)
				.finally(() => {
					settled = true;
				});
			await closeEntered.promise;
			await uncertain.promise;
			heartbeat.tick();
			heartbeat.tick();
			expect(renewal).toHaveBeenCalledTimes(1);
			expect(held?.operation).toBe("reaper");
			let replacementBytes: string | undefined;
			if (phase === "replacement") {
				// Simulate an external owner turnover before the queued renewal executes.
				await release.call(held!);
				replacement = await f.leases.acquire({
					safeKey: f.workspace.safeKey,
					holderId: "replacement",
					operation: "turn",
					leaseDurationMs: 10_000,
				});
				replacementBytes = await readFile(replacement.lockPath, "utf8");
			}
			stopping = f.reaper.stop().catch(error => error);
			closeGate.resolve();
			await heartbeat.cleared;
			expect(settled).toBe(false);
			expect(releases).toBe(0);
			renewalGate.resolve();
			const renewalError = await (renewal.mock.results[0]!.value as Promise<WorkspaceLease>).catch(error => error);
			if (phase === "renewal rejection") expect(renewalError).toBe(failure);
			else expect(renewalError.message).toContain("released workspace lease");
			const error = await scan;
			expect(error).toBeInstanceOf(AggregateError);
			if (!(error instanceof AggregateError)) throw new Error("Expected retained reaper failure");
			expect(error.errors).toContain(renewalError);
			expect(error.errors[0]).toMatchObject({ code: "timeout" });
			expect(await stopping).toBe(error);
			await expect(f.reaper.stop()).rejects.toBe(error);
			heartbeat.tick();
			expect(renewal).toHaveBeenCalledTimes(1);
			expect(releases).toBe(0);
			await expect(f.options.managedSdkRuntime!.dispose()).rejects.toMatchObject({ errors: [error, renewalError] });
			await expect(f.options.shutdownCleanup!()).rejects.toBeInstanceOf(AggregateError);
			await expect(RuntimeSingletonLock.acquire(join(f.root, "state"))).rejects.toThrow("already owned");
			if (replacement !== undefined) {
				expect(await readFile(replacement.lockPath, "utf8")).toBe(replacementBytes!);
				await replacement.assertFence();
			} else {
				expect(held!.released).toBe(false);
				await expect(
					f.leases.acquire({
						safeKey: f.workspace.safeKey,
						holderId: "blocked",
						operation: "turn",
						leaseDurationMs: 10_000,
					}),
				).rejects.toThrow();
			}
			const close = f.mappings.operationsScoped(f.prepared).find(operation => operation.kind === "close")!;
			expect(close.lifecycle).toMatchObject({
				state: "uncertain",
				closeAcknowledgement: { sessionId: "assigned", generation: 1 },
			});
			expect(close.lifecycle?.retirement).toBeUndefined();
			expect(f.calls.filter(call => call === "close")).toHaveLength(1);
		} finally {
			closeGate.resolve();
			renewalGate.resolve();
			await scan;
			await stopping;
			await replacement?.release();
			marked.mockRestore();
			renewal.mockRestore();
			released.mockRestore();
			heartbeat.restore();
			await f.runtime.dispose().catch(() => undefined);
			await f.destroy();
		}
	},
);

test.each(["success", "observer failure", "target mutation"] as const)(
	"production reaper retains actual late close ownership through %s and concurrent disposal",
	async phase => {
		let admittedDeadline: ManagedOperationDeadline | undefined;
		const closeEntered = Promise.withResolvers<void>();
		const closeGate = Promise.withResolvers<void>();
		const observerEntered = Promise.withResolvers<void>();
		const observerGate = Promise.withResolvers<void>();
		const uncertain = Promise.withResolvers<void>();
		const failure = new Error("original acknowledgement write failed");
		const f = await fixture({
			retired: true,
			drainTimeoutMs: 200,
			reaper: {
				pollIntervalMs: undefined,
				idleTimeoutMs: 1,
				closeTimeoutMs: 10_000,
				now: () => Date.now() + 60_000,
			},
			close: async request => {
				expect(request.target).toEqual({
					sessionId: "assigned",
					endpointGeneration: 1,
					endpointIncarnation: "a".repeat(64),
				});
				closeEntered.resolve();
				await closeGate.promise;
				return { ok: true, operation: "session.close", result: { sessionId: "assigned" } };
			},
			stop: async () => {
				closeGate.resolve();
			},
		});
		const mark = f.reaperInput.records.markUncertain.bind(f.reaperInput.records);
		const markSpy = spyOn(f.reaperInput.records, "markUncertain").mockImplementation(async (...args) => {
			await mark(...args);
			uncertain.resolve();
		});
		const acknowledge = f.reaperInput.records.acknowledge.bind(f.reaperInput.records);
		let prepared: managedIdle.ManagedIdlePreparedClose | undefined;
		const ackSpy = spyOn(f.reaperInput.records, "acknowledge").mockImplementation(
			async (record, original, sessionId) => {
				prepared = original;
				observerEntered.resolve();
				await observerGate.promise;
				if (phase === "observer failure") throw failure;
				await acknowledge(record, original, sessionId);
			},
		);
		const operation = f.mappings.operationScoped.bind(f.mappings);
		let mutateTarget = false;
		const operationSpy = spyOn(f.mappings, "operationScoped").mockImplementation((scope, id) => {
			const current = operation(scope, id);
			return mutateTarget && current?.kind === "close" && current.lifecycle !== undefined
				? {
						...current,
						lifecycle: {
							...current.lifecycle,
							target: { ...current.lifecycle.target, endpointIncarnation: "b".repeat(64) },
						},
					}
				: current;
		});
		let scan: Promise<unknown> | undefined;
		let shutdown: Promise<unknown> | undefined;
		const reconcile = spyOn(f.runtime, "reconcile");
		const status = spyOn(f.runtime, "retirementGenerationStatus");
		let deadlineSpy: ReturnType<typeof spyOn> | undefined;
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
			reconcile.mockClear();
			const remaining = ManagedOperationDeadline.prototype.remaining;
			deadlineSpy = spyOn(ManagedOperationDeadline.prototype, "remaining").mockImplementation(function (
				this: ManagedOperationDeadline,
			) {
				admittedDeadline ??= this;
				return remaining.call(this);
			});
			let settled = false;
			scan = f.reaper
				.runOnce()
				.catch(error => error)
				.finally(() => {
					settled = true;
				});
			await closeEntered.promise;
			if (admittedDeadline === undefined) throw new Error("Expected the original reaper deadline.");
			admittedDeadline.fail(
				Object.assign(new Error("Injected original post-dispatch timeout"), { code: "timeout" }),
			);
			await uncertain.promise;
			expect(settled).toBe(false);
			expect(ackSpy).not.toHaveBeenCalled();
			await expect(
				f.leases.acquire({
					safeKey: f.workspace.safeKey,
					holderId: "blocked",
					operation: "turn",
					leaseDurationMs: 10_000,
				}),
			).rejects.toThrow();
			await f.reaper.runOnce();
			expect(f.calls.filter(call => call === "close")).toHaveLength(1);
			mutateTarget = phase === "target mutation";
			let shutdownSettled = false;
			shutdown = Promise.resolve(f.options.shutdownCleanup!())
				.then(
					() => undefined,
					error => error,
				)
				.finally(() => {
					shutdownSettled = true;
				});
			await observerEntered.promise;
			expect(settled).toBe(false);
			expect(shutdownSettled).toBe(false);
			expect(prepared?.target.endpointIncarnation).toBe("a".repeat(64));
			await expect(RuntimeSingletonLock.acquire(join(f.root, "state"))).rejects.toThrow("already owned");
			await expect(
				f.leases.acquire({
					safeKey: f.workspace.safeKey,
					holderId: "observer-blocked",
					operation: "turn",
					leaseDurationMs: 10_000,
				}),
			).rejects.toThrow();
			observerGate.resolve();
			const error = await scan;
			if (phase === "success") expect(error).toMatchObject({ code: "timeout" });
			else {
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof AggregateError)) throw new Error("Expected retained cleanup failures");
				if (phase === "observer failure") expect(error.errors).toContain(failure);
				else
					expect(error.errors.some((entry: Error) => entry.message.includes("canonical reservation"))).toBe(true);
			}
			expect(await shutdown).toBeInstanceOf(AggregateError);
			mutateTarget = false;
			const reserved = f.mappings.operationsScoped(f.prepared).find(value => value.kind === "close")!;
			expect(reserved.state).toBe("uncertain");
			expect(reserved.lifecycle?.state).toBe("uncertain");
			expect(reserved.lifecycle?.retirement).toBeUndefined();
			expect(reserved.result).toBeUndefined();
			expect(reconcile).not.toHaveBeenCalled();
			expect(status).not.toHaveBeenCalled();
			expect(f.mappings.getScoped(f.prepared)?.sessionId).toBe("assigned");
			if (phase === "success") {
				expect(reserved.lifecycle?.closeAcknowledgement).toMatchObject({ sessionId: "assigned", generation: 1 });
				const fresh = await f.leases.acquire({
					safeKey: f.workspace.safeKey,
					holderId: "settled",
					operation: "turn",
					leaseDurationMs: 10_000,
				});
				await fresh.release();
			} else {
				expect(reserved.lifecycle?.closeAcknowledgement).toBeUndefined();
				await expect(
					f.leases.acquire({
						safeKey: f.workspace.safeKey,
						holderId: "failed",
						operation: "turn",
						leaseDurationMs: 10_000,
					}),
				).rejects.toThrow();
			}
			await expect(RuntimeSingletonLock.acquire(join(f.root, "state"))).rejects.toThrow("already owned");
		} finally {
			closeGate.resolve();
			observerGate.resolve();
			await scan;
			await shutdown;
			markSpy.mockRestore();
			ackSpy.mockRestore();
			operationSpy.mockRestore();
			reconcile.mockRestore();
			status.mockRestore();
			deadlineSpy?.mockRestore();
			await f.runtime.dispose().catch(() => undefined);
			await f.destroy();
		}
	},
);
