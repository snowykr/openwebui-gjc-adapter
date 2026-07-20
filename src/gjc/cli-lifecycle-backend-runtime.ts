import { resolve } from "node:path";
import { readCliSession } from "./cli-lifecycle-readiness";
import type { CliLifecycleAttachment, CliLifecycleBackendOptions, CliLifecycleResult } from "./cli-lifecycle-types";
import { unavailable } from "./cli-lifecycle-types";
import { type openAbsoluteRegularSessionFile, revalidateOpenedRegularSessionFile } from "./session-file";
import {
	BunTmuxCommandRunner,
	destroyProvenOwnedTmuxPane,
	destroyProvisionalTmuxPane,
	newTmuxOwnershipTag,
	type OwnedTmuxPane,
	proveTmuxPaneOwnership,
	type TmuxCommandRunner,
} from "./tmux-ownership";

type ResumeFile = ReturnType<typeof openAbsoluteRegularSessionFile>;
type OpenedAttachment = Omit<CliLifecycleAttachment, "cwd" | "sessionRoot">;

export interface CliLifecycleBackendRuntime {
	readonly tmux: TmuxCommandRunner;
	open(
		resumePath: string | undefined,
		sessionRoot: string,
		resume?: ResumeFile,
	): Promise<CliLifecycleResult<OpenedAttachment>>;
	cleanup(attachment: CliLifecycleAttachment | OwnedTmuxPane, message: string): Promise<CliLifecycleResult<never>>;
	readiness(attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>>;
	fallbackBeforeCloseAcknowledgement(attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>>;
}

export function createCliLifecycleBackendRuntime(options: CliLifecycleBackendOptions): CliLifecycleBackendRuntime {
	const tmux = options.tmux ?? new BunTmuxCommandRunner(undefined, options.tmuxSocket);
	const captureLines = options.captureLines ?? 128;
	if (!Number.isInteger(captureLines) || captureLines < 1 || captureLines > 1_000)
		throw new TypeError("captureLines must be an integer between 1 and 1000");
	const endpointPublicationTimeoutMs = options.endpointPublicationTimeoutMs ?? 10_000;
	if (!Number.isInteger(endpointPublicationTimeoutMs) || endpointPublicationTimeoutMs < 1)
		throw new TypeError("endpointPublicationTimeoutMs must be a positive integer");

	const fallbackBeforeCloseAcknowledgement = async (
		attachment: CliLifecycleAttachment,
	): Promise<CliLifecycleResult<undefined>> => {
		const result = await destroyProvenOwnedTmuxPane(tmux, attachment.pane);
		if (result.status === "absent") return { status: "closed", value: undefined };
		return result.status === "unavailable"
			? result
			: {
					status: "uncertain",
					message: result.status === "owned" ? "owned pane was not destroyed" : result.message,
				};
	};
	const cleanup = async (
		attachment: CliLifecycleAttachment | OwnedTmuxPane,
		message: string,
	): Promise<CliLifecycleResult<never>> => {
		const pane = "pane" in attachment ? attachment.pane : attachment;
		const result = await fallbackBeforeCloseAcknowledgement({
			cwd: resolve(options.cwd),
			sessionRoot: "",
			sessionId: "",
			sessionPath: "",
			pane,
		});
		if (result.status === "closed") return { status: "uncertain", message };
		return { status: "uncertain", message: `${message}; owned pane cleanup is ${result.status}: ${result.message}` };
	};
	return {
		tmux,
		async open(resumePath, sessionRoot, resume) {
			const ownershipTag = newTmuxOwnershipTag();
			try {
				if (resume !== undefined) revalidateOpenedRegularSessionFile(resume);
			} catch (error) {
				return unavailable(error, "cannot revalidate canonical session JSONL before CLI resume");
			}
			const started = await tmux.run([
				"new-session",
				"-d",
				"-P",
				"-F",
				"#{pane_id}|#{pane_pid}",
				"-s",
				ownershipTag,
				"-c",
				options.cwd,
				"--",
				commandFor(options, resumePath, sessionRoot),
			]);
			if (started.exitCode !== 0)
				return { status: "unavailable", message: started.stderr.trim() || "tmux could not start CLI" };
			const [target, pidText, ...extra] = started.stdout.trim().split("|");
			if (extra.length !== 0 || !/^%\d+$/.test(target ?? "") || !/^\d+$/.test(pidText ?? ""))
				return { status: "uncertain", message: "tmux did not return a pane target and PID" };
			const pane: OwnedTmuxPane = {
				target,
				panePid: Number(pidText),
				ownershipTag,
				...(tmux instanceof BunTmuxCommandRunner ? { socketName: tmux.socketName } : {}),
			};
			const tagged = await tmux.run(["set-option", "-p", "-t", target, "@openwebui_gjc_owner", ownershipTag]);
			if (tagged.exitCode !== 0) {
				const result = await destroyProvisionalTmuxPane(tmux, pane);
				return {
					status: "uncertain",
					message:
						result.status === "absent"
							? "tmux pane was started but could not be ownership-tagged"
							: `tmux pane was started but could not be ownership-tagged; provisional pane cleanup is ${result.status}${"message" in result ? `: ${result.message}` : ""}`,
				};
			}
			const session = await readCliSession(tmux, options.cwd, captureLines, pane, endpointPublicationTimeoutMs);
			if (session.status !== "closed") return cleanup(pane, session.message);
			return { status: "closed", value: { sessionId: session.value, sessionPath: resumePath ?? "", pane } };
		},
		async readiness(attachment) {
			const ownership = await proveTmuxPaneOwnership(tmux, attachment.pane);
			if (ownership.status === "owned") return { status: "closed", value: undefined };
			return {
				status: ownership.status === "unavailable" ? "unavailable" : "uncertain",
				message: ownership.status === "absent" ? "owned tmux pane is absent" : ownership.message,
			};
		},
		fallbackBeforeCloseAcknowledgement,
		cleanup,
	};
}

function commandFor(options: CliLifecycleBackendOptions, resumePath: string | undefined, sessionRoot: string): string {
	return shellCommand([
		"env",
		...Object.entries(options.childEnvironment ?? {})
			.filter((entry): entry is [string, string] => entry[1] !== undefined)
			.map(([name, value]) => `${name}=${value}`),
		options.cliPath,
		...(options.cliArgs ?? []),
		...(resumePath === undefined
			? ["--session-dir", sessionRoot, "/session"]
			: ["--resume", resumePath, "--session-dir", sessionRoot]),
	]);
}

function shellCommand(argv: readonly string[]): string {
	return argv.map(value => `'${value.replaceAll("'", `"'"`)}'`).join(" ");
}
