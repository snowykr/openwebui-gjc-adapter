import type { OwnedTmuxPane, TmuxCommandRunner } from "./tmux-ownership";

/** Maximum bounded observation window for lifecycle closure proofs. */
export const MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS = 10_000;

export type CliLifecycleResult<T> =
	| { readonly status: "closed"; readonly value: T }
	| { readonly status: "unavailable"; readonly message: string }
	| { readonly status: "uncertain"; readonly message: string };

export interface CliLifecycleAttachment {
	readonly cwd?: string;
	readonly sessionRoot?: string;
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly pane: OwnedTmuxPane;
}

export interface CliCreateInput { readonly sessionRoot: string; }
export interface CliColdResumeInput { readonly existingSessionPath: string; }
export interface CliLifecycleBackendOptions {
	readonly cliPath: string;
	readonly cwd: string;
	readonly tmux?: TmuxCommandRunner;
	readonly tmuxSocket?: string;
	readonly childEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
	readonly cliArgs?: readonly string[];
	readonly captureLines?: number;
}

export function unavailable(error: unknown, fallback: string): CliLifecycleResult<never> {
	return { status: "unavailable", message: error instanceof Error ? error.message : fallback };
}
