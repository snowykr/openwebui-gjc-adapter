import { randomUUID } from "node:crypto";

export interface TmuxCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface TmuxCommandRunner {
	run(argv: readonly string[]): Promise<TmuxCommandResult>;
}

export interface OwnedTmuxPane {
	readonly target: string;
	readonly panePid: number;
	readonly ownershipTag: string;
	readonly socketName?: string;
}

export type TmuxOwnershipResult =
	| { readonly status: "owned"; readonly pane: OwnedTmuxPane }
	/** The original pane target no longer exists. */
	| { readonly status: "absent" }
	/** The target remains, but tmux proves it now has a different pane PID. */
	| { readonly status: "replaced"; readonly message: string }
	/** tmux answered, but target/tag/identity evidence cannot prove ownership. */
	| { readonly status: "uncertain"; readonly message: string }
	/** tmux could not be observed. */
	| { readonly status: "unavailable"; readonly message: string };

/** Runs in a unique tmux socket namespace, never the user's default server. */
export class BunTmuxCommandRunner implements TmuxCommandRunner {
	readonly #namespace: string;
	readonly socketName: string;
	constructor(
		private readonly tmuxPath = "tmux",
		namespace = `openwebui-gjc-${randomUUID()}`,
	) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new TypeError("tmux namespace contains unsafe characters");
		this.#namespace = namespace;
		this.socketName = namespace;
	}

	async run(argv: readonly string[]): Promise<TmuxCommandResult> {
		try {
			const child = Bun.spawn([this.tmuxPath, "-L", this.#namespace, ...argv], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { exitCode, stdout, stderr };
		} catch (error) {
			return { exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	}
}

export function newTmuxOwnershipTag(): string {
	return `openwebui-gjc-${randomUUID()}`;
}

export async function proveTmuxPaneOwnership(
	runner: TmuxCommandRunner,
	pane: OwnedTmuxPane,
): Promise<TmuxOwnershipResult> {
	const result = await runner.run(["display-message", "-p", "-t", pane.target, "#{pane_id}|#{pane_pid}|#{@openwebui_gjc_owner}"]);
	if (result.exitCode !== 0) {
		if (isMissingTarget(result.stderr)) return { status: "absent" };
		return { status: "unavailable", message: tmuxMessage(result) };
	}
	const [target, pidText, tag, ...extra] = result.stdout.trim().split("|");
	if (extra.length !== 0 || target !== pane.target || !/^\d+$/.test(pidText ?? "")) {
		return { status: "uncertain", message: "tmux pane identity changed" };
	}
	if (Number(pidText) !== pane.panePid) return { status: "replaced", message: "tmux pane PID changed" };
	if (tag !== pane.ownershipTag) return { status: "uncertain", message: "tmux pane ownership tag does not match" };
	return { status: "owned", pane };
}
/** Cleans a pane created in this invocation before its ownership tag could be written. */
export async function destroyProvisionalTmuxPane(
	runner: TmuxCommandRunner,
	pane: Pick<OwnedTmuxPane, "target" | "panePid">,
): Promise<TmuxOwnershipResult> {
	const proven = await runner.run(["display-message", "-p", "-t", pane.target, "#{pane_id}|#{pane_pid}"]);
	if (proven.exitCode !== 0) {
		if (isMissingTarget(proven.stderr)) return { status: "absent" };
		return { status: "unavailable", message: tmuxMessage(proven) };
	}
	const [target, pidText, ...extra] = proven.stdout.trim().split("|");
	if (extra.length !== 0 || target !== pane.target || !/^\d+$/.test(pidText ?? "") || Number(pidText) !== pane.panePid) {
		return { status: "uncertain", message: "new tmux pane identity changed before ownership tagging" };
	}
	const result = await runner.run(["kill-pane", "-t", pane.target]);
	if (result.exitCode === 0 || isMissingTarget(result.stderr)) return { status: "absent" };
	return { status: "unavailable", message: tmuxMessage(result) };
}

export async function destroyProvenOwnedTmuxPane(
	runner: TmuxCommandRunner,
	pane: OwnedTmuxPane,
): Promise<TmuxOwnershipResult> {
	const proven = await proveTmuxPaneOwnership(runner, pane);
	if (proven.status !== "owned") return proven;
	const result = await runner.run(["kill-pane", "-t", pane.target]);
	if (result.exitCode === 0 || isMissingTarget(result.stderr)) return { status: "absent" };
	return { status: "unavailable", message: tmuxMessage(result) };
}

function isMissingTarget(stderr: string): boolean {
	return /can't find (pane|window|session)|no server running/i.test(stderr);
}

function tmuxMessage(result: TmuxCommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || "tmux command failed";
}
