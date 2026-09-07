import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { createAdapterSessionCloser } from "./adapter-close-options";
import { type ActiveManagedV3Runtime, startActiveManagedRuntime } from "./adapter-managed-v3-runtime";
import {
	buildOpenWebUIPrincipalClientFactory,
	buildOpenWebUIPrincipalEventSinkFactory,
	buildOpenWebUIPrincipalFileContextResolverFactory,
	buildOpenWebUIPrincipalMessageSinkFactory,
	buildOpenWebUIPromptHintClient,
	buildOpenWebUIRuntimeAdminClientFactory,
	buildOwnerContext,
} from "./adapter-openwebui-options";
import { assertResolvedAdapterConfig, loadConfiguredProjects, resolveAdapterConfig } from "./adapter-project-options";
import { buildRuntimeHealthChecks, type RuntimeIsolationDiagnostic } from "./adapter-runtime-health";
import { type AdapterConfig, loadAdapterConfig, type ResolvedAdapterConfig } from "./config";
import { SESSION_AUTHORITY_MAPPING_FILE } from "./config-env";
import type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "./gjc/managed-sdk-dependency";
import {
	type ManagedSdkAccess,
	ManagedSdkRuntime,
	type ManagedSdkRuntimeDeps,
	type TenantSessionKey,
} from "./gjc/managed-sdk-runtime";
import { probeSessionAuthorityEpoch } from "./gjc/session-authority-epoch";
import { SESSION_AUTHORITY_V3_EPOCH } from "./gjc/session-authority-v3";
import { readSessionAuthorityV3ActiveMarker } from "./gjc/session-authority-v3-activation";
import { loadGjcSessionFile } from "./gjc/session-loader";
import type { SessionMapping, SessionMappingStore } from "./gjc/session-router";
import { V3FileBackedSessionMappingStore } from "./gjc/session-v3-file-backed-mapping-store";
import type { ManagedPreparedTurnAuthority, ManagedTurnAuthority } from "./gjc/turn-runner";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import { acquireWorkspaceAdmission } from "./live/chat-completions";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import {
	createManagedIdleReaper,
	createManagedV3GenerationStore,
	DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
	type ManagedIdleReaper,
	managedIdleClosePayloadHash,
} from "./live/gjc-managed-idle-reaper";
import { createManagedModelReaderFactory } from "./live/gjc-managed-model-reader";
import { createGjcRoutingLiveGatewayRunner } from "./live/gjc-routing-runner";
import type { ModelReaderFactory } from "./live/model-reader";
import {
	createProjectionOperationApplier,
	type PrincipalProjectionSynchronizerInput,
	type ProjectionSessionSynchronizer,
	synthesizeProjectionRows,
} from "./live/workflow-gate-projection";
import type { OpenWebUIProjectionRepository } from "./openwebui/client";
import type { OpenWebUIPrincipalClient } from "./openwebui/http-client";
import { projectGjcSessionToOpenWebUIChat } from "./projection/chat-tree";
import { importProjectedSession } from "./projection/importer";
import { ProjectLinkService, type SessionCloseResult } from "./projects/link-service";
import { preflightProjectRegistrationDatabase } from "./projects/registration-preflight";
import { auditProjectRegistrations, SqliteProjectRegistrationStore } from "./projects/registration-store";
import { RuntimeSingletonLock } from "./runtime-singleton-lock";
import { resolveAllowedRoots } from "./security/paths";
import { createUserWorkspaceRegistry } from "./security/user-workspace";
import { createWorkspaceCleanupService, type WorkspaceCleanupAuthorityCoordinator } from "./security/workspace-cleanup";
import { createWorkspaceLeaseManager, parseWorkspaceLeaseId, type WorkspaceLease } from "./security/workspace-lease";
import {
	type AdapterServerHandle,
	type AdapterServerOptions,
	type ManagedSdkRuntimeHealth,
	startAdapterServer,
} from "./server";
import { FileBackedOutboxStore, type OutboxStore } from "./state/outbox";
import { type ProjectionOperationApplier, reconcilePendingOperations } from "./state/reconciler";

const WORKSPACE_LEASE_MIN_DURATION_MS = 210_000;
const WORKSPACE_LEASE_HEADROOM_MS = 30_000;

const SESSION_MAPPING_STORE_FILE = SESSION_AUTHORITY_MAPPING_FILE;
const PROJECTION_OUTBOX_STORE_FILE = "openwebui-projection-outbox.json";

export interface BuildAdapterServerOptionsDependencies {
	/** Test seam for the one process-owned managed runtime. */
	readonly managedSdkRuntime?: ManagedSdkRuntimeDependency;
	/** Test seam; retains the production purpose fences while replacing public SDK transports. */
	readonly createManagedSdkRuntime?: (agentDir: string, deps: ManagedSdkRuntimeDeps) => ManagedSdkRuntimeDependency;
	/** Exact managed tenant lease/epoch fence. */
	readonly managedSdkTenantFence?: ManagedSdkTenantFence;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly fileContextResolver?: LiveGatewayFileContextResolver;
	readonly projectionRepository?: OpenWebUIProjectionRepository;
	readonly projectRegistrationStore?: SqliteProjectRegistrationStore;
	readonly outbox?: OutboxStore;
	readonly projectionOperationApplier?: ProjectionOperationApplier;
	/** Retires every principal-owned session authority only after proven close. */
	readonly authorityCoordinator?: WorkspaceCleanupAuthorityCoordinator;
}

interface BuildAdapterServerOptionsBehavior {
	readonly deferOpenWebUIInitialization?: boolean;
}

