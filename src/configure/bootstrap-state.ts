import { matchesPendingRecoveryLinkage } from "./pending-recovery";

export type { PendingRecoveryLinkageInput } from "./pending-recovery";
export {
	buildPendingRecoveryLinkage,
	matchesPendingRecoveryLinkage,
	parsePendingRecoveryLinkage,
} from "./pending-recovery";

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
	readonly controllerRecoveryRequired: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBootstrapPhase(value: unknown): value is BootstrapPhase {
	return typeof value === "string" && BOOTSTRAP_PHASES.some(phase => phase === value);
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function isPendingRecoveryRecord(value: unknown): value is PendingRecoveryRecord {
	return matchesPendingRecoveryLinkage(value);
}

function isBootstrapState(value: unknown): value is BootstrapState {
	if (!isRecord(value)) return false;
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
	if (Object.keys(value).some(key => !allowed.has(key))) return false;
	const phase = value.phase;
	if (
		value.version !== 1 ||
		!isBootstrapPhase(phase) ||
		typeof value.bootstrapComplete !== "boolean" ||
		typeof value.apiKeyCreated !== "boolean" ||
		typeof value.openAIConfigured !== "boolean" ||
		typeof value.routeVerified !== "boolean" ||
		typeof value.ownershipVerified !== "boolean" ||
		!isNonEmptyStringArray(value.openAIConnectionIds)
	)
		return false;
	if (
		(value.ownerUserId !== undefined &&
			(typeof value.ownerUserId !== "string" || value.ownerUserId.trim().length === 0)) ||
		(value.openWebUIApiToken !== undefined &&
			(typeof value.openWebUIApiToken !== "string" || value.openWebUIApiToken.trim().length === 0)) ||
		(value.failedPhase !== undefined && !isBootstrapPhase(value.failedPhase)) ||
		(value.failureEvidence !== undefined && typeof value.failureEvidence !== "string") ||
		(value.pendingRecovery !== undefined && !isPendingRecoveryRecord(value.pendingRecovery))
	)
		return false;
	const checkpoint = [1, 2, 3, 4, 5];
	const completed = [
		value.bootstrapComplete,
		value.apiKeyCreated,
		value.openAIConfigured,
		value.routeVerified,
		value.ownershipVerified,
	];
	if (
		completed.some((done, index) =>
			done
				? BOOTSTRAP_PHASES.indexOf(phase) < checkpoint[index]
				: phase !== "complete" && BOOTSTRAP_PHASES.indexOf(phase) > checkpoint[index],
		)
	)
		return false;
	return (
		(value.failedPhase === undefined) === (value.failureEvidence === undefined) &&
		!(value.failureEvidence !== undefined && value.failureEvidence.trim().length === 0) &&
		!(value.failedPhase !== undefined && (value.failedPhase === "complete" || value.failedPhase !== value.phase)) &&
		!(
			value.phase === "complete" &&
			(!value.bootstrapComplete ||
				!value.apiKeyCreated ||
				!value.openAIConfigured ||
				!value.routeVerified ||
				!value.ownershipVerified)
		)
	);
}

export function parseBootstrapState(value: unknown): BootstrapState {
	if (!isBootstrapState(value)) throw new Error("Malformed bootstrap state");
	return {
		...value,
		openAIConnectionIds: [...value.openAIConnectionIds],
		...(value.pendingRecovery === undefined ? {} : { pendingRecovery: { ...value.pendingRecovery } }),
	};
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
		failedPhase,
		failureEvidence: proof.evidence,
		phase: failedPhase,
		bootstrapComplete: retained.has("bootstrap"),
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
