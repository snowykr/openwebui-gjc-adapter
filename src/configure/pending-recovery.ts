import type { InstalledConfig } from "./installed-config-schema";
import {
	ConfigFileError,
	canonicalizeUrl,
	validateGjcCodingAgentDir,
	validateGjcConfigDirName,
} from "./installed-config-schema";

export interface PendingRecoveryLinkageInput {
	readonly mode: "managed" | "existing";
	readonly priorMode: "managed" | "existing";
	readonly installationId: string;
	readonly targetUrl: string;
	readonly providerUrl: string;
	readonly uiPort: number;
	readonly bindPort?: number;
	readonly projectRoot?: string;
	readonly gjcConfigDirName?: string;
	readonly gjcCodingAgentDir?: string;
	readonly priorControllerEnabled: boolean;
	readonly priorControllerActive: boolean;
	readonly controllerRecoveryRequired: boolean;
	readonly controllerQuiesced: boolean;
}

type ParsedPendingRecoveryLinkage = PendingRecoveryLinkageInput & {
	readonly version: 1;
	readonly transactionId: string;
	readonly adapterToken: string;
	readonly readinessToken: string;
	readonly linkage: string;
};

const EXISTING_KEYS =
	"adapterToken,bindPort,controllerQuiesced,controllerRecoveryRequired,installationId,linkage,mode,priorControllerActive,priorControllerEnabled,priorMode,projectRoot,providerUrl,readinessToken,targetUrl,transactionId,uiPort,version";
const MANAGED_KEYS =
	"adapterToken,controllerQuiesced,controllerRecoveryRequired,installationId,linkage,mode,priorControllerActive,priorControllerEnabled,priorMode,providerUrl,readinessToken,targetUrl,transactionId,uiPort,version";

export function buildPendingRecoveryLinkage(input: PendingRecoveryLinkageInput): string {
	const gjcConfigDirName =
		input.gjcConfigDirName === undefined ? undefined : validateGjcConfigDirName(input.gjcConfigDirName);
	const gjcCodingAgentDir =
		input.gjcCodingAgentDir === undefined ? undefined : validateGjcCodingAgentDir(input.gjcCodingAgentDir);
	if (input.mode === "managed" && (gjcConfigDirName !== undefined || gjcCodingAgentDir !== undefined))
		throw new ConfigFileError("managed recovery must not include GJC runtime location fields");
	const legacy = `${input.mode}:${input.installationId}:${input.targetUrl}:${input.providerUrl}:${input.uiPort}${input.projectRoot === undefined ? "" : `:${input.projectRoot}`}${input.bindPort === undefined ? "" : `:${input.bindPort}`}:${input.priorMode}:${input.priorControllerEnabled ? "enabled" : "disabled"}:${input.priorControllerActive ? "active" : "inactive"}:${input.controllerRecoveryRequired ? "recovery-required" : "controller-live"}:${input.controllerQuiesced ? "controller-quiesced" : "controller-live"}`;
	if (gjcConfigDirName === undefined && gjcCodingAgentDir === undefined) return legacy;
	const encoded = Buffer.from(JSON.stringify([gjcConfigDirName ?? null, gjcCodingAgentDir ?? null]), "utf8").toString(
		"base64url",
	);
	return `${legacy}:gjc-paths-v1:${encoded}`;
}

export type PendingRecoveryRetryInput = {
	readonly mode: "managed" | "existing";
	readonly options: Readonly<Record<string, string | boolean>>;
	readonly pending: ParsedPendingRecoveryLinkage | undefined;
	readonly previous: InstalledConfig | undefined;
};

export type RecoveryRuntimeLocationIdentity = {
	readonly gjcConfigDirName?: string;
	readonly gjcCodingAgentDir?: string;
};

function optionValue(options: Readonly<Record<string, string | boolean>>, name: string): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}