export async function buildAdapterServerOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
	dependencies: BuildAdapterServerOptionsDependencies = {},
): Promise<AdapterServerOptions> {
	const config = loadAdapterConfig(env);
	return buildResolvedAdapterServerOptions(config, dependencies);
}

export async function buildAdapterServerOptions(
	config: AdapterConfig,
	dependencies: BuildAdapterServerOptionsDependencies = {},
	behavior: BuildAdapterServerOptionsBehavior = {},
): Promise<AdapterServerOptions> {
	return buildResolvedAdapterServerOptions(resolveAdapterConfig(config), dependencies, behavior);
}

export async function buildResolvedAdapterServerOptions(
	config: ResolvedAdapterConfig,
	dependencies: BuildAdapterServerOptionsDependencies = {},
	behavior: BuildAdapterServerOptionsBehavior = {},
): Promise<AdapterServerOptions> {
	assertResolvedAdapterConfig(config);
	const mappingStorePath = path.join(config.sessionRoot, SESSION_MAPPING_STORE_FILE);
	// This is intentionally the first filesystem operation: no state directory,
	// lock, database, store, outbox, or runtime may exist before direct V3 proof.
	assertDirectV3Authority(mappingStorePath);
	const protectedProjectRoots = config.mode === "managed" ? [config.statePath] : [];
	const allowedSessionRoots = config.mode === "managed" ? [config.sessionRoot] : [];
	await mkdir(config.statePath, { recursive: true });
	const lock = await RuntimeSingletonLock.acquire(config.statePath);
	const internalStore = dependencies.projectRegistrationStore === undefined;
	const databasePath = path.join(config.statePath, "adapter-state.sqlite");
	let projectStore: SqliteProjectRegistrationStore | undefined;
	let managedIdleReaper: ManagedIdleReaper | undefined;
	let routingRunner: ReturnType<typeof createGjcRoutingLiveGatewayRunner> | undefined;
	let activeManagedV3Runtime: ActiveManagedV3Runtime | undefined;
	let managedSdkRuntime: ManagedSdkRuntimeDependency | undefined;
	let managedSdkTenantFence: ManagedSdkTenantFence | undefined;
	const managedSdkRuntimeHealth: ManagedSdkRuntimeHealth = {
		phase: "starting",
	};
	let managedSdkRuntimeDisposePromise: Promise<void> | undefined;
	const disposeManagedSdkRuntime = (): Promise<void> => {
		if (managedSdkRuntimeDisposePromise === undefined)
			managedSdkRuntimeDisposePromise = managedSdkRuntime?.dispose() ?? Promise.resolve();
		return managedSdkRuntimeDisposePromise;
	};
	try {
		const isolationDiagnostics: RuntimeIsolationDiagnostic[] = [];
		if (internalStore)
			await preflightProjectRegistrationDatabase(
				databasePath,
				config.runtimeLocations.protectedProjectPaths,
				protectedProjectRoots,
				allowedSessionRoots,
			);
		projectStore = dependencies.projectRegistrationStore ?? new SqliteProjectRegistrationStore(databasePath);
		await auditProjectRegistrations(
			projectStore,
			config.runtimeLocations.protectedProjectPaths,
			protectedProjectRoots,
			allowedSessionRoots,
		);
		const allowedRoots = await resolveAllowedRoots(config.allowedProjectRoots);
		const projects = await loadConfiguredProjects(config, allowedRoots);
		const owner = buildOwnerContext(config);
		const workspaceRegistry = createUserWorkspaceRegistry({ stateRoot: config.statePath });
		const workspaceLeaseManager = createWorkspaceLeaseManager({ stateRoot: config.statePath });
		const workspaceLeaseDurationMs = workspaceLeaseDuration(config.turnTimeoutMs);
		const workspaceLeaseHeartbeatMs = workspaceLeaseHeartbeat(workspaceLeaseDurationMs);
		const previouslyLinkedProjectIdsBeforeConfiguredSeed = new Set(
			projectStore.listLinkedProjects().map(project => project.id),
		);
		const mappings = new V3FileBackedSessionMappingStore(mappingStorePath);
		const retirementLeases = new Map<string, WorkspaceLease>();
		const retirementFence = async (
			key: TenantSessionKey,
			access: Extract<ManagedSdkAccess, { kind: "retirement" }>,
		) => {
			const lease = retirementLeases.get(managedTenantIdentity(key));
			if (lease === undefined) return false;
			const operation = mappings.operationScoped(
				{ principalId: key.principalId, chatId: key.chatId },
				access.operationId,
			);
			if (
				operation?.kind !== "close" ||
				operation.state !== "pending" ||
				operation.lifecycle?.state !== "closing" ||
				operation.lifecycle.sourceProofRef === undefined ||
				operation.lifecycle.requestKey !== access.requestKey ||
				operation.detail !== access.payloadHash ||
				operation.lifecycle.payloadHash !== access.payloadHash ||
				operation.lifecycle.source === undefined ||
				managedTenantIdentity(operation.lifecycle.source) !== managedTenantIdentity(key)
			)
				return false;
			return assertRetirementOperationFence(
				key,
				lease,
				mappings,
				workspaceRegistry,
				projectStore,
				workspaceLeaseManager,
			);
		};
		const liveTenantFence =
			dependencies.managedSdkTenantFence ??
			(key =>
				assertActiveManagedV3TenantFence(key, mappings, workspaceRegistry, projectStore, workspaceLeaseManager));
		const managedRuntimeDeps: ManagedSdkRuntimeDeps = {
			tenantFence: async (key, access) => {
				if (access.kind === "retirement") return retirementFence(key, access);
				if (hasManagedRetirementBarrier(key, mappings)) return false;
				if (access.kind === "active" && (await liveTenantFence(key))) return true;
				return assertStagedManagedTenantFence(
					key,
					access,
					mappings,
					workspaceRegistry,
					projectStore,
					workspaceLeaseManager,
				);
			},
			preparedTenantFence: authority =>
				assertPreparedManagedTenantFence(
					authority,
					workspaceRegistry,
					projectStore,
					workspaceLeaseManager,
					mappings,
				),
		};
		const runtime =
			dependencies.managedSdkRuntime ??
			dependencies.createManagedSdkRuntime?.(config.runtimeLocations.agentDir, managedRuntimeDeps) ??
			new ManagedSdkRuntime({
				agentDir: config.runtimeLocations.agentDir,
				deps: managedRuntimeDeps,
			});
		managedSdkRuntime = runtime;
		activeManagedV3Runtime = await startActiveManagedRuntime({
			mappings,
			runtime: runtime as ManagedSdkRuntime,
			turnTimeoutMs: config.turnTimeoutMs,
			liveTenantFence,
		});
		managedSdkRuntime = activeManagedV3Runtime.runtime;
		managedSdkTenantFence = activeManagedV3Runtime.tenantFence;
		managedSdkRuntimeHealth.phase = "ready";
		const runtimeAdminClientFactory = buildOpenWebUIRuntimeAdminClientFactory(config);
		const principalClientFactory = buildOpenWebUIPrincipalClientFactory(config, workspaceRegistry);
		const runtimeAdminClient =
			owner.ownerUserId.length === 0 || runtimeAdminClientFactory === undefined
				? undefined
				: runtimeAdminClientFactory.create(
						{ userId: owner.ownerUserId, role: "admin" },
						"adapter startup project projection and reconciliation",
					);
		const projectionRepository = dependencies.projectionRepository ?? runtimeAdminClient;
		const outbox =
			dependencies.outbox ??
			(projectionRepository === undefined
				? undefined
				: new FileBackedOutboxStore(path.join(config.statePath, PROJECTION_OUTBOX_STORE_FILE)));
		if (
			activeManagedV3Runtime === undefined ||
			managedSdkRuntime === undefined ||
			managedSdkTenantFence === undefined
		)
			throw new Error("Canonical V3 authority requires active managed runtime dependencies.");
		const turnRunner = activeManagedV3Runtime.runner;
		const modelReaderFactory = createManagedReaderFactory(activeManagedV3Runtime.runtime, config.turnTimeoutMs);
		const closeSession = createAdapterSessionCloser(
			{
				...dependencies,
				...(managedSdkRuntime === undefined ? {} : { managedSdkRuntime }),
				...(managedSdkTenantFence === undefined ? {} : { managedSdkTenantFence }),
			},
			mappings,
		);
		const baseRoutingRunner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			turnTimeoutMs: config.turnTimeoutMs,
			ownerUserId: owner.ownerUserId,
			modelReaderFactory,
			...(outbox === undefined ? {} : { outbox }),
		});
		routingRunner = baseRoutingRunner;
		const workspaceAuthorityCoordinator =
			dependencies.authorityCoordinator ??
			(closeSession === undefined ? undefined : createWorkspaceAuthorityCoordinator(mappings, closeSession));
		if (activeManagedV3Runtime !== undefined) {
			const managedV3Runtime = activeManagedV3Runtime;
			const v3Mappings = mappings;
			if (v3Mappings === undefined) throw new Error("Managed V3 idle reaper requires a session mapping store.");
			const managedRecords = createManagedV3GenerationStore(v3Mappings);
			const retirementOperations = new Map<
				string,
				{ operationId: string; requestKey: string; payloadHash: string }
			>();
			managedIdleReaper = createManagedIdleReaper({
				runtime: {
					closeLifecycleSession: async request => {
						const authority = mappings.getScoped({
							principalId: request.tenant.principalId,
							chatId: request.tenant.chatId,
						})?.managedAuthority;
						if (authority === undefined) throw new Error("Managed retirement lost canonical source authority.");
						const operation = {
							operationId: request.requestKey,
							requestKey: request.requestKey,
							payloadHash: managedIdleClosePayloadHash(authority, request.requestKey),
						};
						retirementOperations.set(managedTenantIdentity(request.tenant), operation);
						return managedV3Runtime.runtime.retireLifecycleSession(request.tenant, request, operation);
					},
					reconcile: () => managedV3Runtime.runtime.reconcile(),
					generationStatus: key => {
						const operation = retirementOperations.get(managedTenantIdentity(key));
						if (operation === undefined) throw new Error("Managed retirement lacks its operation authorization.");
						return managedV3Runtime.runtime.retirementGenerationStatus(key, operation);
					},
				},
				records: managedRecords,
				admission: {
					acquire: async key => {
						try {
							const lease = parseWorkspaceLeaseId(key.leaseId);
							return await acquireWorkspaceAdmission(
								workspaceLeaseManager,
								lease.safeKey,
								workspaceLeaseDurationMs,
								32,
							);
						} catch {
							return undefined;
						}
					},
				},
				leases: {
					acquire: async key => {
						let reference: ReturnType<typeof parseWorkspaceLeaseId>;
						try {
							reference = parseWorkspaceLeaseId(key.leaseId);
						} catch {
							return undefined;
						}
						const workspace = await workspaceRegistry.resolveBySafeKey(reference.safeKey).catch(() => undefined);
						if (
							workspace === undefined ||
							workspace.userId !== key.principalId ||
							path.resolve(workspace.root) !== key.canonicalWorkspace
						)
							return undefined;
						let lease: WorkspaceLease;
						try {
							lease = await workspaceLeaseManager.acquire({
								safeKey: reference.safeKey,
								holderId: `gjc-managed-idle-reaper-${process.pid}-${randomUUID()}`,
								operation: "reaper",
								leaseDurationMs: workspaceLeaseDurationMs,
							});
						} catch {
							return undefined;
						}
						const identity = managedTenantIdentity(key);
						retirementLeases.set(identity, lease);
						return {
							assertFence: async () => {
								if (
									!(await assertRetirementOperationFence(
										key,
										lease,
										mappings,
										workspaceRegistry,
										projectStore,
										workspaceLeaseManager,
									))
								)
									throw new Error("Managed V3 tenant authority fence was lost.");
							},
							release: async () => {
								retirementLeases.delete(identity);
								retirementOperations.delete(identity);
								await lease.release();
							},
						};
					},
				},
				idleTimeoutMs: DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
				pollIntervalMs: DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
			});
		}
		const runner = baseRoutingRunner;
		const closeSessionForRoutes = closeSession;
		const projectLinkService = new ProjectLinkService({
			allowedRoots,
			store: projectStore,
			ownerUserId: owner.ownerUserId,
			repository: projectionRepository,
			mappings,
			protectedPaths: config.runtimeLocations.protectedProjectPaths,
			protectedProjectRoots,
			allowedSessionRoots,
			runtimeLocations: config.runtimeLocations,
			...(closeSessionForRoutes === undefined ? {} : { closeSession: closeSessionForRoutes }),
		});
		const previouslyLinkedProjectIds = previouslyLinkedProjectIdsBeforeConfiguredSeed;
		await projectLinkService.seedConfiguredProjects(projects);
		const projectionSynchronizer: ProjectionSessionSynchronizer = {
			syncLinkedProject: projectLinkService.syncLinkedProject.bind(projectLinkService),
			...(principalClientFactory === undefined
				? {}
				: {
						syncPrincipalProjection: async (input: PrincipalProjectionSynchronizerInput) => {
							const principalClient = await principalClientFactory(
								input.principalId,
								`projection:${input.operation.operationId}`,
							);
							await replayPrincipalProjection(input, principalClient);
						},
					}),
		};
		if (outbox !== undefined) {
			synthesizeProjectionRows(outbox, mappings, owner.ownerUserId, owner.ownerUserId);
			const failedProjectionOperations = await reconcileOutboxBeforeServing(
				outbox,
				projectionRepository === undefined
					? dependencies.projectionOperationApplier
					: (dependencies.projectionOperationApplier ??
							createProjectionOperationApplier(mappings, projectionSynchronizer, owner.ownerUserId)),
			);
			isolationDiagnostics.push({
				name: "openwebui-projection-outbox",
				status: failedProjectionOperations === 0 ? "ok" : "degraded",
				detail:
					failedProjectionOperations === 0
						? "OpenWebUI projection outbox was reconciled."
						: "OpenWebUI projection outbox retained failed operations for retry.",
			});
		}
		const promptHintClient = buildOpenWebUIPromptHintClient(config);
		if (promptHintClient !== undefined && !behavior.deferOpenWebUIInitialization) {
			const promptHintMigration = await promptHintClient.migrateGjcPromptHints();
			if (promptHintMigration.degraded)
				throw new Error("OpenWebUI project-admin prompt hint migration requires operator reconciliation.");
			const promptHintSeed = await promptHintClient.seedGjcPromptHints();
			if (!promptHintSeed.verified) throw new Error("OpenWebUI prompt hint seed readback failed.");
			isolationDiagnostics.push({
				name: "openwebui-prompt-hints",
				status: "ok",
				detail: "OpenWebUI safe workflow prompt hints were verified.",
			});
		}
		let projectProjectionDegraded = false;
		if (projectionRepository !== undefined && !behavior.deferOpenWebUIInitialization) {
			try {
				await projectLinkService.reconcileOpenWebUIFolderLinks({ projectIds: previouslyLinkedProjectIds });
				await projectLinkService.syncLinkedProjects();
				isolationDiagnostics.push({
					name: "openwebui-project-projection",
					status: "ok",
					detail: "OpenWebUI linked-project projection was reconciled.",
				});
			} catch {
				projectProjectionDegraded = true;
				console.error("OpenWebUI linked-project projection reconciliation failed; serving continues.");
				isolationDiagnostics.push({
					name: "openwebui-project-projection",
					status: "degraded",
					detail: "OpenWebUI linked-project projection reconciliation failed; retry occurs on project access.",
				});
			}
		}
		const eventSink = dependencies.eventSink ?? buildOpenWebUIPrincipalEventSinkFactory(config, workspaceRegistry);
		const messageSink =
			dependencies.messageSink ?? buildOpenWebUIPrincipalMessageSinkFactory(config, workspaceRegistry);
		const fileContextResolver =
			dependencies.fileContextResolver ??
			buildOpenWebUIPrincipalFileContextResolverFactory(config, workspaceRegistry);
		const workspaceCleanupService =
			workspaceAuthorityCoordinator === undefined
				? undefined
				: createWorkspaceCleanupService({
						stateRoot: config.statePath,
						registry: workspaceRegistry,
						leaseManager: workspaceLeaseManager,
						authorityCoordinator: workspaceAuthorityCoordinator,
						...(owner.ownerUserId.trim().length === 0 ? {} : { adminPrincipalId: owner.ownerUserId }),
					});
		const shutdownCleanup = async (): Promise<void> => {
			const failures: unknown[] = [];
			try {
				await managedIdleReaper?.stop();
			} catch (error) {
				failures.push(error);
			}
			try {
				await disposeManagedSdkRuntime();
			} catch (error) {
				failures.push(error);
			}
			if (internalStore && failures.length === 0) {
				try {
					projectStore?.close();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) throw new AggregateError(failures, "Adapter shutdown cleanup failed");
		};
		const options = {
			host: config.bindHost,
			port: config.bindPort,
			runtimeRoot: config.statePath,
			runtimeLock: lock,
			turnTimeoutMs: config.turnTimeoutMs,
			checks: [
				...buildRuntimeHealthChecks(config, isolationDiagnostics),
				{
					name: "managed-sdk-runtime",
					get status() {
						return managedSdkRuntimeHealth.phase === "ready" ? "ok" : "degraded";
					},
					get detail() {
						return managedSdkRuntimeHealth.reason ?? `Managed SDK runtime is ${managedSdkRuntimeHealth.phase}.`;
					},
				},
				{
					name: "managed-idle-reaper",
					get status() {
						return managedIdleReaper?.lastPollFailure === undefined ? "ok" : "degraded";
					},
					get detail() {
						return managedIdleReaper?.lastPollFailure === undefined
							? "Managed idle reaper has no recorded polling failure."
							: "Managed idle retirement requires reconciliation after polling failure.";
					},
				},
			],
			managedSdkRuntime: {
				runtime: managedSdkRuntime,
				start: false,
				health: managedSdkRuntimeHealth,
				dispose: disposeManagedSdkRuntime,
			},
			routes: {
				projects: [...projectLinkService.listLinkedProjects()],
				projectProvider: async () => {
					try {
						if (projectProjectionDegraded) {
							await projectLinkService.syncLinkedProjects();
							await projectLinkService.reconcileOpenWebUIFolderLinks();
							projectProjectionDegraded = false;
						} else {
							await projectLinkService.reconcileOpenWebUIFolderLinks();
							await projectLinkService.syncLinkedProjects();
						}
					} catch {
						console.error("OpenWebUI linked-project projection reconciliation failed; serving continues.");
					}
					return projectLinkService.listLinkedProjects();
				},
				projectLinkService,
				...(projectionRepository === undefined ? {} : { projectContextRepository: projectionRepository }),
				owner,
				runner,
				modelReaderFactory,
				mappings,
				closeSession: closeSessionForRoutes,
				neutralWorkspace: config.runtimeLocations.readerWorkspace,
				workspaceRegistry,
				workspaceLeaseManager,
				...(workspaceCleanupService === undefined ? {} : { workspaceCleanupService }),
				workspaceLeaseDurationMs,
				workspaceLeaseHeartbeatMs,
				requireAdapterApiToken: true,
				...(config.adapterApiToken === undefined ? {} : { adapterApiToken: config.adapterApiToken }),
				...(eventSink === undefined ? {} : { eventSink }),
				...(messageSink === undefined ? {} : { messageSink }),
				...(fileContextResolver === undefined ? {} : { fileContextResolver }),
			},
			shutdownCleanup,
		};
		return options;
	} catch (error) {
		let startupError: unknown = error;
		let cleanupFailed = false;
		try {
			await managedIdleReaper?.stop();
		} catch (stopError) {
			cleanupFailed = true;
			startupError = new AggregateError([startupError, stopError], "Adapter initialization cleanup failed");
		}
		try {
			await routingRunner?.stop?.();
		} catch (stopError) {
			cleanupFailed = true;
			startupError = appendStartupCleanupError(startupError, stopError);
		}
		try {
			await disposeManagedSdkRuntime();
		} catch (disposeError) {
			cleanupFailed = true;
			startupError = appendStartupCleanupError(startupError, disposeError);
		}
		if (!cleanupFailed && internalStore && projectStore !== undefined) {
			try {
				projectStore.close();
			} catch (closeError) {
				cleanupFailed = true;
				startupError = appendStartupCleanupError(startupError, closeError);
			}
		}
		if (!cleanupFailed) {
			try {
				await lock.release();
			} catch (releaseError) {
				startupError = appendStartupCleanupError(startupError, releaseError);
			}
		}
		throw startupError;
	}
}

