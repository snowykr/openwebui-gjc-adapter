import { dirname, isAbsolute, resolve } from "node:path";
import {
	proveClosedAfterAcknowledgement,
	requestExit,
	requestExitAndProveClosedAfterAcknowledgement,
} from "./cli-lifecycle-close";
import { readCliSession } from "./cli-lifecycle-readiness";
import {
	type CliColdResumeInput,
	type CliCreateInput,
	type CliLifecycleAttachment,
	type CliLifecycleBackendOptions,
	type CliLifecycleResult,
	unavailable,
} from "./cli-lifecycle-types";
import { openAbsoluteRegularSessionFile, revalidateOpenedRegularSessionFile } from "./session-file";
import {
	discoverFreshGjcSessionFile,
	type LoadedGjcSessionFile,
	loadGjcSessionFile,
	snapshotGjcSessionFiles,
} from "./session-loader";
import {
	BunTmuxCommandRunner,
	destroyProvenOwnedTmuxPane,
	destroyProvisionalTmuxPane,
	newTmuxOwnershipTag,
	type OwnedTmuxPane,
	proveTmuxPaneOwnership,
	type TmuxCommandRunner,
} from "./tmux-ownership";

export type {
	CliColdResumeInput,
	CliCreateInput,
	CliLifecycleAttachment,
	CliLifecycleBackendOptions,
	CliLifecycleResult,
} from "./cli-lifecycle-types";
export { MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS } from "./cli-lifecycle-types";

