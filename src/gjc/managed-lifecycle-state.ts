export const MANAGED_LIFECYCLE_STATES = [
	"intent_prepared",
	"invoking",
	"acknowledged_unproven",
	"active_generation_proven",
	"closing",
	"retired",
	"terminal_failure",
	"uncertain",
	"cleanup_pending",
	"cleanup_uncertain",
] as const;

export type ManagedLifecycleState = (typeof MANAGED_LIFECYCLE_STATES)[number];

const STATE_SET = new Set<string>(MANAGED_LIFECYCLE_STATES);

/**
 * The only lifecycle edges an owner may persist. Terminal states deliberately
 * have no successors; recovery is represented by an explicit uncertain state,
 * never by rewriting historical terminal evidence.
 */
export const MANAGED_LIFECYCLE_TRANSITIONS: Readonly<Record<ManagedLifecycleState, readonly ManagedLifecycleState[]>> =
	Object.freeze({
		intent_prepared: ["invoking", "terminal_failure"],
		invoking: ["acknowledged_unproven", "terminal_failure", "uncertain", "cleanup_pending"],
		acknowledged_unproven: ["active_generation_proven", "cleanup_pending", "uncertain", "retired"],
		active_generation_proven: ["closing"],
		closing: ["active_generation_proven", "retired", "uncertain"],
		retired: [],
		terminal_failure: [],
		uncertain: [
			"acknowledged_unproven",
			"active_generation_proven",
			"retired",
			"terminal_failure",
			"cleanup_pending",
			"cleanup_uncertain",
		],
		cleanup_pending: ["invoking", "cleanup_uncertain"],
		cleanup_uncertain: ["cleanup_pending", "retired", "uncertain"],
	});

export class ManagedLifecycleStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManagedLifecycleStateError";
	}
}

export function isManagedLifecycleState(value: unknown): value is ManagedLifecycleState {
	return typeof value === "string" && STATE_SET.has(value);
}

export function parseManagedLifecycleState(value: unknown): ManagedLifecycleState {
	if (!isManagedLifecycleState(value)) throw new ManagedLifecycleStateError("Invalid managed lifecycle state.");
	return value;
}

/** A deliberately credential-free persistence codec for lifecycle evidence. */
export function encodeManagedLifecycleState(state: ManagedLifecycleState): string {
	return JSON.stringify({ state });
}

export function decodeManagedLifecycleState(value: unknown): ManagedLifecycleState {
	let parsed: unknown;
	try {
		parsed = typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		throw new ManagedLifecycleStateError("Malformed managed lifecycle state codec.");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ManagedLifecycleStateError("Malformed managed lifecycle state codec.");
	const record = parsed as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || !("state" in record))
		throw new ManagedLifecycleStateError("Malformed managed lifecycle state codec.");
	return parseManagedLifecycleState(record.state);
}

export function canTransitionManagedLifecycleState(from: ManagedLifecycleState, to: ManagedLifecycleState): boolean {
	return MANAGED_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertManagedLifecycleTransition(from: ManagedLifecycleState, to: ManagedLifecycleState): void {
	if (!canTransitionManagedLifecycleState(from, to))
		throw new ManagedLifecycleStateError(`Illegal managed lifecycle transition: ${from} -> ${to}.`);
}
