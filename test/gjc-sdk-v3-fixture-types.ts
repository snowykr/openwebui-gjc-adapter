export type SdkFrame = Readonly<Record<string, unknown>>;

export interface SdkFixtureServer {
	readonly url: string;
	readonly token: string;
	readonly frames: readonly SdkFrame[];
	readonly connections: number;
	stop(): void;
}

export type SdkFixtureScenario =
	| "turn_complete"
	| "resumed_session"
	| "turn_failed"
	| "workflow_gate"
	| "workflow_gate_not_first"
	| "workflow_gate_mismatch"
	| "workflow_gate_continuation"
	| "workflow_gate_sequence"
	| "action_without_gate"
	| "terminal_during_gate_query"
	| "terminal_while_gate_query_hangs"
	| "slow_turn_without_gate"
	| "idle_terminal_without_lifecycle"
	| "idle_without_finalized_turn"
	| "model_catalog"
	| "disconnect";
