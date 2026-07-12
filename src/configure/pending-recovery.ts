export interface PendingRecoveryLinkageInput {
	readonly mode: "managed" | "existing";
	readonly priorMode: "managed" | "existing";
	readonly installationId: string;
	readonly targetUrl: string;
	readonly providerUrl: string;
	readonly uiPort: number;
	readonly bindPort?: number;
	readonly projectRoot?: string;
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

export function buildPendingRecoveryLinkage(input: PendingRecoveryLinkageInput): string {
	return `${input.mode}:${input.installationId}:${input.targetUrl}:${input.providerUrl}:${input.uiPort}${input.projectRoot === undefined ? "" : `:${input.projectRoot}`}${input.bindPort === undefined ? "" : `:${input.bindPort}`}:${input.priorMode}:${input.priorControllerEnabled ? "enabled" : "disabled"}:${input.priorControllerActive ? "active" : "inactive"}:${input.controllerRecoveryRequired ? "recovery-required" : "controller-live"}:${input.controllerQuiesced ? "controller-quiesced" : "controller-live"}`;
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
	const expectedKeys =
		value.mode === "existing"
			? "adapterToken,bindPort,controllerQuiesced,controllerRecoveryRequired,installationId,linkage,mode,priorControllerActive,priorControllerEnabled,priorMode,projectRoot,providerUrl,readinessToken,targetUrl,transactionId,uiPort,version"
			: "adapterToken,controllerQuiesced,controllerRecoveryRequired,installationId,linkage,mode,priorControllerActive,priorControllerEnabled,priorMode,providerUrl,readinessToken,targetUrl,transactionId,uiPort,version";
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
