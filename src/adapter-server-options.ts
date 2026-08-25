import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { createAdapterSessionCloser } from "./adapter-close-options";
import { activateAdapterSessionAuthorityV3, type ManagedBootstrapAuthorityResolver } from "./adapter-managed-bootstrap";
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
import { resolveLegacySessionAuthoritySourcePaths, SESSION_AUTHORITY_MAPPING_FILE } from "./config-env";
import type { ManagedBootstrapRunnerDependencies, ManagedBootstrapService } from "./gjc/managed-bootstrap";
import { ManagedSdkRuntime, type TenantSessionKey } from "./gjc/managed-sdk-runtime";
import { probeSessionAuthorityEpoch } from "./gjc/session-authority-epoch";
import { preflightSessionAuthorityMigrationCandidates } from "./gjc/session-authority-migration";
import { SESSION_AUTHORITY_V3_EPOCH } from "./gjc/session-authority-v3";
import { readSessionAuthorityV3ActiveMarker } from "./gjc/session-authority-v3-activation";
import { loadGjcSessionFile } from "./gjc/session-loader";
import { FileBackedSessionMappingStore, type SessionMapping, SessionMappingStore } from "./gjc/session-router";
import { V3FileBackedSessionMappingStore } from "./gjc/session-v3-file-backed-mapping-store";
import type { GjcCloseReceipt, ManagedPreparedTurnAuthority, ManagedTurnAuthority } from "./gjc/turn-runner";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import { acquireWorkspaceAdmission } from "./live/chat-completions";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import { createGjcIdleSessionReaper } from "./live/gjc-idle-session-reaper";
import {
	createManagedIdleReaper,
	createManagedV3GenerationStore,
	DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
	type ManagedIdleReaper,
} from "./live/gjc-managed-idle-reaper";
import { createManagedModelReaderFactory } from "./live/gjc-managed-model-reader";
import type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "./live/gjc-routing-lifecycle";
import { createGjcRoutingLiveGatewayRunner, type GjcSessionTurnRunner } from "./live/gjc-routing-runner";
import {
	type ModelReaderFactory,
	type PublicSdkAttachmentResolver,
	type PublicSdkSessionPortFactory,
	resolveGjcCliPath,
} from "./live/model-reader";
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
import { assertProjectsAdmitted, ProjectLinkService, type SessionCloseResult } from "./projects/link-service";
import { preflightProjectRegistrationDatabase } from "./projects/registration-preflight";
import { auditProjectRegistrations, SqliteProjectRegistrationStore } from "./projects/registration-store";
import { RuntimeSingletonLock } from "./runtime-singleton-lock";
import { resolveAllowedRoots } from "./security/paths";
import { createUserWorkspaceRegistry } from "./security/user-workspace";
import { createWorkspaceCleanupService, type WorkspaceCleanupAuthorityCoordinator } from "./security/workspace-cleanup";
import {
	createWorkspaceLeaseManager,
	parseWorkspaceLeaseId,
	type WorkspaceLease,
	workspaceLeaseId,
} from "./security/workspace-lease";
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
	/** Explicit managed authority composition seam. It is fail-closed and never falls back to legacy routing. */
	readonly managedBootstrap?: ManagedBootstrapService;
	/** Factory equivalent of managedBootstrap for tests that need deferred service construction. */
	readonly createManagedBootstrap?: () => ManagedBootstrapService;
	/** Test seam for the one process-owned public-SDK runtime. */
	readonly managedSdkRuntime?: ManagedSdkRuntimeDependency;
	/** Test seam; receives only the explicitly resolved managed agent directory. */
	readonly createManagedSdkRuntime?: (agentDir: string) => ManagedSdkRuntimeDependency;
	/** Slice 3 authority seam; legacy traffic does not invoke it. */
	readonly managedSdkTenantFence?: ManagedSdkTenantFence;
	/** Lets tests inspect unwired ownership deterministically without opening a Router. */
	readonly skipManagedSdkRuntimeStart?: boolean;
	readonly turnRunner?: GjcSessionTurnRunner;
	readonly mappings?: SessionMappingStore;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly fileContextResolver?: LiveGatewayFileContextResolver;
	readonly projectionRepository?: OpenWebUIProjectionRepository;
	readonly projectRegistrationStore?: SqliteProjectRegistrationStore;
	readonly modelReaderFactory?: ModelReaderFactory;
	readonly outbox?: OutboxStore;
	readonly projectionOperationApplier?: ProjectionOperationApplier;
	readonly resolveModelAttachment?: PublicSdkAttachmentResolver;
	readonly sessionPortFactory?: PublicSdkSessionPortFactory;
	/** Must destroy only a pane whose ownership has been proven for this mapping. */
	readonly fallbackCloseSession?: (mapping: SessionMapping, cause: unknown) => Promise<SessionCloseResult>;
	/** Post-ack proof must observe endpoint disappearance and the persisted owned pane/process; it must never kill. */
	readonly proveClosedSession?: (mapping: SessionMapping, receipt: GjcCloseReceipt) => Promise<SessionCloseResult>;
	/** Retires every principal-owned session authority only after proven close. */
	readonly authorityCoordinator?: WorkspaceCleanupAuthorityCoordinator;
}