export function validatePendingRecoveryRetry(input: PendingRecoveryRetryInput): RecoveryRuntimeLocationIdentity {
	const requestedConfigName = optionValue(input.options, "gjc-config-dir-name");
	const requestedAgentDir = optionValue(input.options, "gjc-coding-agent-dir");
	const gjcConfigDirName =
		requestedConfigName === undefined ? undefined : validateGjcConfigDirName(requestedConfigName);
	const gjcCodingAgentDir = requestedAgentDir === undefined ? undefined : validateGjcCodingAgentDir(requestedAgentDir);
	const pending = input.pending;
	if (pending === undefined) {
		const prior = input.previous?.mode === input.mode ? input.previous : undefined;
		return {
			...((gjcConfigDirName ?? prior?.gjcConfigDirName) === undefined
				? {}
				: { gjcConfigDirName: gjcConfigDirName ?? prior?.gjcConfigDirName }),
			...((gjcCodingAgentDir ?? prior?.gjcCodingAgentDir) === undefined
				? {}
				: { gjcCodingAgentDir: gjcCodingAgentDir ?? prior?.gjcCodingAgentDir }),
		};
	}
	if (pending.mode !== input.mode)
		throw new ConfigFileError("pending recovery belongs to a different deployment mode");
	if (input.mode === "managed" && optionValue(input.options, "adapter-ingress-url") !== undefined)
		throw new ConfigFileError("managed recovery does not accept an ingress URL");
	const requestedTarget = optionValue(input.options, "openwebui-url");
	if (requestedTarget !== undefined && canonicalizeUrl(requestedTarget, "openwebui-url") !== pending.targetUrl)
		throw new ConfigFileError("pending recovery OpenWebUI URL does not match retry input");
	const requestedProvider = optionValue(input.options, "adapter-ingress-url");
	if (requestedProvider !== undefined) {
		let canonicalProvider = canonicalizeUrl(requestedProvider, "adapter-ingress-url");
		if (!canonicalProvider.endsWith("/v1")) canonicalProvider += "/v1";
		if (canonicalProvider !== pending.providerUrl)
			throw new ConfigFileError("pending recovery provider URL does not match retry input");
	}
	if (pending.linkage !== buildPendingRecoveryLinkage(pending))
		throw new ConfigFileError("pending recovery linkage is invalid");
	if (
		input.previous?.mode === pending.mode &&
		(input.previous.installationId !== pending.installationId ||
			input.previous.adapterToken !== pending.adapterToken ||
			input.previous.readinessToken !== pending.readinessToken)
	)
		throw new ConfigFileError("pending recovery identity does not match installed configuration");
	const bindPort = optionValue(input.options, "bind-port");
	if (pending.mode === "existing" && bindPort !== undefined && Number(bindPort) !== pending.bindPort)
		throw new ConfigFileError("pending recovery bind port does not match retry input");
	if (gjcConfigDirName !== undefined && gjcConfigDirName !== pending.gjcConfigDirName)
		throw new ConfigFileError("pending recovery --gjc-config-dir-name does not match retry input");
	if (gjcCodingAgentDir !== undefined && gjcCodingAgentDir !== pending.gjcCodingAgentDir)
		throw new ConfigFileError("pending recovery --gjc-coding-agent-dir does not match retry input");
	return {
		...(pending.gjcConfigDirName === undefined ? {} : { gjcConfigDirName: pending.gjcConfigDirName }),
		...(pending.gjcCodingAgentDir === undefined ? {} : { gjcCodingAgentDir: pending.gjcCodingAgentDir }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalRecoveryUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return false;
		if (
			url.hostname !== url.hostname.toLowerCase() ||
			(url.pathname !== "/" && url.pathname !== url.pathname.replace(/\/+$/, ""))
		)
			return false;
		if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))
			return false;
		return url.toString().replace(/\/$/, "") === value;
	} catch {
		return false;
	}
}

