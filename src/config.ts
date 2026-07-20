import { DEFAULT_TURN_TIMEOUT_MS } from "./config-env";
import {
	DEFAULT_EXISTING_PROJECT_ROOT,
	defaultConfigPath,
	type InstalledConfig,
	type InstalledMode,
	readInstalledConfig,
} from "./configure/private-config";
import { resolveGjcRuntimeLocations } from "./configure/runtime-locations";
import type { GjcRuntimeLocations } from "./contracts";

export { DEFAULT_TURN_TIMEOUT_MS, loadAdapterConfig } from "./config-env";

export {
	GjcRuntimeLocationError,
	type ResolveGjcRuntimeLocationsInput,
	resolveGjcRuntimeLocations,
} from "./configure/runtime-locations";
export type { InstalledConfig, InstalledMode };
export { defaultConfigPath, readInstalledConfig };

import { REQUIRED_OPENWEBUI_HEADER_NAMES, type RequiredOpenWebUIHeaderName } from "./contracts";

export interface AdapterConfig {
	bindHost: string;
	bindPort: number;
	adapterApiToken?: string;
	openWebUIBaseUrl: string;
	openWebUIApiToken?: string;
	adapterToken?: string;
	readinessToken?: string;
	mode?: InstalledMode;
	installationId?: string;
	openWebUIAdminEmail?: string;
	openWebUIAdminPassword?: string;
	ownerUserId?: string;
	statePath: string;
	gjcCommand: string;
	readonly gjcConfigDirName?: string;
	readonly gjcCodingAgentDir?: string;
	readonly runtimeLocations?: GjcRuntimeLocations;
	turnTimeoutMs: number;
	sessionRoot: string;
	allowedProjectRoots: string[];
	artifactBaseUrl?: string;
	projects: AdapterProjectConfig[];
}

export interface ResolvedAdapterConfig extends AdapterConfig {
	readonly gjcConfigDirName: string;
	readonly gjcCodingAgentDir: string;
	readonly runtimeLocations: GjcRuntimeLocations;
}

export interface AdapterProjectConfig {
	readonly cwd: string;
	readonly name?: string;
	readonly openWebUIFolderId?: string;
	readonly sessionRoot?: string;
}

export interface StartupDiagnostic {
	status: "ok" | "degraded";
	missingAuth: boolean;
	missingAdapterApiToken: boolean;
	missingAllowedProjectRoots: boolean;
	expectedHeaderNames: RequiredOpenWebUIHeaderName[];
	messages: string[];
}

export function buildStartupDiagnostics(config: AdapterConfig): StartupDiagnostic {
	const missingAuth = config.openWebUIApiToken === undefined;
	const missingAdapterApiToken = config.adapterApiToken === undefined;
	const missingAllowedProjectRoots = config.allowedProjectRoots.length === 0;
	const messages: string[] = [];
	if (missingAdapterApiToken) {
		messages.push(
			"GJC_OPENWEBUI_ADAPTER_API_TOKEN is not set; inbound OpenAI-compatible calls are not authenticated.",
		);
	}
	if (missingAuth) {
		messages.push("GJC_OPENWEBUI_API_TOKEN is not set; OpenWebUI API calls are not authenticated.");
	}
	if (missingAllowedProjectRoots) {
		messages.push("No allowed project roots are configured.");
	}
	return {
		status: missingAdapterApiToken || missingAuth || missingAllowedProjectRoots ? "degraded" : "ok",
		missingAuth,
		missingAdapterApiToken,
		missingAllowedProjectRoots,
		expectedHeaderNames: [...REQUIRED_OPENWEBUI_HEADER_NAMES],
		messages,
	};
}
export function loadInstalledAdapterConfig(path?: string): ResolvedAdapterConfig {
	const installed = readInstalledConfig(path);
	const managed = installed.mode === "managed";
	const projectRoot = managed ? "/workspace" : (installed.projectRoot ?? DEFAULT_EXISTING_PROJECT_ROOT);
	const runtimeLocations = resolveGjcRuntimeLocations(
		managed ? { mode: "managed" } : { mode: "existing", installedConfig: installed },
	);
	return Object.freeze({
		bindHost: installed.bindHost,
		bindPort: installed.bindPort,
		openWebUIBaseUrl: managed ? "http://openwebui:8080" : installed.openWebUIApiUrl,
		openWebUIApiToken: installed.openWebUIApiToken,
		adapterApiToken: installed.adapterToken,
		adapterToken: installed.adapterToken,
		readinessToken: installed.readinessToken,
		mode: installed.mode,
		installationId: installed.installationId,
		ownerUserId: installed.ownerUserId,
		statePath: managed ? "/var/lib/gjc" : ".gjc/openwebui-adapter",
		gjcCommand: "gjc",
		gjcConfigDirName: runtimeLocations.childEnvironment.GJC_CONFIG_DIR,
		gjcCodingAgentDir: runtimeLocations.agentDir,
		runtimeLocations,
		turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
		sessionRoot: managed ? "/run/gjc-session" : `${projectRoot}/.gjc/sessions`,
		allowedProjectRoots: managed ? [projectRoot, "/run/gjc-session"] : [projectRoot],
		projects: [
			{
				cwd: projectRoot,
				name: "default",
				sessionRoot: managed ? "/run/gjc-session" : `${projectRoot}/.gjc/sessions`,
			},
		],
	});
}
