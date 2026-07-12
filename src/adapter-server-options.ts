import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AdapterConfig, buildStartupDiagnostics, loadAdapterConfig, type ResolvedAdapterConfig } from "./config";
import { resolveGjcRuntimeLocations } from "./configure/runtime-locations";
import { createResolvedGjcRpcTurnRunner, type GjcTurnRunner } from "./gjc/rpc-runner";
import { FileBackedSessionMappingStore, type SessionMappingStore } from "./gjc/session-router";
import type { AdapterHealthCheck } from "./health";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import { createGjcRoutingLiveGatewayRunner } from "./live/gjc-routing-runner";
import { buildOpenWebUIAuthStartupDiagnostic, type OpenWebUIOwnerContext } from "./openwebui/auth";
import { OpenWebUIHttpClient, type OpenWebUIProjectionRepository } from "./openwebui/client";
import { createOpenWebUIFileContextResolver } from "./openwebui/file-context-resolver";
import { OpenWebUIPromptHintClient } from "./openwebui/prompt-hints";
import { ProjectLinkService } from "./projects/link-service";
import { SqliteProjectRegistrationStore } from "./projects/registration-store";
import { disambiguateRegisteredProjects, type RegisteredProject, registerProjectDirectory } from "./projects/registry";
import { type AllowedRoot, resolveAllowedRoots } from "./security/paths";
import { type AdapterServerHandle, type AdapterServerOptions, startAdapterServer } from "./server";

const SESSION_MAPPING_STORE_FILE = "openwebui-session-mappings.json";

export interface BuildAdapterServerOptionsDependencies {
	readonly turnRunner?: GjcTurnRunner;
	readonly mappings?: SessionMappingStore;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly projectionRepository?: OpenWebUIProjectionRepository;
	readonly projectRegistrationStore?: SqliteProjectRegistrationStore;
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
	const allowedRoots = await resolveAllowedRoots(config.allowedProjectRoots);
	const projects = await loadConfiguredProjects(config, allowedRoots);
	const owner = buildOwnerContext(config);
	const turnRunner =
		dependencies.turnRunner ??
		createResolvedGjcRpcTurnRunner({
			cliPath: resolveGjcCliPath(config.gjcCommand),
			turnTimeoutMs: config.turnTimeoutMs,
			runtimeLocations: config.runtimeLocations,
		});
	const mappings = dependencies.mappings ?? new FileBackedSessionMappingStore(buildSessionMappingStorePath(config));
	const openWebUIClient = buildOpenWebUIClient(config);
	const promptHintClient = buildOpenWebUIPromptHintClient(config);
	if (promptHintClient !== undefined && !behavior.deferOpenWebUIInitialization) {
		await promptHintClient.seedGjcPromptHints();
	}
	const projectionRepository = dependencies.projectionRepository ?? openWebUIClient;
	const projectStore =
		dependencies.projectRegistrationStore ??
		new SqliteProjectRegistrationStore(buildProjectRegistrationStorePath(config));
	const projectLinkService = new ProjectLinkService({
		allowedRoots,
		store: projectStore,
		ownerUserId: owner.ownerUserId,
		repository: projectionRepository,
		mappings,
	});
	const previouslyLinkedProjectIds = new Set(projectLinkService.listLinkedProjects().map(project => project.id));
	projectLinkService.seedConfiguredProjects(projects);
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
			runner: createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, ownerUserId: owner.ownerUserId }),
			requireAdapterApiToken: true,
			...(config.adapterApiToken === undefined ? {} : { adapterApiToken: config.adapterApiToken }),
			...(eventSink === undefined ? {} : { eventSink }),
			...(messageSink === undefined ? {} : { messageSink }),
			...(fileContextResolver === undefined ? {} : { fileContextResolver }),
		},
	};
}

export function resolveAdapterConfig(config: AdapterConfig): ResolvedAdapterConfig {
	if (isResolvedAdapterConfig(config)) return config;
	const runtimeLocations = resolveGjcRuntimeLocations(
		config.mode === "managed" ? { mode: "managed" } : { mode: "existing", installedConfig: config },
	);
	return Object.freeze({
		...config,
		gjcConfigDirName: runtimeLocations.childEnvironment.GJC_CONFIG_DIR,
		gjcCodingAgentDir: runtimeLocations.agentDir,
		runtimeLocations,
	});
}