function assertDirectV3Authority(canonicalPath: string): void {
	const authority = probeSessionAuthorityEpoch(canonicalPath);
	if (authority.status !== "v3") throw new Error("Canonical session authority activation is blocked.");
	const marker = readSessionAuthorityV3ActiveMarker(canonicalPath);
	if (marker === undefined) throw new Error("Canonical session authority activation is blocked.");
}

function createManagedReaderFactory(runtime: ManagedSdkRuntime, timeoutMs: number): ModelReaderFactory {
	return async (context, signal) => {
		if (context?.managedAuthority === undefined)
			throw new Error("Managed model catalog access requires explicit tenant or temporary service authority.");
		const authority = { ...context.managedAuthority };
		if (isManagedTurnAuthority(authority)) {
			return createManagedModelReaderFactory({
				runtime,
				timeoutMs,
				resolveAttachment: async () => ({
					tenant: {
						principalId: authority.principalId,
						projectId: authority.projectId,
						canonicalWorkspace: authority.canonicalWorkspace,
						chatId: authority.chatId,
						sessionId: authority.sessionId,
						generation: authority.generation,
						leaseId: authority.leaseId,
						epoch: authority.epoch,
					},
				}),
			})(context, signal);
		}
		if (context?.lease === undefined)
			throw new Error("Managed temporary model catalog access requires a workspace lease fence.");
		const assertFence = context.lease.assertFence.bind(context.lease);
		return createManagedModelReaderFactory({
			runtime,
			timeoutMs,
			temporary: {
				...authority,
				assertFence,
			},
		})(context, signal);
	};
}