export function parsePendingRecoveryLinkage(value: unknown): ParsedPendingRecoveryLinkage | undefined {
	if (!isRecord(value)) return undefined;
	const expectedKeys = [
		...(value.mode === "existing" ? EXISTING_KEYS : MANAGED_KEYS).split(","),
		...(value.gjcConfigDirName === undefined ? [] : ["gjcConfigDirName"]),
		...(value.gjcCodingAgentDir === undefined ? [] : ["gjcCodingAgentDir"]),
	]
		.sort()
		.join(",");
	if (Object.keys(value).sort().join(",") !== expectedKeys) return undefined;
	if (
		value.version !== 1 ||
		(value.mode !== "managed" && value.mode !== "existing") ||
		(value.priorMode !== "managed" && value.priorMode !== "existing") ||
		!isNonEmptyString(value.installationId) ||
		!isNonEmptyString(value.transactionId) ||
		!isNonEmptyString(value.adapterToken) ||
		!isNonEmptyString(value.readinessToken) ||
		!isCanonicalRecoveryUrl(value.targetUrl) ||
		!isCanonicalRecoveryUrl(value.providerUrl) ||
		!isNonEmptyString(value.linkage)
	)
		return undefined;
	if (typeof value.uiPort !== "number" || !Number.isInteger(value.uiPort) || value.uiPort < 1 || value.uiPort > 65535)
		return undefined;
	if (
		typeof value.priorControllerEnabled !== "boolean" ||
		typeof value.priorControllerActive !== "boolean" ||
		typeof value.controllerRecoveryRequired !== "boolean" ||
		typeof value.controllerQuiesced !== "boolean" ||
		(value.controllerQuiesced && !value.controllerRecoveryRequired)
	)
		return undefined;
	let bindPort: number | undefined;
	let projectRoot: string | undefined;
	let gjcConfigDirName: string | undefined;
	let gjcCodingAgentDir: string | undefined;
	try {
		gjcConfigDirName =
			value.gjcConfigDirName === undefined ? undefined : validateGjcConfigDirName(value.gjcConfigDirName);
		gjcCodingAgentDir =
			value.gjcCodingAgentDir === undefined ? undefined : validateGjcCodingAgentDir(value.gjcCodingAgentDir);
	} catch {
		return undefined;
	}
	if (value.mode === "managed" && (gjcConfigDirName !== undefined || gjcCodingAgentDir !== undefined))
		return undefined;
	if (value.mode === "existing") {
		if (
			typeof value.bindPort !== "number" ||
			!Number.isInteger(value.bindPort) ||
			value.bindPort < 1 ||
			value.bindPort > 65535
		)
			return undefined;
		if (
			typeof value.projectRoot !== "string" ||
			!value.projectRoot.startsWith("/") ||
			value.projectRoot.endsWith("/") ||
			value.projectRoot.split("/").includes("..")
		)
			return undefined;
		bindPort = value.bindPort;
		projectRoot = value.projectRoot;
	} else if (value.projectRoot !== undefined) {
		return undefined;
	}
	return {
		version: 1,
		mode: value.mode,
		priorMode: value.priorMode,
		installationId: value.installationId,
		transactionId: value.transactionId,
		adapterToken: value.adapterToken,
		readinessToken: value.readinessToken,
		targetUrl: value.targetUrl,
		providerUrl: value.providerUrl,
		uiPort: value.uiPort,
		...(bindPort === undefined ? {} : { bindPort }),
		...(projectRoot === undefined ? {} : { projectRoot }),
		...(gjcConfigDirName === undefined ? {} : { gjcConfigDirName }),
		...(gjcCodingAgentDir === undefined ? {} : { gjcCodingAgentDir }),
		priorControllerEnabled: value.priorControllerEnabled,
		priorControllerActive: value.priorControllerActive,
		controllerRecoveryRequired: value.controllerRecoveryRequired,
		controllerQuiesced: value.controllerQuiesced,
		linkage: value.linkage,
	};
}

export function matchesPendingRecoveryLinkage(value: unknown): boolean {
	const parsed = parsePendingRecoveryLinkage(value);
	return parsed !== undefined && parsed.linkage === buildPendingRecoveryLinkage(parsed);
}
