import { isAbsolute, join, normalize } from "node:path";

export type InstalledMode = "managed" | "existing";

export type InstalledConfig = {
	version: 1;
	mode: InstalledMode;
	installationId: string;
	ownerUserId?: string;
	adapterToken: string;
	readinessToken: string;
	openWebUIApiToken?: string;
	openWebUIApiUrl: string;
	adapterProviderUrl: string;
	bindHost: string;
	bindPort: number;
	projectRoot?: string;
	readonly gjcConfigDirName?: string;
	readonly gjcCodingAgentDir?: string;
};

export class ConfigFileError extends Error {
	readonly name = "ConfigFileError";
	readonly exitCode = 1;
}

export function xdgStateDataHome(environment: NodeJS.ProcessEnv): string {
	const configured = environment.XDG_STATE_HOME?.trim() || environment.XDG_DATA_HOME?.trim();
	return configured ?? join(environment.HOME ?? "", ".local", "state");
}

export function defaultExistingProjectRoot(environment: NodeJS.ProcessEnv = process.env): string {
	return join(xdgStateDataHome(environment), "openwebui-gjc-adapter", "workspace");
}

export const DEFAULT_EXISTING_PROJECT_ROOT = defaultExistingProjectRoot();

export function canonicalizeUrl(value: string, name = "URL"): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigFileError(`${name} must be a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new ConfigFileError(`${name} must use http or https`);
	if (url.username || url.password || url.hash || url.search)
		throw new ConfigFileError(`${name} must not contain credentials, query, or fragment`);
	url.hostname = url.hostname.toLowerCase();
	if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))
		url.port = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

export function validateProjectRoot(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value !== value.trim() ||
		!isAbsolute(value) ||
		value.includes("\0") ||
		normalize(value) !== value ||
		value.endsWith("/")
	)
		throw new ConfigFileError("projectRoot must be a normalized absolute path");
	return value;
}

export function validateGjcConfigDirName(value: unknown): string {
	if (typeof value !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(value))
		throw new ConfigFileError("gjcConfigDirName must be a safe directory name");
	return value;
}

export function validateGjcCodingAgentDir(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value !== value.trim() ||
		value.includes("\0") ||
		!isAbsolute(value) ||
		normalize(value) !== value ||
		value.endsWith("/")
	)
		throw new ConfigFileError("gjcCodingAgentDir must be a canonical absolute path");
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0)
		throw new ConfigFileError(`${key} must be a non-empty string`);
	return value;
}

function optionalString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0)
		throw new ConfigFileError(`${key} must be a non-empty string`);
	return value;
}

export function validateInstalledConfig(value: unknown): InstalledConfig {
	if (!isRecord(value)) throw new ConfigFileError("installed config must be an object");
	const allowed = new Set([
		"version",
		"mode",
		"installationId",
		"ownerUserId",
		"adapterToken",
		"readinessToken",
		"openWebUIApiToken",
		"openWebUIApiUrl",
		"adapterProviderUrl",
		"bindHost",
		"bindPort",
		"projectRoot",
		"gjcConfigDirName",
		"gjcCodingAgentDir",
	]);
	if (Object.keys(value).some(key => !allowed.has(key)))
		throw new ConfigFileError("installed config contains unknown fields");
	const mode = value.mode;
	if (value.version !== 1 || (mode !== "managed" && mode !== "existing"))
		throw new ConfigFileError("unsupported installed config");
	if (mode === "managed" && (value.gjcConfigDirName !== undefined || value.gjcCodingAgentDir !== undefined))
		throw new ConfigFileError("managed configuration must not include GJC runtime location fields");
	const bindPort = value.bindPort;
	if (typeof bindPort !== "number" || !Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65_535)
		throw new ConfigFileError("bindPort is invalid");
	const bindHost = requiredString(value, "bindHost").trim();
	if (mode === "managed" && bindHost !== "0.0.0.0")
		throw new ConfigFileError("managed configuration must bind 0.0.0.0");
	if (mode === "existing" && bindHost !== "127.0.0.1")
		throw new ConfigFileError("existing configuration must bind 127.0.0.1");
	const ownerUserId = optionalString(value, "ownerUserId");
	const openWebUIApiToken = optionalString(value, "openWebUIApiToken");
	const projectRoot =
		mode === "existing"
			? validateProjectRoot(value.projectRoot ?? DEFAULT_EXISTING_PROJECT_ROOT)
			: value.projectRoot === undefined
				? undefined
				: validateProjectRoot(value.projectRoot);
	const gjcConfigDirName =
		value.gjcConfigDirName === undefined ? undefined : validateGjcConfigDirName(value.gjcConfigDirName);
	const gjcCodingAgentDir =
		value.gjcCodingAgentDir === undefined ? undefined : validateGjcCodingAgentDir(value.gjcCodingAgentDir);
	return {
		version: 1,
		mode,
		installationId: requiredString(value, "installationId"),
		...(ownerUserId === undefined ? {} : { ownerUserId }),
		adapterToken: requiredString(value, "adapterToken"),
		readinessToken: requiredString(value, "readinessToken"),
		...(openWebUIApiToken === undefined ? {} : { openWebUIApiToken }),
		openWebUIApiUrl: canonicalizeUrl(requiredString(value, "openWebUIApiUrl"), "openWebUIApiUrl"),
		adapterProviderUrl: canonicalizeUrl(requiredString(value, "adapterProviderUrl"), "adapterProviderUrl"),
		bindHost,
		bindPort,
		...(projectRoot === undefined ? {} : { projectRoot }),
		...(gjcConfigDirName === undefined ? {} : { gjcConfigDirName }),
		...(gjcCodingAgentDir === undefined ? {} : { gjcCodingAgentDir }),
	};
}
