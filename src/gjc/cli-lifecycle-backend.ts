import { dirname, isAbsolute, resolve } from "node:path";
import { createCliLifecycleBackendRuntime } from "./cli-lifecycle-backend-runtime";
import {
	proveClosedAfterAcknowledgement,
	requestExit,
	requestExitAndProveClosedAfterAcknowledgement,
} from "./cli-lifecycle-close";
import type {
	CliColdResumeInput,
	CliCreateInput,
	CliLifecycleAttachment,
	CliLifecycleBackendOptions,
	CliLifecycleResult,
} from "./cli-lifecycle-types";
import { unavailable } from "./cli-lifecycle-types";
import { openAbsoluteRegularSessionFile, revalidateOpenedRegularSessionFile } from "./session-file";
import {
	discoverFreshGjcSessionFile,
	type LoadedGjcSessionFile,
	loadGjcSessionFile,
	snapshotGjcSessionFiles,
} from "./session-loader";

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
	readonly #runtime;
	constructor(private readonly options: CliLifecycleBackendOptions) {
		this.#runtime = createCliLifecycleBackendRuntime(options);
	}

	async create(input: CliCreateInput): Promise<CliLifecycleResult<CliLifecycleAttachment>> {
		if (!isAbsolute(input.sessionRoot)) return { status: "unavailable", message: "session root must be absolute" };
		let baseline: ReadonlySet<string>;
		try {
			baseline = await snapshotGjcSessionFiles(resolve(input.sessionRoot));
		} catch (error) {
			return unavailable(error, "cannot snapshot session root");
		}
		const opened = await this.#runtime.open(undefined, resolve(input.sessionRoot));
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
			return this.#runtime.cleanup(
				opened.value,
				error instanceof Error ? error.message : "fresh CLI transcript cannot be proven",
			);
		}
	}

	/** Creates an endpoint-backed session before its first persisted CLI turn. */
	async createEphemeral(input: CliCreateInput): Promise<CliLifecycleResult<CliLifecycleAttachment>> {
		if (!isAbsolute(input.sessionRoot)) return { status: "unavailable", message: "session root must be absolute" };
		const opened = await this.#runtime.open(undefined, resolve(input.sessionRoot));
		if (opened.status !== "closed") return opened;
		return {
			status: "closed",
			value: {
				...opened.value,
				cwd: resolve(this.options.cwd),
				sessionRoot: resolve(input.sessionRoot),
				sessionPath: "",
			},
		};
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
		try {
			const opened = await this.#runtime.open(resume.canonicalPath, dirname(resume.canonicalPath), resume);
			if (opened.status !== "closed") return opened;
			try {
				const final = await loadGjcSessionFile(resume.canonicalPath);
				revalidateOpenedRegularSessionFile(resume);
				if (opened.value.sessionId === initial.header.id && final.header.id === initial.header.id)
					return {
						status: "closed",
						value: {
							...opened.value,
							cwd: resolve(this.options.cwd),
							sessionRoot: dirname(resume.canonicalPath),
							sessionPath: resume.canonicalPath,
						},
					};
				return this.#runtime.cleanup(
					opened.value,
					"CLI /session identity does not match canonical resumed JSONL header",
				);
			} catch (error) {
				return this.#runtime.cleanup(
					opened.value,
					error instanceof Error ? error.message : "resumed canonical JSONL could not be re-read",
				);
			}
		} finally {
			resume.close();
		}
	}

	async readiness(attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>> {
		return this.#runtime.readiness(attachment);
	}
	async requestExit(attachment: CliLifecycleAttachment): Promise<CliLifecycleResult<undefined>> {
		return requestExit(this.#runtime.tmux, attachment);
	}
	async requestExitAndProveClosedAfterAcknowledgement(
		attachment: CliLifecycleAttachment,
		timeoutMs = 1_000,
	): Promise<CliLifecycleResult<undefined>> {
		return requestExitAndProveClosedAfterAcknowledgement(
			this.#runtime.tmux,
			this.options.cwd,
			this.options.isProcessAlive,
			attachment,
			timeoutMs,
		);
	}
	async proveClosedAfterAcknowledgement(
		attachment: CliLifecycleAttachment,
		timeoutMs = 1_000,
	): Promise<CliLifecycleResult<undefined>> {
		return proveClosedAfterAcknowledgement(
			this.#runtime.tmux,
			this.options.cwd,
			this.options.isProcessAlive,
			attachment,
			timeoutMs,
		);
	}
	async fallbackBeforeCloseAcknowledgement(
		attachment: CliLifecycleAttachment,
	): Promise<CliLifecycleResult<undefined>> {
		return this.#runtime.fallbackBeforeCloseAcknowledgement(attachment);
	}
}