function isManagedTurnAuthority(
	authority: ManagedTurnAuthority | ManagedPreparedTurnAuthority,
): authority is ManagedTurnAuthority {
	return (
		"sessionId" in authority &&
		typeof authority.sessionId === "string" &&
		authority.sessionId.length > 0 &&
		typeof authority.generation === "number" &&
		Number.isSafeInteger(authority.generation) &&
		authority.generation > 0
	);
}

async function assertActiveManagedV3TenantFence(
	key: TenantSessionKey,
	mappings: SessionMappingStore | undefined,
	workspaceRegistry: ReturnType<typeof createUserWorkspaceRegistry>,
	projectStore: SqliteProjectRegistrationStore | undefined,
	workspaceLeaseManager: ReturnType<typeof createWorkspaceLeaseManager>,
): Promise<boolean> {
	try {
		if (
			mappings === undefined ||
			key.epoch !== SESSION_AUTHORITY_V3_EPOCH ||
			hasManagedRetirementBarrier(key, mappings)
		)
			return false;
		const lease = parseWorkspaceLeaseId(key.leaseId);
		const workspace = await workspaceRegistry.resolveBySafeKey(lease.safeKey);
		const project = projectStore?.getProject(key.projectId);
		const mapping = mappings?.getScoped({ principalId: key.principalId, chatId: key.chatId });
		const authority = mapping?.managedAuthority;
		if (
			workspace === undefined ||
			workspace.userId !== key.principalId ||
			path.resolve(workspace.root) !== key.canonicalWorkspace ||
			project?.id !== key.projectId ||
			project.status !== "linked" ||
			(mappings !== undefined &&
				(mapping?.principalId !== key.principalId ||
					mapping.projectId !== key.projectId ||
					mapping.sessionId !== key.sessionId ||
					authority === undefined ||
					authority.principalId !== key.principalId ||
					authority.projectId !== key.projectId ||
					authority.canonicalWorkspace !== key.canonicalWorkspace ||
					authority.chatId !== key.chatId ||
					authority.sessionId !== key.sessionId ||
					authority.generation !== key.generation ||
					authority.leaseId !== key.leaseId ||
					authority.epoch !== key.epoch))
		)
			return false;
		await workspaceLeaseManager.assertFence(lease);
		return true;
	} catch {
		return false;
	}
}

