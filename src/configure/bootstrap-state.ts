export type BootstrapPhase = "preflight" | "bootstrap" | "api-key" | "openai" | "route" | "ownership" | "complete";

export interface BootstrapState {
	readonly version: 1;
	readonly phase: BootstrapPhase;
	readonly bootstrapComplete: boolean;
	readonly apiKeyCreated: boolean;
	readonly ownerUserId?: string;
	readonly openWebUIApiToken?: string;
	readonly openAIConfigured: boolean;
	readonly routeVerified: boolean;
	readonly ownershipVerified: boolean;
	readonly openAIConnectionIds: readonly string[];
	readonly failedPhase?: BootstrapPhase;
	readonly failureEvidence?: string;
	readonly pendingRecovery?: PendingRecoveryRecord;
}

export interface PendingRecoveryRecord {
	readonly version: 1;
	readonly mode: "managed" | "existing";
	readonly priorMode: "managed" | "existing";
	readonly installationId: string;
	readonly transactionId: string;
	readonly adapterToken: string;
	readonly readinessToken: string;
	readonly targetUrl: string;
	readonly providerUrl: string;
	readonly uiPort: number;
	readonly bindPort?: number;
	readonly projectRoot?: string;
	readonly priorControllerEnabled: boolean;
	readonly priorControllerActive: boolean;
	/** True before any managed controller stop/disable is attempted. */
	readonly controllerRecoveryRequired: boolean;
	/** True after reset has successfully stopped and disabled the prior controller. */
	readonly controllerQuiesced: boolean;
	readonly linkage: string;
}

export interface BootstrapStateStore {
	read(): Promise<BootstrapState | undefined>;
	write(state: BootstrapState): Promise<void>;
}
export interface ExclusiveMaintenanceBoundary {
	readonly begin: () => Promise<void>;
	readonly end: () => Promise<void>;
}
export interface BootstrapResetProof {
	readonly failedPhase: BootstrapPhase;
	readonly evidence: string;
}
export const BOOTSTRAP_PHASES: readonly BootstrapPhase[] = [
	"preflight",
	"bootstrap",
	"api-key",
	"openai",
	"route",
	"ownership",
	"complete",
];
export const INITIAL_BOOTSTRAP_STATE: BootstrapState = {
	version: 1,
	phase: "preflight",
	bootstrapComplete: false,
	apiKeyCreated: false,
	openAIConfigured: false,
	routeVerified: false,
	ownershipVerified: false,
	openAIConnectionIds: [],
};
export function parseBootstrapState(value: unknown): BootstrapState {
	if (!isBootstrapState(value)) throw new Error("Malformed bootstrap state");
	return {
		...value,
		openAIConnectionIds: [...value.openAIConnectionIds],
		...(value.pendingRecovery === undefined ? {} : { pendingRecovery: { ...value.pendingRecovery } }),
	};
}

