import type { AdapterProjectConfig, ResolvedAdapterConfig } from "./config";
import { resolveGjcRuntimeLocations } from "./configure/runtime-locations";

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_BIND_PORT = 8765;
const DEFAULT_OPENWEBUI_BASE_URL = "http://localhost:8080";
const DEFAULT_STATE_PATH = ".gjc/openwebui-adapter";
const DEFAULT_GJC_COMMAND = "gjc";
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;

function requireNonEmptyString(value: string | undefined, fallback: string, name: string): string {
	const candidate = value ?? fallback;
	const trimmed = candidate.trim();
	if (trimmed.length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return trimmed;
}

function parsePort(value: string | undefined): number {
	if (value === undefined || value.trim().length === 0) {
		return DEFAULT_BIND_PORT;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		throw new Error("GJC_OPENWEBUI_BIND_PORT must be an integer between 1 and 65535");
	}
	return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value.trim().length === 0) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function parseUrl(value: string | undefined, fallback: string, name: string): string {
	const candidate = requireNonEmptyString(value, fallback, name);
	try {
		return new URL(candidate).toString().replace(/\/$/, "");
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
}

function parseAllowedProjectRoots(value: string | undefined, fallbackRoot: string): string[] {
	if (value === undefined || value.trim().length === 0) {
		return [fallbackRoot];
	}
	return value
		.split(":")
		.map(root => root.trim())
		.filter(root => root.length > 0);
}

function parseConfiguredProjects(value: string | undefined): AdapterProjectConfig[] {
	if (value === undefined || value.trim().length === 0) {
		return [];
	}
	return value
		.split(";")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0)
		.map((entry, index) => parseProjectEntry(entry, index + 1));
}

function parseProjectEntry(entry: string, entryNumber: number): AdapterProjectConfig {
	const fields = entry.split("|");
	if (fields.length > 4) {
		throw new Error(`GJC_OPENWEBUI_PROJECTS entry ${entryNumber} has too many fields`);
	}
	const cwd = fields[0]?.trim() || undefined;
	if (cwd === undefined) {
		throw new Error(`GJC_OPENWEBUI_PROJECTS entry ${entryNumber} must include a non-empty cwd`);
	}
	const name = fields[1]?.trim() || undefined;
	const openWebUIFolderId = fields[2]?.trim() || undefined;
	const sessionRoot = fields[3]?.trim() || undefined;
	return {
		cwd,
		...(name === undefined ? {} : { name }),
		...(openWebUIFolderId === undefined ? {} : { openWebUIFolderId }),
		...(sessionRoot === undefined ? {} : { sessionRoot }),
	};
}

export function loadAdapterConfig(env: Record<string, string | undefined> = process.env): ResolvedAdapterConfig {
	const artifactBaseUrl = env.GJC_OPENWEBUI_ARTIFACT_BASE_URL?.trim() || undefined;
	const adapterApiToken = env.GJC_OPENWEBUI_ADAPTER_API_TOKEN?.trim() || undefined;
	const openWebUIApiToken = env.GJC_OPENWEBUI_API_TOKEN?.trim() || undefined;
	const openWebUIAdminEmail = env.GJC_OPENWEBUI_ADMIN_EMAIL?.trim() || undefined;
	const openWebUIAdminPassword = env.GJC_OPENWEBUI_ADMIN_PASSWORD?.trim() || undefined;
	const ownerUserId = env.GJC_OPENWEBUI_OWNER_USER_ID?.trim() || undefined;
	const serviceHome = env.HOME ?? process.env.HOME;
	const runtimeLocations = resolveGjcRuntimeLocations({
		mode: "existing",
		...(serviceHome === undefined ? {} : { serviceHome }),
		environment: env,
	});
	return Object.freeze({
		bindHost: requireNonEmptyString(env.GJC_OPENWEBUI_BIND_HOST, DEFAULT_BIND_HOST, "GJC_OPENWEBUI_BIND_HOST"),
		bindPort: parsePort(env.GJC_OPENWEBUI_BIND_PORT),
		...(adapterApiToken === undefined ? {} : { adapterApiToken }),
		openWebUIBaseUrl: parseUrl(env.GJC_OPENWEBUI_BASE_URL, DEFAULT_OPENWEBUI_BASE_URL, "GJC_OPENWEBUI_BASE_URL"),
		...(openWebUIApiToken === undefined ? {} : { openWebUIApiToken }),
		...(openWebUIAdminEmail === undefined ? {} : { openWebUIAdminEmail }),
		...(openWebUIAdminPassword === undefined ? {} : { openWebUIAdminPassword }),
		...(ownerUserId === undefined ? {} : { ownerUserId }),
		statePath: requireNonEmptyString(env.GJC_OPENWEBUI_STATE_PATH, DEFAULT_STATE_PATH, "GJC_OPENWEBUI_STATE_PATH"),
		gjcCommand: requireNonEmptyString(
			env.GJC_OPENWEBUI_GJC_COMMAND,
			DEFAULT_GJC_COMMAND,
			"GJC_OPENWEBUI_GJC_COMMAND",
		),
		gjcConfigDirName: runtimeLocations.childEnvironment.GJC_CONFIG_DIR,
		gjcCodingAgentDir: runtimeLocations.agentDir,
		runtimeLocations,
		turnTimeoutMs: parsePositiveInteger(
			env.GJC_OPENWEBUI_TURN_TIMEOUT_MS,
			DEFAULT_TURN_TIMEOUT_MS,
			"GJC_OPENWEBUI_TURN_TIMEOUT_MS",
		),
		sessionRoot: requireNonEmptyString(env.GJC_OPENWEBUI_SESSION_ROOT, process.cwd(), "GJC_OPENWEBUI_SESSION_ROOT"),
		allowedProjectRoots: parseAllowedProjectRoots(env.GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS, process.cwd()),
		...(artifactBaseUrl === undefined
			? {}
			: { artifactBaseUrl: parseUrl(artifactBaseUrl, artifactBaseUrl, "GJC_OPENWEBUI_ARTIFACT_BASE_URL") }),
		projects: parseConfiguredProjects(env.GJC_OPENWEBUI_PROJECTS),
	});
}