async function assertPreparedManagedTenantFence(
	authority: ManagedPreparedTurnAuthority,
	workspaceRegistry: ReturnType<typeof createUserWorkspaceRegistry>,
	projectStore: SqliteProjectRegistrationStore | undefined,
	workspaceLeaseManager: ReturnType<typeof createWorkspaceLeaseManager>,
	mappings: SessionMappingStore,
): Promise<boolean> {
	try {
		const lease = parseWorkspaceLeaseId(authority.leaseId);
		const workspace = await workspaceRegistry.resolveBySafeKey(lease.safeKey);
		const project = projectStore?.getProject(authority.projectId);
		if (
			workspace?.userId !== authority.principalId ||
			path.resolve(workspace.root) !== authority.canonicalWorkspace ||
			project?.status !== "linked" ||
			authority.epoch !== SESSION_AUTHORITY_V3_EPOCH ||
			!authority.chatId ||
			!authority.requestKey
		)
			return false;
		const operations = mappings.lifecycleOperationsScoped({
			principalId: authority.principalId,
			chatId: authority.chatId,
		});
		if (
			!operations.some(operation => {
				const lifecycle = operation.lifecycle;
				return (
					lifecycle !== undefined &&
					operation.state === "pending" &&
					(lifecycle.state === "intent_prepared" || lifecycle.state === "invoking") &&
					lifecycle.requestKey === authority.requestKey &&
					lifecycle.payloadHash === operation.detail &&
					Object.entries(lifecycle.preparedAuthority).every(
						([field, value]) => Reflect.get(authority, field) === value,
					)
				);
			})
		)
			return false;
		await workspaceLeaseManager.assertFence(lease);
		return true;
	} catch {
		return false;
	}
}

