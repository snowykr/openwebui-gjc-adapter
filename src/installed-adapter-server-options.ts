import { buildResolvedAdapterServerOptions, resolveAdapterConfig } from "./adapter-server-options";
import { cleanupUnstartedAdapter } from "./cli-startup-cleanup";
import type { AdapterConfig, ResolvedAdapterConfig } from "./config";
import { OpenWebUIPromptHintClient } from "./openwebui/prompt-hints";
import type { AdapterServerOptions } from "./server";

export async function buildInstalledAdapterServerOptions(config: AdapterConfig): Promise<AdapterServerOptions> {
	return buildResolvedInstalledAdapterServerOptions(resolveAdapterConfig(config));
}

export async function buildResolvedInstalledAdapterServerOptions(
	config: ResolvedAdapterConfig,
): Promise<AdapterServerOptions> {
	if (config.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	const options = await buildResolvedAdapterServerOptions(config, {}, { deferOpenWebUIInitialization: true });
	try {
		if (config.adapterToken === undefined || config.readinessToken === undefined || config.mode === undefined) {
			throw new Error("installed adapter configuration is missing runtime credentials or mode");
		}
		const promptHintClient =
			config.openWebUIApiToken === undefined
				? undefined
				: new OpenWebUIPromptHintClient({
						baseUrl: config.openWebUIBaseUrl,
						apiToken: config.openWebUIApiToken,
						installationId: config.installationId,
					});
		const projectLinkService = options.routes?.projectLinkService;
		return {
			...options,
			runtime: {
				adapterToken: config.adapterToken,
				readinessToken: config.readinessToken,
				readiness: {
					openWebUIAuthenticated: false,
					promptHintsSeeded: false,
					mode: config.mode,
					generation: config.installationId,
					reason: "OpenWebUI runtime initialization is pending",
				},
				openWebUIBaseUrl: config.openWebUIBaseUrl,
				openWebUIApiToken: config.openWebUIApiToken,
				initialize: async () => {
					if (promptHintClient !== undefined) {
						const migration = await promptHintClient.migrateGjcPromptHints();
						if (migration.degraded)
							throw new Error("OpenWebUI project-admin prompt hint migration requires operator reconciliation.");
						await promptHintClient.seedGjcPromptHints();
					}
					if (projectLinkService !== undefined) {
						const previouslyLinkedProjectIds = new Set(
							projectLinkService.listLinkedProjects().map(project => project.id),
						);
						await projectLinkService.reconcileOpenWebUIFolderLinks({ projectIds: previouslyLinkedProjectIds });
						await projectLinkService.syncLinkedProjects();
					}
				},
			},
		};
	} catch (error) {
		return cleanupUnstartedAdapter(options, error);
	}
}
