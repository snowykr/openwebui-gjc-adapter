import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { createAdapterSessionCloser } from "./adapter-close-options";
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
import { preflightSessionAuthorityMigrationCandidates } from "./gjc/session-authority-migration";
import { loadGjcSessionFile } from "./gjc/session-loader";
import { FileBackedSessionMappingStore, type SessionMapping, type SessionMappingStore } from "./gjc/session-router";
import type { GjcCloseReceipt } from "./gjc/turn-runner";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import { createGjcIdleSessionReaper } from "./live/gjc-idle-session-reaper";
import {
	createGjcRoutingLiveGatewayRunner,
	createPublicSdkGjcTurnRunner,
	createPublicSdkModelAttachmentResolver,
	type GjcSessionTurnRunner,
} from "./live/gjc-routing-runner";
import {
	createModelReaderFactory,
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
import { ProjectLinkService, type SessionCloseResult } from "./projects/link-service";
import { preflightProjectRegistrationDatabase } from "./projects/registration-preflight";
import { auditProjectRegistrations, SqliteProjectRegistrationStore } from "./projects/registration-store";
import { RuntimeSingletonLock } from "./runtime-singleton-lock";
import { resolveAllowedRoots } from "./security/paths";
import { createUserWorkspaceRegistry } from "./security/user-workspace";
import { createWorkspaceCleanupService, type WorkspaceCleanupAuthorityCoordinator } from "./security/workspace-cleanup";
import { createWorkspaceLeaseManager } from "./security/workspace-lease";
import { type AdapterServerHandle, type AdapterServerOptions, startAdapterServer } from "./server";
import { FileBackedOutboxStore, type OutboxStore } from "./state/outbox";
import { type ProjectionOperationApplier, reconcilePendingOperations } from "./state/reconciler";

const WORKSPACE_LEASE_MIN_DURATION_MS = 210_000;
const WORKSPACE_LEASE_HEADROOM_MS = 30_000;

const SESSION_MAPPING_STORE_FILE = SESSION_AUTHORITY_MAPPING_FILE;
const PROJECTION_OUTBOX_STORE_FILE = "openwebui-projection-outbox.json";

export interface BuildAdapterServerOptionsDependencies {
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
	await mkdir(config.statePath, { recursive: true });
	const lock = await RuntimeSingletonLock.acquire(config.statePath);
	const internalStore = dependencies.projectRegistrationStore === undefined;
	const databasePath = path.join(config.statePath, "adapter-state.sqlite");
	let projectStore: SqliteProjectRegistrationStore | undefined;
	let idleSessionReaper: ReturnType<typeof createGjcIdleSessionReaper> | undefined;
	let routingRunner: ReturnType<typeof createGjcRoutingLiveGatewayRunner> | undefined;
	try {
		const isolationDiagnostics: RuntimeIsolationDiagnostic[] = [];
		if (internalStore)
			await preflightProjectRegistrationDatabase(databasePath, config.runtimeLocations.protectedProjectPaths);
		projectStore = dependencies.projectRegistrationStore ?? new SqliteProjectRegistrationStore(databasePath);
		await auditProjectRegistrations(projectStore, config.runtimeLocations.protectedProjectPaths);
		const allowedRoots = await resolveAllowedRoots(config.allowedProjectRoots);
		const projects = await loadConfiguredProjects(config, allowedRoots);
		const owner = buildOwnerContext(config);
		const workspaceRegistry = createUserWorkspaceRegistry({ stateRoot: config.statePath });
		const workspaceLeaseManager = createWorkspaceLeaseManager({ stateRoot: config.statePath });
		const workspaceLeaseDurationMs = workspaceLeaseDuration(config.turnTimeoutMs);
		const workspaceLeaseHeartbeatMs = workspaceLeaseHeartbeat(workspaceLeaseDurationMs);
		const mappingStorePath = path.join(config.sessionRoot, SESSION_MAPPING_STORE_FILE);
		if (dependencies.mappings === undefined && owner.ownerUserId.length > 0) {
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
		const mappings = dependencies.mappings ?? new FileBackedSessionMappingStore(mappingStorePath);
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
			dependencies.turnRunner ??
			createPublicSdkGjcTurnRunner({
				cliPath,
				runtimeLocations: config.runtimeLocations,
				turnTimeoutMs: config.turnTimeoutMs,
				sessionPortFactory: dependencies.sessionPortFactory,
			});
		const modelReaderFactory =
			dependencies.modelReaderFactory ??
			createModelReaderFactory({
				cliPath,
				runtimeLocations: config.runtimeLocations,
				resolveAttachment:
					dependencies.resolveModelAttachment ??
					createPublicSdkModelAttachmentResolver({
						cliPath,
						cwd: config.runtimeLocations.readerWorkspace,
						childEnvironment: config.runtimeLocations.childEnvironment,
					}),
				sessionPortFactory: dependencies.sessionPortFactory,
			});
		const closeSession = createAdapterSessionCloser(config, cliPath, { ...dependencies, turnRunner }, mappings);
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
		if (closeSession !== undefined) {
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
			runtimeLocations: config.runtimeLocations,
			...(closeSessionForRoutes === undefined ? {} : { closeSession: closeSessionForRoutes }),
		});
		const previouslyLinkedProjectIds = new Set(projectLinkService.listLinkedProjects().map(project => project.id));
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
		const shutdownCleanup = internalStore
			? () => {
					projectStore?.close();
				}
			: undefined;
		const options = {
			host: config.bindHost,
			port: config.bindPort,
			runtimeRoot: config.statePath,
			runtimeLock: lock,
			turnTimeoutMs: config.turnTimeoutMs,
			checks: buildRuntimeHealthChecks(config, isolationDiagnostics),
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
			...(shutdownCleanup === undefined ? {} : { shutdownCleanup }),
		};
		return options;
	} catch (error) {
		let startupError: unknown = error;
		try {
			await (idleSessionReaper?.stop() ?? routingRunner?.stop?.());
		} catch (stopError) {
			startupError = new AggregateError([startupError, stopError], "Adapter initialization cleanup failed");
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
async function replayPrincipalProjection(
	input: PrincipalProjectionSynchronizerInput,
	principalClient: OpenWebUIPrincipalClient,
): Promise<void> {
	if (principalClient.principal.role !== "user" || principalClient.userId !== input.principalId)
		throw new Error(`Projection operation ${input.operation.operationId} has an invalid normal principal capability`);
	if (input.ownerUserId !== input.principalId)
		throw new Error(`Projection operation ${input.operation.operationId} has an invalid principal owner binding`);
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