async function assertStagedManagedTenantFence(
	key: TenantSessionKey,
	access: ManagedSdkAccess,
	mappings: SessionMappingStore,
	workspaceRegistry: ReturnType<typeof createUserWorkspaceRegistry>,
	projectStore: SqliteProjectRegistrationStore | undefined,
	workspaceLeaseManager: ReturnType<typeof createWorkspaceLeaseManager>,
): Promise<boolean> {
	if (access.kind === "retirement") return false;
	try {
		const scope = { principalId: key.principalId, chatId: key.chatId };
		const operations = mappings.lifecycleOperationsScoped(scope);
		const candidates = operations.filter(operation => {
			const lifecycle = operation.lifecycle;
			if (
				operation.state !== "pending" ||
				lifecycle === undefined ||
				lifecycle.payloadHash !== operation.detail ||
				lifecycle.acknowledged === undefined
			)
				return false;
			if (
				access.kind === "adoption-proof" &&
				(operation.id !== access.operationId ||
					lifecycle.requestKey !== access.requestKey ||
					lifecycle.payloadHash !== access.payloadHash)
			)
				return false;
			if (
				access.kind === "active"
					? lifecycle.state !== "active_generation_proven"
					: lifecycle.state !== "acknowledged_unproven"
			)
				return false;
			return Object.entries(key).every(([field, value]) => Reflect.get(lifecycle.acknowledged!, field) === value);
		});
		if (candidates.length !== 1) return false;
		const lease = parseWorkspaceLeaseId(key.leaseId);
		const workspace = await workspaceRegistry.resolveBySafeKey(lease.safeKey);
		if (
			workspace?.userId !== key.principalId ||
			path.resolve(workspace.root) !== key.canonicalWorkspace ||
			projectStore?.getProject(key.projectId)?.status !== "linked" ||
			key.epoch !== SESSION_AUTHORITY_V3_EPOCH
		)
			return false;
		await workspaceLeaseManager.assertFence(lease);
		return true;
	} catch {
		return false;
	}
}