/** Endpoint-less recovery backend. It owns only a private tagged tmux pane. */
export class CliLifecycleBackend {
	readonly #tmux: TmuxCommandRunner;
	readonly #captureLines: number;
	constructor(private readonly options: CliLifecycleBackendOptions) {
		this.#tmux = options.tmux ?? new BunTmuxCommandRunner(undefined, options.tmuxSocket);
		this.#captureLines = options.captureLines ?? 128;
		if (!Number.isInteger(this.#captureLines) || this.#captureLines < 1 || this.#captureLines > 1_000)
			throw new TypeError("captureLines must be an integer between 1 and 1000");
	}

	async create(input: CliCreateInput): Promise<CliLifecycleResult<CliLifecycleAttachment>> {
		if (!isAbsolute(input.sessionRoot)) return { status: "unavailable", message: "session root must be absolute" };
		let baseline: ReadonlySet<string>;
		try {
			baseline = await snapshotGjcSessionFiles(resolve(input.sessionRoot));
		} catch (error) {
			return unavailable(error, "cannot snapshot session root");
		}
		const opened = await this.open(undefined, resolve(input.sessionRoot));
		if (opened.status !== "closed") return opened;
		try {
			const transcript = await discoverFreshGjcSessionFile(
				resolve(input.sessionRoot),
				baseline,
				opened.value.sessionId,
				this.options.cwd,
			);
			return {
				status: "closed",
				value: {
					...opened.value,
					cwd: resolve(this.options.cwd),
					sessionRoot: resolve(input.sessionRoot),
					sessionPath: transcript.filePath,
				},
			};
		} catch (error) {
			return this.cleanupUncertain(
				opened.value,
				error instanceof Error ? error.message : "fresh CLI transcript cannot be proven",
			);
		}
	}

	async coldResume(input: CliColdResumeInput): Promise<CliLifecycleResult<CliLifecycleAttachment>> {
		let resume: ReturnType<typeof openAbsoluteRegularSessionFile> | undefined;
		let initial: LoadedGjcSessionFile;
		try {
			resume = openAbsoluteRegularSessionFile(input.existingSessionPath);
			initial = await loadGjcSessionFile(resume.canonicalPath);
		} catch (error) {
			resume?.close();
			return unavailable(error, "cannot open canonical session JSONL");
		}
		if (resume === undefined) return { status: "unavailable", message: "cannot open canonical session JSONL" };
		try {
			const opened = await this.open(resume.canonicalPath, dirname(resume.canonicalPath), resume);
			if (opened.status !== "closed") return opened;
			try {
				const final = await loadGjcSessionFile(resume.canonicalPath);
				revalidateOpenedRegularSessionFile(resume);
				if (opened.value.sessionId === initial.header.id && final.header.id === initial.header.id) {
					return {
						status: "closed",
						value: {
							...opened.value,
							cwd: resolve(this.options.cwd),
							sessionRoot: dirname(resume.canonicalPath),
							sessionPath: resume.canonicalPath,
						},
					};
				}
				return this.cleanupUncertain(
					opened.value,
					"CLI /session identity does not match canonical resumed JSONL header",
				);
			} catch (error) {
				return this.cleanupUncertain(
					opened.value,
					error instanceof Error ? error.message : "resumed canonical JSONL could not be re-read",
				);
			}
		} finally {
			resume.close();
		}
	}

	async readiness(attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>> {
		const ownership = await proveTmuxPaneOwnership(this.#tmux, attachment.pane);
		if (ownership.status === "owned") return { status: "closed", value: undefined };
		return {
			status: ownership.status === "unavailable" ? "unavailable" : "uncertain",
			message: ownership.status === "absent" ? "owned tmux pane is absent" : ownership.message,
		};
	}

	/** Sends `/exit` after exact pane ownership has been established. */
	async requestExit(attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>> {
		return requestExit(this.#tmux, attachment);
	}

	/** After public SDK acknowledgement, requests `/exit` and proves endpoint and original PID absence without killing. */
	async requestExitAndProveClosedAfterAcknowledgement(
		attachment: CliLifecycleAttachment,
		timeoutMs = 1_000,
	): Promise<CliLifecycleResult<undefined>> {
		return requestExitAndProveClosedAfterAcknowledgement(
			this.#tmux,
			this.options.cwd,
			this.options.isProcessAlive,
			attachment,
			timeoutMs,
		);
	}

	/** Observes post-ack closure without sending control or kill signals. */
	async proveClosedAfterAcknowledgement(
		attachment: CliLifecycleAttachment,
		timeoutMs = 1_000,
	): Promise<CliLifecycleResult<undefined>> {
		return proveClosedAfterAcknowledgement(
			this.#tmux,
			this.options.cwd,
			this.options.isProcessAlive,
			attachment,
			timeoutMs,
		);
	}

	async fallbackBeforeCloseAcknowledgement(
		attachment: CliLifecycleAttachment,
	): Promise<CliLifecycleResult<undefined>> {
		const result = await destroyProvenOwnedTmuxPane(this.#tmux, attachment.pane);
		if (result.status === "absent") return { status: "closed", value: undefined };
		return result.status === "unavailable"
			? result
			: {
					status: "uncertain",
					message: result.status === "owned" ? "owned pane was not destroyed" : result.message,
				};
	}

	private async open(
		resumePath: string | undefined,
		sessionRoot: string,
		resume: ReturnType<typeof openAbsoluteRegularSessionFile> | undefined = undefined,
	): Promise<CliLifecycleResult<Omit<CliLifecycleAttachment, "cwd" | "sessionRoot">>> {
		const ownershipTag = newTmuxOwnershipTag();
		const command = shellCommand([
			"env",
			...Object.entries(this.options.childEnvironment ?? {})
				.filter((entry): entry is [string, string] => entry[1] !== undefined)
				.map(([name, value]) => `${name}=${value}`),
			this.options.cliPath,
			...(this.options.cliArgs ?? []),
			...(resumePath === undefined
				? ["--session-dir", sessionRoot]
				: ["--resume", resumePath, "--session-dir", sessionRoot]),
		]);
		try {
			if (resume !== undefined) revalidateOpenedRegularSessionFile(resume);
		} catch (error) {
			return unavailable(error, "cannot revalidate canonical session JSONL before CLI resume");
		}
		const started = await this.#tmux.run([
			"new-session",
			"-d",
			"-P",
			"-F",
			"#{pane_id}|#{pane_pid}",
			"-s",
			ownershipTag,
			"-c",
			this.options.cwd,
			"--",
			command,
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
			...(this.#tmux instanceof BunTmuxCommandRunner ? { socketName: this.#tmux.socketName } : {}),
		};
		const tagged = await this.#tmux.run(["set-option", "-p", "-t", target, "@openwebui_gjc_owner", ownershipTag]);
		if (tagged.exitCode !== 0) {
			const cleanup = await destroyProvisionalTmuxPane(this.#tmux, pane);
			return {
				status: "uncertain",
				message:
					cleanup.status === "absent"
						? "tmux pane was started but could not be ownership-tagged"
						: `tmux pane was started but could not be ownership-tagged; provisional pane cleanup is ${cleanup.status}${"message" in cleanup ? `: ${cleanup.message}` : ""}`,
			};
		}
		const session = await readCliSession(this.#tmux, this.options.cwd, this.#captureLines, pane);
		if (session.status !== "closed") return this.cleanupUncertain(pane, session.message);
		return { status: "closed", value: { sessionId: session.value, sessionPath: resumePath ?? "", pane } };
	}

	private async cleanupUncertain(
		attachment: CliLifecycleAttachment | OwnedTmuxPane,
		message: string,
	): Promise<CliLifecycleResult<never>> {
		const pane = "pane" in attachment ? attachment.pane : attachment;
		const cleanup = await this.fallbackBeforeCloseAcknowledgement({
			cwd: resolve(this.options.cwd),
			sessionRoot: "",
			sessionId: "",
			sessionPath: "",
			pane,
		});
		if (cleanup.status === "closed") return { status: "uncertain", message };
		return {
			status: "uncertain",
			message: `${message}; owned pane cleanup is ${cleanup.status}: ${cleanup.message}`,
		};
	}
}

function shellCommand(argv: readonly string[]): string {
	return argv.map(value => `'${value.replaceAll("'", `"'"'`)}'`).join(" ");
}
