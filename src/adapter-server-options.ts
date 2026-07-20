import * as path from "node:path";
import { type AdapterConfig, loadAdapterConfig, type ResolvedAdapterConfig } from "./config";
import { createAdapterSessionCloser } from "./adapter-close-options";
import {
	buildOpenWebUIClient,
	buildOpenWebUIEventSink,
	buildOpenWebUIFileContextResolver,
	buildOpenWebUIMessageSink,
	buildOpenWebUIPromptHintClient,
	buildOwnerContext,
} from "./adapter-openwebui-options";
import { assertResolvedAdapterConfig, loadConfiguredProjects, resolveAdapterConfig } from "./adapter-project-options";
import { buildRuntimeHealthChecks } from "./adapter-runtime-health";
import {
	createGjcRoutingLiveGatewayRunner,
	createPublicSdkGjcTurnRunner,
	createPublicSdkModelAttachmentResolver,
	type GjcSessionTurnRunner,
} from "./live/gjc-routing-runner";
import { createProjectionOperationApplier, synthesizeProjectionRows } from "./live/workflow-gate-projection";
import type { GjcCloseReceipt } from "./gjc/turn-runner";
import { FileBackedSessionMappingStore, type SessionMapping, type SessionMappingStore } from "./gjc/session-router";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import {
	createModelReaderFactory,
	type ModelReaderFactory,
	type PublicSdkAttachmentResolver,
	type PublicSdkSessionPortFactory,
	resolveGjcCliPath,
} from "./live/model-reader";
import type { OpenWebUIProjectionRepository } from "./openwebui/client";
import { ProjectLinkService, type SessionCloseResult } from "./projects/link-service";
import { preflightProjectRegistrationDatabase } from "./projects/registration-preflight";
import { auditProjectRegistrations, SqliteProjectRegistrationStore } from "./projects/registration-store";
import { resolveAllowedRoots } from "./security/paths";
import { type AdapterServerHandle, type AdapterServerOptions, startAdapterServer } from "./server";
import { FileBackedOutboxStore, type OutboxStore } from "./state/outbox";
import { reconcilePendingOperations, type ProjectionOperationApplier } from "./state/reconciler";

const SESSION_MAPPING_STORE_FILE = "openwebui-session-mappings.json";
const PROJECTION_OUTBOX_STORE_FILE = "openwebui-projection-outbox.json";

export interface BuildAdapterServerOptionsDependencies {
	readonly turnRunner?: GjcSessionTurnRunner;
	readonly mappings?: SessionMappingStore;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
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
}

interface BuildAdapterServerOptionsBehavior {
	readonly deferOpenWebUIInitialization?: boolean;
}