function managedTenantIdentity(key: TenantSessionKey): string {
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

function hasManagedRetirementBarrier(key: TenantSessionKey, mappings: SessionMappingStore): boolean {
	return mappings.operationsScoped({ principalId: key.principalId, chatId: key.chatId }).some(operation => {
		if (operation.kind !== "close") return false;
		if (operation.state === "pending" || operation.state === "uncertain") return true;
		const retired = operation.result?.managedAuthority;
		return (
			operation.state === "complete" &&
			retired !== undefined &&
			managedTenantIdentity(retired) === managedTenantIdentity(key)
		);
	});
}

async function assertRetirementOperationFence(
	key: TenantSessionKey,
	lease: WorkspaceLease,
	mappings: SessionMappingStore,
	workspaceRegistry: ReturnType<typeof createUserWorkspaceRegistry>,
	projectStore: SqliteProjectRegistrationStore | undefined,
	workspaceLeaseManager: ReturnType<typeof createWorkspaceLeaseManager>,
): Promise<boolean> {
	try {
		const historic = parseWorkspaceLeaseId(key.leaseId);
		if (lease.safeKey !== historic.safeKey || lease.operation !== "reaper") return false;
		const workspace = await workspaceRegistry.resolveBySafeKey(lease.safeKey);
		const authority = mappings.getScoped({ principalId: key.principalId, chatId: key.chatId })?.managedAuthority;
		if (
			workspace?.userId !== key.principalId ||
			path.resolve(workspace.root) !== key.canonicalWorkspace ||
			projectStore?.getProject(key.projectId)?.status !== "linked" ||
			authority === undefined ||
			managedTenantIdentity(authority) !== managedTenantIdentity(key)
		)
			return false;
		await workspaceLeaseManager.assertFence(lease);
		return true;
	} catch {
		return false;
	}
}

async function replayPrincipalProjection(
	input: PrincipalProjectionSynchronizerInput,
	principalClient: OpenWebUIPrincipalClient,
): Promise<void> {
	if (principalClient.principal.role !== "user" || principalClient.userId !== input.principalId)
		throw new Error(`Projection operation ${input.operation.operationId} has an invalid normal principal capability`);
	if (input.ownerUserId !== input.principalId)
		throw new Error(`Projection operation ${input.operation.operationId} has an invalid principal owner binding`);
	// Normal principals cannot create or replace folders/chats (the configured
	// admin token may not impersonate them), and their durable event rows were
	// already delivered live through the proof-bound sink with no message target
	// to replay. Skip both row kinds so startup reconciliation marks them
	// applied instead of retrying unsupported rows forever and leaving the
	// adapter permanently degraded.
	if (input.operation.kind === "session_mapping" || input.operation.kind === "event") return;
	const workspaceRoot = principalClient.context.workspace?.root;
	if (workspaceRoot === undefined)
		throw new Error(`Projection operation ${input.operation.operationId} has no durable principal workspace`);
	const sessionFile = input.mapping.sessionFile;
	if (sessionFile === undefined)
		throw new Error(`Projection operation ${input.operation.operationId} has no durable session file`);
	const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
	const resolvedSessionRoot = path.join(resolvedWorkspaceRoot, ".gjc", "sessions");
	const resolvedSessionFile = path.resolve(sessionFile);
	const relativeSessionFile = path.relative(resolvedSessionRoot, resolvedSessionFile);
	if (
		relativeSessionFile.length === 0 ||
		relativeSessionFile === ".." ||
		relativeSessionFile.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeSessionFile) ||
		!relativeSessionFile.endsWith(".jsonl")
	)
		throw new Error(`Projection operation ${input.operation.operationId} has an invalid principal session scope`);
	const loaded = await loadGjcSessionFile(resolvedSessionFile);
	if (path.resolve(loaded.filePath) !== resolvedSessionFile || loaded.header.id !== input.mapping.sessionId)
		throw new Error(
			`Projection operation ${input.operation.operationId} session identity does not match its mapping`,
		);
	if (path.resolve(loaded.header.cwd) !== resolvedWorkspaceRoot)
		throw new Error(
			`Projection operation ${input.operation.operationId} session cwd is outside its principal workspace`,
		);
	const projectedChat = projectGjcSessionToOpenWebUIChat({
		sessionFile: loaded.filePath,
		header: loaded.header,
		entries: loaded.entries,
	});
	await importProjectedSession({
		repository: principalClient,
		ownerUserId: input.principalId,
		project: {
			id: input.mapping.projectId,
			name: input.mapping.projectId === "openwebui" ? "OpenWebUI" : input.mapping.projectId,
			folderId: `gjc-project-${input.mapping.projectId}`,
		},
		projectedChat: { ...projectedChat, openWebUIChatId: input.mapping.chatId },
	});
}