function assertResolvedAdapterConfig(config: AdapterConfig): asserts config is ResolvedAdapterConfig {
	if (!isResolvedAdapterConfig(config)) throw new TypeError("resolved runtime locations are required");
}

function isResolvedAdapterConfig(config: AdapterConfig): config is ResolvedAdapterConfig {
	return (
		typeof config.gjcConfigDirName === "string" &&
		typeof config.gjcCodingAgentDir === "string" &&
		config.runtimeLocations !== undefined
	);
}

export async function startAdapterServiceFromEnv(
	env: Record<string, string | undefined> = process.env,
): Promise<AdapterServerHandle> {
	return startAdapterServer(await buildAdapterServerOptionsFromEnv(env));
}

async function loadConfiguredProjects(
	config: AdapterConfig,
	allowedRoots: readonly AllowedRoot[],
): Promise<RegisteredProject[]> {
	const projects: RegisteredProject[] = [];
	for (const project of config.projects) {
		projects.push(
			await registerProjectDirectory(
				{
					cwd: project.cwd,
					name: project.name,
					openWebUIFolderId: project.openWebUIFolderId,
					sessionRoot: project.sessionRoot,
				},
				allowedRoots,
			),
		);
	}
	return [...disambiguateRegisteredProjects(projects)];
}

function buildRuntimeHealthChecks(config: AdapterConfig): AdapterHealthCheck[] {
	const configDiagnostic = buildStartupDiagnostics(config);
	const authDiagnostic = buildOpenWebUIAuthStartupDiagnostic(config);
	return [
		{
			name: "config",
			status: configDiagnostic.status,
			detail: configDiagnostic.messages.join(" "),
		},
		{
			name: "openwebui-auth",
			status: authDiagnostic.status,
			detail: authDiagnostic.messages.join(" "),
		},
		{
			name: "gjc-live-runner",
			status: "ok",
			detail: "GJC live runner is wired to the RPC turn runner.",
		},
	];
}

function buildSessionMappingStorePath(config: AdapterConfig): string {
	return path.join(config.sessionRoot, SESSION_MAPPING_STORE_FILE);
}

function buildProjectRegistrationStorePath(config: AdapterConfig): string {
	return path.join(config.statePath, "adapter-state.sqlite");
}

function buildOpenWebUIClient(config: AdapterConfig): OpenWebUIHttpClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIHttpClient({ baseUrl: config.openWebUIBaseUrl, apiToken: config.openWebUIApiToken });
}

function buildOpenWebUIPromptHintClient(config: AdapterConfig): OpenWebUIPromptHintClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIPromptHintClient({ baseUrl: config.openWebUIBaseUrl, apiToken: config.openWebUIApiToken });
}

function buildOpenWebUIEventSink(client: OpenWebUIHttpClient | undefined): LiveGatewayEventSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		for (const event of input.events) {
			await client.postMessageEvent({ chatId: input.chatId, messageId: input.messageId, event });
		}
	};
}

function buildOpenWebUIMessageSink(client: OpenWebUIHttpClient | undefined): LiveGatewayMessageSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		await client.updateMessageContent({
			chatId: input.chatId,
			messageId: input.messageId,
			content: input.content,
		});
	};
}

function buildOpenWebUIFileContextResolver(
	client: OpenWebUIHttpClient | undefined,
): LiveGatewayFileContextResolver | undefined {
	if (client === undefined) return undefined;
	return createOpenWebUIFileContextResolver(client);
}

function resolveGjcCliPath(gjcCommand: string): string {
	if (gjcCommand === "gjc") {
		return fileURLToPath(import.meta.resolve("@gajae-code/coding-agent/cli"));
	}
	return gjcCommand;
}

function buildOwnerContext(config: AdapterConfig): OpenWebUIOwnerContext {
	return {
		ownerUserId: config.ownerUserId ?? "",
		singleOwnerLocalMode: false,
	};
}