export async function buildAdapterServerOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
	dependencies: BuildAdapterServerOptionsDependencies = {},
): Promise<AdapterServerOptions> {
	return buildResolvedAdapterServerOptions(loadAdapterConfig(env), dependencies);
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
	const internalStore = dependencies.projectRegistrationStore === undefined;
	const databasePath = path.join(config.statePath, "adapter-state.sqlite");
	if (internalStore) await preflightProjectRegistrationDatabase(databasePath, config.runtimeLocations.protectedProjectPaths);
	const projectStore = dependencies.projectRegistrationStore ?? new SqliteProjectRegistrationStore(databasePath);
	try {
		await auditProjectRegistrations(projectStore, config.runtimeLocations.protectedProjectPaths);
		const allowedRoots = await resolveAllowedRoots(config.allowedProjectRoots);
		const projects = await loadConfiguredProjects(config, allowedRoots);
		const owner = buildOwnerContext(config);
		const mappings = dependencies.mappings ?? new FileBackedSessionMappingStore(path.join(config.sessionRoot, SESSION_MAPPING_STORE_FILE));
		const openWebUIClient = buildOpenWebUIClient(config);
		const projectionRepository = dependencies.projectionRepository ?? openWebUIClient;
		const outbox = dependencies.outbox ?? (projectionRepository === undefined ? undefined : new FileBackedOutboxStore(path.join(config.statePath, PROJECTION_OUTBOX_STORE_FILE)));
		const cliPath = resolveGjcCliPath(config.gjcCommand);
		const turnRunner = dependencies.turnRunner ?? createPublicSdkGjcTurnRunner({
			cliPath,
			runtimeLocations: config.runtimeLocations,
			turnTimeoutMs: config.turnTimeoutMs,
			sessionPortFactory: dependencies.sessionPortFactory,
		});
		const modelReaderFactory = dependencies.modelReaderFactory ?? createModelReaderFactory({
			cliPath,
			runtimeLocations: config.runtimeLocations,
			resolveAttachment: dependencies.resolveModelAttachment ?? createPublicSdkModelAttachmentResolver({
				cliPath,
				cwd: config.runtimeLocations.readerWorkspace,
				childEnvironment: config.runtimeLocations.childEnvironment,
				onProvenClosed: (cwd, sessionId) => turnRunner.discardSessionAttachment?.(cwd, sessionId),
			}),
			sessionPortFactory: dependencies.sessionPortFactory,
		});
		const closeSession = createAdapterSessionCloser(config, cliPath, { ...dependencies, turnRunner }, mappings);
		const projectLinkService = new ProjectLinkService({
			allowedRoots,
			store: projectStore,
			ownerUserId: owner.ownerUserId,
			repository: projectionRepository,
			mappings,
			protectedPaths: config.runtimeLocations.protectedProjectPaths,
			runtimeLocations: config.runtimeLocations,
			...(closeSession === undefined ? {} : { closeSession }),
		});
		const previouslyLinkedProjectIds = new Set(projectLinkService.listLinkedProjects().map(project => project.id));
		await projectLinkService.seedConfiguredProjects(projects);
		if (outbox !== undefined) {
			synthesizeProjectionRows(outbox, mappings, owner.ownerUserId);
			await reconcileOutboxBeforeServing(
				outbox,
				projectionRepository === undefined
					? dependencies.projectionOperationApplier
					: (dependencies.projectionOperationApplier ?? createProjectionOperationApplier(mappings, projectLinkService)),
			);
		}
		const promptHintClient = buildOpenWebUIPromptHintClient(config);
		if (promptHintClient !== undefined && !behavior.deferOpenWebUIInitialization) await promptHintClient.seedGjcPromptHints();
		if (projectionRepository !== undefined && !behavior.deferOpenWebUIInitialization) {
			await projectLinkService.reconcileOpenWebUIFolderLinks({ projectIds: previouslyLinkedProjectIds });
			await projectLinkService.syncLinkedProjects();
		}
		const eventSink = dependencies.eventSink ?? buildOpenWebUIEventSink(openWebUIClient);
		const messageSink = dependencies.messageSink ?? buildOpenWebUIMessageSink(openWebUIClient);
		const fileContextResolver = buildOpenWebUIFileContextResolver(openWebUIClient);
		return {
			host: config.bindHost,
			port: config.bindPort,
			runtimeRoot: config.statePath,
			checks: buildRuntimeHealthChecks(config),
			routes: {
				projects: [...projectLinkService.listLinkedProjects()],
				projectProvider: async () => {
					await projectLinkService.reconcileOpenWebUIFolderLinks();
					return projectLinkService.listLinkedProjects();
				},
				projectLinkService,
				...(projectionRepository === undefined ? {} : { projectContextRepository: projectionRepository }),
				owner,
				runner: createGjcRoutingLiveGatewayRunner({
					turnRunner,
					mappings,
					ownerUserId: owner.ownerUserId,
					modelReaderFactory,
					...(outbox === undefined ? {} : { outbox }),
				}),
				modelReaderFactory,
				mappings,
				closeSession,
				neutralWorkspace: config.runtimeLocations.readerWorkspace,
				requireAdapterApiToken: true,
				...(config.adapterApiToken === undefined ? {} : { adapterApiToken: config.adapterApiToken }),
				...(eventSink === undefined ? {} : { eventSink }),
				...(messageSink === undefined ? {} : { messageSink }),
				...(fileContextResolver === undefined ? {} : { fileContextResolver }),
			},
		};
	} catch (error) {
		if (!internalStore) throw error;
		try {
			projectStore.close();
		} catch (closeError) {
			if (error instanceof Error && error.cause === undefined) Reflect.defineProperty(error, "cause", { value: closeError });
		}
		throw error;
	}
}

export { resolveAdapterConfig };

export async function startAdapterServiceFromEnv(env: Record<string, string | undefined> = process.env): Promise<AdapterServerHandle> {
	return startAdapterServer(await buildAdapterServerOptionsFromEnv(env));
}
async function reconcileOutboxBeforeServing(outbox: OutboxStore, applier: ProjectionOperationApplier | undefined): Promise<void> {
	const hasOutstandingOperations = outbox.listPending().length > 0 || (outbox.listApplying?.().length ?? 0) > 0;
	if (applier === undefined) {
		if (hasOutstandingOperations) throw new Error("Projection outbox has pending work but no ProjectionOperationApplier is configured");
		return;
	}
	const result = await reconcilePendingOperations(outbox, applier);
	if (result.failed.length > 0) {
		throw new Error(`Projection outbox reconciliation failed: ${result.failed.map(operation => operation.operationId).join(", ")}`);
	}
}