interface BuildAdapterServerOptionsBehavior {
	readonly deferOpenWebUIInitialization?: boolean;
	readonly sessionAuthorityMigrationSourcePaths?: readonly string[];
}

export async function buildAdapterServerOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
	dependencies: BuildAdapterServerOptionsDependencies = {},
): Promise<AdapterServerOptions> {
	const config = loadAdapterConfig(env);
	return buildResolvedAdapterServerOptions(config, dependencies, {
		sessionAuthorityMigrationSourcePaths: resolveLegacySessionAuthoritySourcePaths(env),
	});
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
	const protectedProjectRoots = config.mode === "managed" ? [config.statePath] : [];
	const allowedSessionRoots = config.mode === "managed" ? [config.sessionRoot] : [];
	await mkdir(config.statePath, { recursive: true });
	const lock = await RuntimeSingletonLock.acquire(config.statePath);
	const internalStore = dependencies.projectRegistrationStore === undefined;
	const databasePath = path.join(config.statePath, "adapter-state.sqlite");
	let projectStore: SqliteProjectRegistrationStore | undefined;
	let idleSessionReaper: ReturnType<typeof createGjcIdleSessionReaper> | undefined;
	let managedIdleReaper: ManagedIdleReaper | undefined;
	let routingRunner: ReturnType<typeof createGjcRoutingLiveGatewayRunner> | undefined;
	let managedBootstrap: ManagedBootstrapService | undefined;
	let managedBootstrapDependencies: ManagedBootstrapRunnerDependencies | undefined;
	let activeManagedV3Runtime: ActiveManagedV3Runtime | undefined;
	const migrationLeases: WorkspaceLease[] = [];
	let migrationLeasesReleased = false;
	const releaseMigrationLeases = async (): Promise<void> => {
		if (migrationLeasesReleased) return;
		migrationLeasesReleased = true;
		const failures: unknown[] = [];
		for (const lease of [...migrationLeases].reverse()) {
			try {
				await lease.release();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Migration workspace lease cleanup failed");
	};
	const skipManagedSdkRuntimeStart = dependencies.skipManagedSdkRuntimeStart ?? true;
	let managedSdkRuntime: ManagedSdkRuntimeDependency | undefined;
	let managedSdkTenantFence: ManagedSdkTenantFence | undefined;
	const managedSdkRuntimeHealth: ManagedSdkRuntimeHealth = {
		phase: skipManagedSdkRuntimeStart ? "not_started" : "starting",
	};
	let managedSdkRuntimeDisposePromise: Promise<void> | undefined;
	const disposeManagedSdkRuntime = (): Promise<void> => {
		if (managedSdkRuntimeDisposePromise === undefined)
			managedSdkRuntimeDisposePromise = managedSdkRuntime?.dispose() ?? Promise.resolve();
		return managedSdkRuntimeDisposePromise;
	};
	let managedBootstrapDisposePromise: Promise<void> | undefined;
	const disposeManagedBootstrap = (): Promise<void> => {
		if (managedBootstrapDisposePromise === undefined)
			managedBootstrapDisposePromise = managedBootstrap?.dispose() ?? Promise.resolve();
		return managedBootstrapDisposePromise;
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
		const mappingStorePath = path.join(config.sessionRoot, SESSION_MAPPING_STORE_FILE);
		const explicitLegacyTestSeam =
			dependencies.turnRunner !== undefined ||
			dependencies.mappings !== undefined ||
			dependencies.managedBootstrap !== undefined ||
			dependencies.createManagedBootstrap !== undefined;
		// An existing deployment does not own its GJC runtime lifecycle, so it may
		// reopen a verified canonical V3 authority but must not migrate V2 in place.
		// Managed deployment owns the process/runtime lock required for the atomic swap.
		const mayActivateManagedV3 = config.mode === "managed" && !explicitLegacyTestSeam;
		const activeV3Marker = readSessionAuthorityV3ActiveMarker(mappingStorePath);
		const authorityEpoch = probeSessionAuthorityEpoch(mappingStorePath);
		if (authorityEpoch.status === "blocked" || (authorityEpoch.status === "v3" && activeV3Marker === undefined))
			throw new Error("Canonical session authority activation is blocked.");
		if (authorityEpoch.status !== "v3" && !mayActivateManagedV3 && !explicitLegacyTestSeam)
			throw new Error(
				"Managed authority is unavailable: active V3 runtime or managed bootstrap dependencies are required.",
			);
		const previouslyLinkedProjectIdsBeforeConfiguredSeed = new Set(
			projectStore.listLinkedProjects().map(project => project.id),
		);
		if (authorityEpoch.status !== "v3" && mayActivateManagedV3 && owner.ownerUserId.length > 0) {
			const sourcePaths =
				behavior.sessionAuthorityMigrationSourcePaths ??
				(config.mode === "managed" ? [path.join("/run/gjc-session", SESSION_MAPPING_STORE_FILE)] : []);
			const migration = preflightSessionAuthorityMigrationCandidates({
				candidateSourcePaths: sourcePaths,
				destinationPath: mappingStorePath,
				stateRoot: config.statePath,
				adminPrincipalId: owner.ownerUserId,
			});
			if (migration.status === "degraded")
				throw new Error(
					`Session authority migration is degraded: ${migration.reason ?? "operator reconciliation is required"}`,
				);
			isolationDiagnostics.push({
				name: "session-authority-migration",
				status: "ok",
				detail: `Session authority migration ${migration.status}.`,
			});
		}
		if (authorityEpoch.status !== "v3" && mayActivateManagedV3) {
			await assertProjectsAdmitted(
				projects,
				config.runtimeLocations.protectedProjectPaths,
				protectedProjectRoots,
				allowedSessionRoots,
			);
			projectStore.seedConfiguredProjects(projects);
		}
		let mappings: SessionMappingStore | undefined;
		if (authorityEpoch.status === "v3") mappings = new V3FileBackedSessionMappingStore(mappingStorePath);
		else if (!mayActivateManagedV3)
			mappings = dependencies.mappings ?? new FileBackedSessionMappingStore(mappingStorePath);
		if (mappings instanceof FileBackedSessionMappingStore && mappings.bootCompaction !== undefined) {
			isolationDiagnostics.push({
				name: "session-authority-compaction",
				status: "ok",
				detail: `Session authority compacted from ${mappings.bootCompaction.beforeBytes} to ${mappings.bootCompaction.afterBytes} bytes.`,
			});
		}
		if (mappings instanceof SessionMappingStore) mappings.setLegacyAdminPrincipalId(owner.ownerUserId);
		if (authorityEpoch.status === "v3") {
			const runtime =
				dependencies.managedSdkRuntime ??
				dependencies.createManagedSdkRuntime?.(config.runtimeLocations.agentDir) ??
				new ManagedSdkRuntime({ agentDir: config.runtimeLocations.agentDir });
			managedSdkRuntime = runtime;
			activeManagedV3Runtime = await startActiveManagedRuntime({
				mappings: mappings as V3FileBackedSessionMappingStore,
				runtime: runtime as ManagedSdkRuntime,
				liveTenantFence: key =>
					assertActiveManagedV3TenantFence(key, mappings, workspaceRegistry, projectStore, workspaceLeaseManager),
			});
			managedSdkRuntime = activeManagedV3Runtime.runtime;
			managedSdkTenantFence = activeManagedV3Runtime.tenantFence;
			managedSdkRuntimeHealth.phase = "ready";
		} else if (mayActivateManagedV3) {
			const runtime =
				dependencies.managedSdkRuntime ??
				dependencies.createManagedSdkRuntime?.(config.runtimeLocations.agentDir) ??
				new ManagedSdkRuntime({ agentDir: config.runtimeLocations.agentDir });
			managedSdkRuntime = runtime;
			const leasesBySafeKey = new Map<string, WorkspaceLease>();
			let activatedMappings: SessionMappingStore | undefined;
			const authority: ManagedBootstrapAuthorityResolver = {
				resolve: async (principalId, projectId) => {
					const workspace = await workspaceRegistry.resolve(principalId);
					const project = projectStore?.getProject(projectId);
					if (
						workspace === undefined ||
						project === undefined ||
						project.status !== "linked" ||
						path.resolve(project.cwd) !== path.resolve(workspace.root)
					)
						return undefined;
					let lease = leasesBySafeKey.get(workspace.safeKey);
					if (lease === undefined) {
						lease = await workspaceLeaseManager.acquire({
							safeKey: workspace.safeKey,
							holderId: `session-authority-migration:${randomUUID()}`,
							operation: "migration",
							leaseDurationMs: workspaceLeaseDurationMs,
						});
						leasesBySafeKey.set(workspace.safeKey, lease);
						migrationLeases.push(lease);
					}
					return {
						project,
						canonicalWorkspace: path.resolve(workspace.root),
						leaseId: workspaceLeaseId(lease),
						epoch: SESSION_AUTHORITY_V3_EPOCH,
						assertFence: async () => {
							await workspaceLeaseManager.assertFence(lease);
						},
					};
				},
			};
			const activated = await activateAdapterSessionAuthorityV3({
				locations: { agentDir: config.runtimeLocations.agentDir, stateRoot: config.statePath },
				configuredOwnerUserId: owner.ownerUserId,
				sourcePath: mappingStorePath,
				runtimeLock: lock,
				authority,
				liveTenantFence: key =>
					assertActiveManagedV3TenantFence(
						key,
						activatedMappings,
						workspaceRegistry,
						projectStore,
						workspaceLeaseManager,
					),
				runtime: runtime as ManagedSdkRuntime,
				lifecycle: runtime as ManagedSdkRuntime,
			});
			if (activated.status !== "activated")
				throw new Error(
					`Canonical session authority activation is blocked: ${
						activated.activation.status === "blocked"
							? (activated.activation.reasons?.join(" ") ?? "migration authority is incomplete")
							: "activation did not produce a managed V3 authority"
					}`,
				);
			mappings = activated.store;
			activatedMappings = mappings;
			activeManagedV3Runtime = activated.managed;
			managedSdkRuntime = activated.managed.runtime;
			managedSdkTenantFence = activated.managed.tenantFence;
			managedSdkRuntimeHealth.phase = "ready";
		} else {
			managedBootstrap = dependencies.managedBootstrap ?? dependencies.createManagedBootstrap?.();
		}
		if (mappings === undefined) throw new Error("Managed V3 activation did not produce a session mapping store.");
		if (managedBootstrap !== undefined) {
			const started = await managedBootstrap.start();
			const dependencies = started.dependencies;
			if (
				started.result.phase !== "active" ||
				!started.result.ready ||
				!started.result.routerAvailable ||
				started.health.phase !== "active" ||
				!started.health.ready ||
				!started.health.routerAvailable ||
				dependencies === undefined
			)
				throw new Error(
					`Managed bootstrap is not ready: ${started.health.reason ?? started.result.reason ?? "activation blocked"}`,
				);
			managedBootstrapDependencies = dependencies;
			managedSdkRuntime = dependencies.runtime;
			managedSdkTenantFence = dependencies.tenantFence;
		} else if (authorityEpoch.status !== "v3" && explicitLegacyTestSeam) {
			managedSdkRuntime =
				dependencies.managedSdkRuntime ??
				(dependencies.createManagedSdkRuntime === undefined
					? skipManagedSdkRuntimeStart
						? undefined
						: new (await import("./gjc/managed-sdk-runtime")).ManagedSdkRuntime({
								agentDir: config.runtimeLocations.agentDir,
							})
					: dependencies.createManagedSdkRuntime(config.runtimeLocations.agentDir));
			managedSdkTenantFence = dependencies.managedSdkTenantFence;
		}
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
		const cliPath = resolveGjcCliPath(config.gjcCommand);
		const turnRunner =
			activeManagedV3Runtime?.runner ?? managedBootstrapDependencies?.runner ?? dependencies.turnRunner;
		const managedModelRuntime = activeManagedV3Runtime?.runtime ?? managedBootstrapDependencies?.runtime;
		const modelReaderFactory =
			managedModelRuntime === undefined
				? dependencies.modelReaderFactory
				: createManagedReaderFactory(managedModelRuntime, config.turnTimeoutMs);
		if (turnRunner === undefined)
			throw new Error(
				"Managed authority is unavailable: active V3 runtime or managed bootstrap dependencies are required.",
			);
		if (
			activeManagedV3Runtime === undefined &&
			managedBootstrapDependencies === undefined &&
			dependencies.turnRunner === undefined
		)
			throw new Error(
				"Managed authority is unavailable: active V3 runtime or managed bootstrap dependencies are required.",
			);
		const closeSession = createAdapterSessionCloser(
			config,
			cliPath,
			{
				...dependencies,
				...(managedSdkRuntime === undefined ? {} : { managedSdkRuntime }),
				...(managedSdkTenantFence === undefined ? {} : { managedSdkTenantFence }),
				turnRunner,
			},
			mappings,
		);
		const baseRoutingRunner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
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
			managedIdleReaper = createManagedIdleReaper({
				runtime: managedV3Runtime.runtime,
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
						return {
							assertFence: async () => {
								await workspaceLeaseManager.assertFence(lease);
								if (!(await managedV3Runtime.tenantFence(key)))
									throw new Error("Managed V3 tenant authority fence was lost.");
							},
							release: () => lease.release(),
						};
					},
				},
				idleTimeoutMs: DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
				pollIntervalMs: DEFAULT_MANAGED_IDLE_TIMEOUT_MS,
			});
		} else if (closeSession !== undefined) {
			idleSessionReaper = createGjcIdleSessionReaper({
				runner: baseRoutingRunner,
				mappings,
				closeSession,
				...(turnRunner.discardSessionAttachment === undefined
					? {}
					: {
							discardSessionAttachment: (cwd, sessionId) =>
								turnRunner.discardSessionAttachment?.(cwd, sessionId),
						}),
				workspaceRegistry,
				workspaceLeaseManager,
				workspaceLeaseDurationMs,
				...(owner.ownerUserId.trim().length === 0 ? {} : { adminPrincipalId: owner.ownerUserId }),
			});
		}
		const runner = idleSessionReaper?.runner ?? baseRoutingRunner;
		const closeSessionForRoutes = idleSessionReaper?.closeSession ?? closeSession;
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
				if (managedBootstrap === undefined) await disposeManagedSdkRuntime();
			} catch (error) {
				failures.push(error);
			}
			try {
				await releaseMigrationLeases();
			} catch (error) {
				failures.push(error);
			}
			if (internalStore) {
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
				...(managedBootstrap === undefined
					? []
					: [
							{
								name: "managed-bootstrap",
								get status() {
									return managedBootstrap?.readiness ? "ok" : "degraded";
								},
								get detail() {
									return managedBootstrap?.health.reason ?? "Managed bootstrap is active.";
								},
							},
						]),
				...(managedBootstrap !== undefined || managedSdkRuntime === undefined
					? []
					: [
							{
								name: "managed-sdk-runtime",
								get status() {
									return managedSdkRuntimeHealth.phase === "ready" ? "ok" : "degraded";
								},
								get detail() {
									return (
										managedSdkRuntimeHealth.reason ??
										`Managed SDK runtime is ${managedSdkRuntimeHealth.phase}.`
									);
								},
							},
						]),
			],
			...(managedBootstrap !== undefined || managedSdkRuntime === undefined
				? {}
				: {
						managedSdkRuntime: {
							runtime: managedSdkRuntime,
							start: !skipManagedSdkRuntimeStart,
							health: managedSdkRuntimeHealth,
							dispose: disposeManagedSdkRuntime,
						},
					}),
			...(managedBootstrap === undefined ? {} : { managedBootstrap }),
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
		try {
			await managedIdleReaper?.stop();
			await (idleSessionReaper?.stop() ?? routingRunner?.stop?.());
		} catch (stopError) {
			startupError = new AggregateError([startupError, stopError], "Adapter initialization cleanup failed");
		}
		try {
			await disposeManagedBootstrap();
		} catch (disposeError) {
			startupError = appendStartupCleanupError(startupError, disposeError);
		}
		try {
			if (managedBootstrap === undefined) await disposeManagedSdkRuntime();
		} catch (disposeError) {
			startupError = appendStartupCleanupError(startupError, disposeError);
		}
		try {
			await releaseMigrationLeases();
		} catch (releaseError) {
			startupError = appendStartupCleanupError(startupError, releaseError);
		}
		if (internalStore && projectStore !== undefined) {
			try {
				projectStore.close();
			} catch (closeError) {
				startupError = appendStartupCleanupError(startupError, closeError);
			}
		}
		try {
			await lock.release();
		} catch (releaseError) {
			startupError = appendStartupCleanupError(startupError, releaseError);
		}
		throw startupError;
	}
}

function createManagedReaderFactory(runtime: ManagedSdkRuntime, timeoutMs: number): ModelReaderFactory {
	return async (context, signal) => {
		const authority = context?.managedAuthority;
		if (authority === undefined)
			throw new Error("Managed model catalog access requires explicit tenant or temporary service authority.");
		if (isManagedTurnAuthority(authority)) {
			return createManagedModelReaderFactory({
				runtime,
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
		return createManagedModelReaderFactory({
			runtime,
			temporary: {
				...authority,
				assertFence: () => context.lease!.assertFence(),
				timeoutMs,
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
				mappings.retireScoped({ principalId, chatId: mapping.chatId });
				await assertFence();
			}
		},
	};
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