function isBootstrapState(value: unknown): value is BootstrapState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	const allowed = new Set([
		"version",
		"phase",
		"bootstrapComplete",
		"apiKeyCreated",
		"ownerUserId",
		"openWebUIApiToken",
		"openAIConfigured",
		"routeVerified",
		"ownershipVerified",
		"openAIConnectionIds",
		"failedPhase",
		"failureEvidence",
		"pendingRecovery",
	]);
	if (Object.keys(state).some(key => !allowed.has(key))) return false;
	const checkpoint = [1, 2, 3, 4, 5];
	const completed = [
		state.bootstrapComplete,
		state.apiKeyCreated,
		state.openAIConfigured,
		state.routeVerified,
		state.ownershipVerified,
	];
	if (
		state.version !== 1 ||
		!isBootstrapPhase(state.phase) ||
		typeof state.bootstrapComplete !== "boolean" ||
		typeof state.apiKeyCreated !== "boolean" ||
		typeof state.openAIConfigured !== "boolean" ||
		typeof state.routeVerified !== "boolean" ||
		typeof state.ownershipVerified !== "boolean" ||
		!Array.isArray(state.openAIConnectionIds) ||
		!state.openAIConnectionIds.every(id => typeof id === "string" && id.trim().length > 0) ||
		(state.ownerUserId !== undefined &&
			(typeof state.ownerUserId !== "string" || state.ownerUserId.trim().length === 0)) ||
		(state.openWebUIApiToken !== undefined &&
			(typeof state.openWebUIApiToken !== "string" || state.openWebUIApiToken.trim().length === 0)) ||
		(state.failedPhase !== undefined && !isBootstrapPhase(state.failedPhase)) ||
		(state.failureEvidence !== undefined && typeof state.failureEvidence !== "string") ||
		(state.pendingRecovery !== undefined && !isPendingRecoveryRecord(state.pendingRecovery)) ||
		completed.some((done, index) =>
			done
				? BOOTSTRAP_PHASES.indexOf(state.phase as BootstrapPhase) < checkpoint[index]
				: state.phase !== "complete" && BOOTSTRAP_PHASES.indexOf(state.phase as BootstrapPhase) > checkpoint[index],
		) ||
		(state.failedPhase === undefined) !== (state.failureEvidence === undefined) ||
		(state.failureEvidence !== undefined && state.failureEvidence.trim().length === 0) ||
		(state.failedPhase !== undefined && (state.failedPhase === "complete" || state.failedPhase !== state.phase)) ||
		(state.phase === "complete" &&
			(!state.bootstrapComplete ||
				!state.apiKeyCreated ||
				!state.openAIConfigured ||
				!state.routeVerified ||
				!state.ownershipVerified))
	)
		return false;
	return true;
}
function isPendingRecoveryRecord(value: unknown): value is PendingRecoveryRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const expected =
		record.mode === "existing"
			? "adapterToken,bindPort,controllerQuiesced,controllerRecoveryRequired,installationId,linkage,mode,priorControllerActive,priorControllerEnabled,priorMode,projectRoot,providerUrl,readinessToken,targetUrl,transactionId,uiPort,version"
			: "adapterToken,controllerQuiesced,controllerRecoveryRequired,installationId,linkage,mode,priorControllerActive,priorControllerEnabled,priorMode,providerUrl,readinessToken,targetUrl,transactionId,uiPort,version";
	if (keys.join(",") !== expected) return false;
	if (
		record.version !== 1 ||
		(record.mode !== "managed" && record.mode !== "existing") ||
		(record.priorMode !== "managed" && record.priorMode !== "existing")
	)
		return false;
	if (
		![
			"installationId",
			"transactionId",
			"adapterToken",
			"readinessToken",
			"targetUrl",
			"providerUrl",
			"linkage",
		].every(key => typeof record[key] === "string" && (record[key] as string).trim().length > 0)
	)
		return false;
	if (
		typeof record.uiPort !== "number" ||
		!Number.isInteger(record.uiPort) ||
		record.uiPort < 1 ||
		record.uiPort > 65535
	)
		return false;
	if (
		typeof record.priorControllerEnabled !== "boolean" ||
		typeof record.priorControllerActive !== "boolean" ||
		typeof record.controllerRecoveryRequired !== "boolean" ||
		typeof record.controllerQuiesced !== "boolean" ||
		(record.controllerQuiesced && !record.controllerRecoveryRequired)
	)
		return false;
	if (typeof record.transactionId !== "string" || record.transactionId.trim().length === 0) return false;
	if (
		record.mode === "existing" &&
		(typeof record.bindPort !== "number" ||
			!Number.isInteger(record.bindPort) ||
			record.bindPort < 1 ||
			record.bindPort > 65535)
	)
		return false;
	if (
		record.mode === "existing" &&
		(typeof record.projectRoot !== "string" ||
			!record.projectRoot.startsWith("/") ||
			record.projectRoot.endsWith("/") ||
			record.projectRoot.split("/").includes(".."))
	)
		return false;
	if (record.mode === "managed" && record.projectRoot !== undefined) return false;
	return (
		isCanonicalRecoveryUrl(record.targetUrl) &&
		isCanonicalRecoveryUrl(record.providerUrl) &&
		record.linkage ===
			`${record.mode}:${record.installationId}:${record.targetUrl}:${record.providerUrl}:${record.uiPort}${record.projectRoot === undefined ? "" : `:${record.projectRoot}`}${record.bindPort === undefined ? "" : `:${record.bindPort}`}:${record.priorMode}:${record.priorControllerEnabled ? "enabled" : "disabled"}:${record.priorControllerActive ? "active" : "inactive"}:${record.controllerRecoveryRequired ? "recovery-required" : "controller-live"}:${record.controllerQuiesced ? "controller-quiesced" : "controller-live"}`
	);
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

