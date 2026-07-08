import { REQUIRED_OPENWEBUI_HEADER_NAMES, type RequiredOpenWebUIHeaderName } from "./contracts";

export interface AdapterConfig {
	bindHost: string;
	bindPort: number;
	openWebUIBaseUrl: string;
	openWebUIApiToken?: string;
	openWebUIAdminEmail?: string;
	openWebUIAdminPassword?: string;
	ownerUserId?: string;
	statePath: string;
	gjcCommand: string;
	sessionRoot: string;
	allowedProjectRoots: string[];
	artifactBaseUrl?: string;
}

export interface StartupDiagnostic {
	status: "ok" | "degraded";
	missingAuth: boolean;
	missingAllowedProjectRoots: boolean;
	expectedHeaderNames: RequiredOpenWebUIHeaderName[];
	messages: string[];
}

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_BIND_PORT = 8765;
const DEFAULT_OPENWEBUI_BASE_URL = "http://localhost:8080";
const DEFAULT_STATE_PATH = ".gjc/openwebui-adapter";
const DEFAULT_GJC_COMMAND = "gjc";

function requireNonEmptyString(value: string | undefined, fallback: string, name: string): string {
	const candidate = value ?? fallback;
	const trimmed = candidate.trim();
	if (trimmed.length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return trimmed;
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
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

function parseUrl(value: string | undefined, fallback: string, name: string): string {
	const candidate = requireNonEmptyString(value, fallback, name);
	try {
		return new URL(candidate).toString().replace(/\/$/, "");
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	return env[name];
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

export function loadAdapterConfig(env: Record<string, string | undefined> = process.env): AdapterConfig {
	const currentWorkingDirectory = process.cwd();
	const config: AdapterConfig = {
		bindHost: requireNonEmptyString(
			optionalEnv(env, "GJC_OPENWEBUI_BIND_HOST"),
			DEFAULT_BIND_HOST,
			"GJC_OPENWEBUI_BIND_HOST",
		),
		bindPort: parsePort(optionalEnv(env, "GJC_OPENWEBUI_BIND_PORT")),
		openWebUIBaseUrl: parseUrl(
			optionalEnv(env, "GJC_OPENWEBUI_BASE_URL"),
			DEFAULT_OPENWEBUI_BASE_URL,
			"GJC_OPENWEBUI_BASE_URL",
		),
		openWebUIApiToken: optionalNonEmptyString(optionalEnv(env, "GJC_OPENWEBUI_API_TOKEN")),
		openWebUIAdminEmail: optionalNonEmptyString(optionalEnv(env, "GJC_OPENWEBUI_ADMIN_EMAIL")),
		openWebUIAdminPassword: optionalNonEmptyString(optionalEnv(env, "GJC_OPENWEBUI_ADMIN_PASSWORD")),
		ownerUserId: optionalNonEmptyString(optionalEnv(env, "GJC_OPENWEBUI_OWNER_USER_ID")),
		statePath: requireNonEmptyString(
			optionalEnv(env, "GJC_OPENWEBUI_STATE_PATH"),
			DEFAULT_STATE_PATH,
			"GJC_OPENWEBUI_STATE_PATH",
		),
		gjcCommand: requireNonEmptyString(
			optionalEnv(env, "GJC_OPENWEBUI_GJC_COMMAND"),
			DEFAULT_GJC_COMMAND,
			"GJC_OPENWEBUI_GJC_COMMAND",
		),
		sessionRoot: requireNonEmptyString(
			optionalEnv(env, "GJC_OPENWEBUI_SESSION_ROOT"),
			currentWorkingDirectory,
			"GJC_OPENWEBUI_SESSION_ROOT",
		),
		allowedProjectRoots: parseAllowedProjectRoots(
			optionalEnv(env, "GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS"),
			currentWorkingDirectory,
		),
		artifactBaseUrl: optionalNonEmptyString(optionalEnv(env, "GJC_OPENWEBUI_ARTIFACT_BASE_URL")),
	};
	if (config.artifactBaseUrl !== undefined) {
		config.artifactBaseUrl = parseUrl(
			config.artifactBaseUrl,
			config.artifactBaseUrl,
			"GJC_OPENWEBUI_ARTIFACT_BASE_URL",
		);
	}
	return config;
}

export function buildStartupDiagnostics(config: AdapterConfig): StartupDiagnostic {
	const missingAuth = config.openWebUIApiToken === undefined;
	const missingAllowedProjectRoots = config.allowedProjectRoots.length === 0;
	const messages: string[] = [];
	if (missingAuth) {
		messages.push("GJC_OPENWEBUI_API_TOKEN is not set; OpenWebUI API calls are not authenticated.");
	}
	if (missingAllowedProjectRoots) {
		messages.push("No allowed project roots are configured.");
	}
	return {
		status: missingAuth || missingAllowedProjectRoots ? "degraded" : "ok",
		missingAuth,
		missingAllowedProjectRoots,
		expectedHeaderNames: [...REQUIRED_OPENWEBUI_HEADER_NAMES],
		messages,
	};
}