function workspaceLeaseDuration(turnTimeoutMs: number): number {
	return Math.max(WORKSPACE_LEASE_MIN_DURATION_MS, turnTimeoutMs + WORKSPACE_LEASE_HEADROOM_MS);
}

function workspaceLeaseHeartbeat(durationMs: number): number {
	return Math.max(1, Math.floor(durationMs / 4));
}
function createWorkspaceAuthorityCoordinator(
	mappings: SessionMappingStore,
	closeSession: (
		mapping: SessionMapping,
		ingress: { ingressId: string; ingressHash: string },
	) => Promise<SessionCloseResult>,
): WorkspaceCleanupAuthorityCoordinator {
	return {
		async retirePrincipal({ principalId, assertFence }) {
			for (const mapping of mappings.entriesForPrincipal(principalId)) {
				await assertFence();
				const ingressId = `workspace-cleanup:${principalId}:${mapping.chatId}:${mapping.operationId}`;
				const result = await closeSession(mapping, { ingressId, ingressHash: ingressId });
				if (result.status !== "closed")
					throw new Error(`Workspace cleanup could not close session authority for chat ${mapping.chatId}`);
				await assertFence();
				const scope = { principalId, chatId: mapping.chatId };
				if (isCanonicalManagedV3Mapping(mapping)) {
					const current = mappings.getScoped(scope);
					if (current === undefined || !sameCanonicalManagedV3Authority(current, mapping))
						throw new Error(
							`Workspace cleanup found a changed canonical V3 generation for chat ${mapping.chatId}`,
						);
				}
				mappings.retireScoped(scope);
				await assertFence();
			}
		},
	};
}

function isCanonicalManagedV3Mapping(mapping: SessionMapping): boolean {
	const authority = mapping.managedAuthority as
		| (ManagedTurnAuthority & { readonly authorityEpoch?: unknown })
		| undefined;
	return (
		authority !== undefined &&
		authority.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		authority.chatId === mapping.chatId &&
		authority.projectId === mapping.projectId &&
		authority.sessionId === mapping.sessionId &&
		mapping.principalId === authority.principalId
	);
}

function sameCanonicalManagedV3Authority(left: SessionMapping, right: SessionMapping): boolean {
	const leftAuthority = left.managedAuthority as
		| (ManagedTurnAuthority & { readonly authorityEpoch?: unknown })
		| undefined;
	const rightAuthority = right.managedAuthority as
		| (ManagedTurnAuthority & { readonly authorityEpoch?: unknown })
		| undefined;
	if (
		leftAuthority === undefined ||
		rightAuthority === undefined ||
		leftAuthority.authorityEpoch !== SESSION_AUTHORITY_V3_EPOCH ||
		rightAuthority.authorityEpoch !== SESSION_AUTHORITY_V3_EPOCH
	)
		return false;
	return (
		left.chatId === right.chatId &&
		left.projectId === right.projectId &&
		left.sessionId === right.sessionId &&
		left.principalId === right.principalId &&
		leftAuthority.principalId === rightAuthority.principalId &&
		leftAuthority.projectId === rightAuthority.projectId &&
		leftAuthority.canonicalWorkspace === rightAuthority.canonicalWorkspace &&
		leftAuthority.chatId === rightAuthority.chatId &&
		leftAuthority.sessionId === rightAuthority.sessionId &&
		leftAuthority.generation === rightAuthority.generation &&
		leftAuthority.leaseId === rightAuthority.leaseId &&
		leftAuthority.epoch === rightAuthority.epoch &&
		leftAuthority.requestKey === rightAuthority.requestKey
	);
}

function appendStartupCleanupError(startupError: unknown, cleanupError: unknown): unknown {
	if (!(startupError instanceof Error))
		return new AggregateError([startupError, cleanupError], "Startup failure cleanup failed");
	const causes =
		startupError.cause === undefined
			? [cleanupError]
			: startupError.cause instanceof AggregateError
				? [...startupError.cause.errors, cleanupError]
				: [startupError.cause, cleanupError];
	const cause = causes.length === 1 ? causes[0] : new AggregateError(causes, "Startup failure cleanup failed");
	if (
		Reflect.defineProperty(startupError, "cause", {
			value: cause,
			configurable: true,
			writable: true,
		})
	)
		return startupError;
	return new AggregateError([startupError, cleanupError], "Startup failure cleanup failed");
}

export { resolveAdapterConfig };

export async function startAdapterServiceFromEnv(
	env: Record<string, string | undefined> = process.env,
): Promise<AdapterServerHandle> {
	return startAdapterServer(await buildAdapterServerOptionsFromEnv(env));
}
async function reconcileOutboxBeforeServing(
	outbox: OutboxStore,
	applier: ProjectionOperationApplier | undefined,
): Promise<number> {
	const hasOutstandingOperations = outbox.listPending().length > 0 || (outbox.listApplying?.().length ?? 0) > 0;
	if (applier === undefined) {
		if (hasOutstandingOperations)
			throw new Error("Projection outbox has pending work but no ProjectionOperationApplier is configured");
		return 0;
	}
	const result = await reconcilePendingOperations(outbox, applier);
	if (result.failed.length > 0) {
		console.error(
			`Projection outbox reconciliation retained ${result.failed.length} failed operation(s); serving continues.`,
		);
	}
	return result.failed.length;
}
