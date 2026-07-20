import type { AdapterConfig, ResolvedAdapterConfig } from "./config";
import { resolveGjcRuntimeLocations } from "./configure/runtime-locations";
import type { RegisteredProject } from "./projects/registry";
import { disambiguateRegisteredProjects, registerProjectDirectory } from "./projects/registry";
import type { AllowedRoot } from "./security/paths";

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

export function assertResolvedAdapterConfig(config: AdapterConfig): asserts config is ResolvedAdapterConfig {
	if (!isResolvedAdapterConfig(config)) throw new TypeError("resolved runtime locations are required");
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

export { loadConfiguredProjects };

function isResolvedAdapterConfig(config: AdapterConfig): config is ResolvedAdapterConfig {
	return (
		typeof config.gjcConfigDirName === "string" &&
		typeof config.gjcCodingAgentDir === "string" &&
		config.runtimeLocations !== undefined
	);
}