function isBootstrapPhase(value: unknown): value is BootstrapPhase {
	return typeof value === "string" && (BOOTSTRAP_PHASES as readonly string[]).includes(value);
}

export function isBootstrapPhaseComplete(state: BootstrapState, phase: BootstrapPhase): boolean {
	const index = BOOTSTRAP_PHASES.indexOf(phase);
	return (
		index >= 0 &&
		(BOOTSTRAP_PHASES.indexOf(state.phase) >= index ||
			(phase === "bootstrap" && state.bootstrapComplete) ||
			(phase === "api-key" && state.apiKeyCreated) ||
			(phase === "openai" && state.openAIConfigured) ||
			(phase === "route" && state.routeVerified) ||
			(phase === "ownership" && state.ownershipVerified))
	);
}
export function recoverBootstrapState(state: BootstrapState): BootstrapState {
	const phase = state.ownershipVerified
		? "ownership"
		: state.routeVerified
			? "route"
			: state.openAIConfigured
				? "openai"
				: state.apiKeyCreated
					? "api-key"
					: state.bootstrapComplete
						? "bootstrap"
						: "preflight";
	return { ...state, version: 1, phase };
}
export function advanceBootstrapState(
	state: BootstrapState,
	phase: BootstrapPhase,
	patch: Partial<Omit<BootstrapState, "version" | "phase">> = {},
): BootstrapState {
	return {
		...state,
		...patch,
		phase,
		version: 1,
		openAIConnectionIds: [...(patch.openAIConnectionIds ?? state.openAIConnectionIds)],
		failedPhase: undefined,
		failureEvidence: undefined,
	};
}

/** Reset is valid only with proof that the named phase actually failed. */
export function resetBootstrapState(
	state: BootstrapState,
	failedPhase: BootstrapPhase,
	proof: BootstrapResetProof,
): BootstrapState {
	if (!BOOTSTRAP_PHASES.includes(failedPhase) || failedPhase === "complete")
		throw new Error(`Unknown or non-resettable bootstrap phase: ${failedPhase}`);
	if (proof.failedPhase !== failedPhase || proof.evidence.trim().length === 0)
		throw new Error("Bootstrap reset requires proof for the failed phase");
	const retained = new Set(BOOTSTRAP_PHASES.slice(0, BOOTSTRAP_PHASES.indexOf(failedPhase)));
	return {
		version: 1,
		phase: failedPhase,
		bootstrapComplete:
			retained.has("bootstrap") && (failedPhase !== "api-key" || state.openWebUIApiToken !== undefined),
		apiKeyCreated: retained.has("api-key"),
		...(retained.has("api-key") && state.ownerUserId !== undefined ? { ownerUserId: state.ownerUserId } : {}),
		...(retained.has("api-key") && state.openWebUIApiToken !== undefined
			? { openWebUIApiToken: state.openWebUIApiToken }
			: {}),
		openAIConfigured: retained.has("openai"),
		routeVerified: retained.has("route"),
		ownershipVerified: retained.has("ownership"),
		openAIConnectionIds: retained.has("openai") ? [...state.openAIConnectionIds] : [],
		...(state.pendingRecovery === undefined ? {} : { pendingRecovery: { ...state.pendingRecovery } }),
	};
}
export async function withExclusiveMaintenance<T>(
	boundary: ExclusiveMaintenanceBoundary,
	action: () => Promise<T>,
): Promise<T> {
	await boundary.begin();
	try {
		return await action();
	} finally {
		await boundary.end();
	}
}
