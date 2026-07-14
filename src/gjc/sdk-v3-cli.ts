import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { resolveExistingOrProspectivePath } from "../security/paths";
import {
	parseJsonRecord,
	parseOperationResult,
	parseResolvedSession,
	parseSessionAuthority,
	type SdkRecord,
	type SdkSavedSession,
	type SdkSessionAuthority,
	SdkV3OperationError,
	SdkV3ProtocolError,
} from "./sdk-v3-protocol";

interface SdkCliOptions {
	readonly cliPath: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly launcherDir: string;
	readonly sessionRoot: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly timeoutMs?: number;
}

export class SdkV3Cli {
	readonly #options: SdkCliOptions;
	readonly #timeoutMs: number;

	constructor(options: SdkCliOptions) {
		this.#options = options;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
			throw new TypeError("SDK lifecycle CLI timeout must be positive");
		}
	}

	async createSession(idempotencyKey: string): Promise<SdkSessionAuthority> {
		const frame = await this.runGlobal("session.create", { cwd: this.#options.cwd }, idempotencyKey);
		return parseSessionAuthority(parseOperationResult(frame, "session.create"), "session.create result", {
			cwd: this.#options.cwd,
		});
	}

	async resolveSession(sessionId: string): Promise<SdkSavedSession> {
		const frame = await this.runGlobal("session.list", { cwd: this.#options.cwd, resolveSessionId: sessionId });
		const saved = parseResolvedSession(parseOperationResult(frame, "session.list"), sessionId);
		const [sessionRoot, savedPath] = await Promise.all([
			resolveExistingOrProspectivePath(this.#options.sessionRoot),
			resolveExistingOrProspectivePath(saved.path),
		]);
		const relativePath = relative(sessionRoot, savedPath);
		if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new SdkV3ProtocolError(
				"session.list result.savedSession",
				"saved session path is outside the SDK session root",
			);
		}
		return { ...saved, path: savedPath };
	}

	async resumeSession(sessionId: string, sessionPath: string, idempotencyKey: string): Promise<SdkSessionAuthority> {
		const frame = await this.runGlobal(
			"session.resume",
			{ cwd: this.#options.cwd, sessionId, sessionPath },
			idempotencyKey,
		);
		return parseSessionAuthority(parseOperationResult(frame, "session.resume"), "session.resume result", {
			cwd: this.#options.cwd,
			sessionId,
		});
	}

	async closeSession(sessionId: string, idempotencyKey: string): Promise<void> {
		const frame = await this.runGlobal("session.close", { sessionId }, idempotencyKey);
		parseOperationResult(frame, "session.close");
	}

	private async runGlobal(operation: string, input: SdkRecord, idempotencyKey?: string): Promise<SdkRecord> {
		return this.run(this.globalArgs(operation, idempotencyKey), input);
	}

	private globalArgs(operation: string, idempotencyKey?: string): readonly string[] {
		return [
			"daemon",
			"session",
			"global",
			"--op",
			operation,
			"--json-input-stdin",
			...(idempotencyKey === undefined ? [] : ["--idempotency-key", idempotencyKey]),
			"--agent-dir",
			this.#options.agentDir,
		];
	}

	private async run(args: readonly string[], input?: SdkRecord): Promise<SdkRecord> {
		await mkdir(this.#options.agentDir, { recursive: true });
		const environment = await this.isolatedEnvironment();
		const child = Bun.spawn(this.command(args), {
			cwd: this.#options.agentDir,
			env: environment,
			stdin: input === undefined ? "ignore" : Buffer.from(JSON.stringify(input)),
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		const deadlineTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 50);
		}, this.#timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]).finally(() => {
			clearTimeout(deadlineTimer);
			if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
		});
		if (timedOut) {
			throw new SdkV3OperationError("cli_timeout", `${args.join(" ")} exceeded the lifecycle deadline`);
		}
		return parseCliOutput(stdout, stderr, exitCode, args.join(" "));
	}

	private async isolatedEnvironment(): Promise<Readonly<Record<string, string | undefined>>> {
		const extension = extname(this.#options.cliPath);
		if (![".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extension)) {
			if (/\s/.test(this.#options.cliPath)) {
				throw new SdkV3OperationError("invalid_input", "SDK CLI path cannot contain whitespace");
			}
			return {
				...this.#options.environment,
				GJC_SDK_SESSION_COMMAND: `${this.#options.cliPath} sdk session-host-internal`,
			};
		}
		const launcher = join(this.#options.launcherDir, "sdk-session-host");
		if (/\s/.test(launcher)) {
			throw new SdkV3OperationError("invalid_input", "SDK launcher directory cannot contain whitespace");
		}
		let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const launcherParent = dirname(this.#options.launcherDir);
			if ((await realpath(launcherParent)) !== launcherParent) {
				throw new SdkV3OperationError("invalid_input", "SDK launcher directory must be private");
			}
			try {
				await mkdir(this.#options.launcherDir, { mode: 0o700 });
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			}
			directoryHandle = await open(
				this.#options.launcherDir,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			const directory = await directoryHandle.stat();
			if (!directory.isDirectory() || (await realpath(this.#options.launcherDir)) !== this.#options.launcherDir) {
				throw new SdkV3OperationError("invalid_input", "SDK launcher directory must be private");
			}
			await directoryHandle.chmod(0o700);
		} catch (error) {
			await directoryHandle?.close();
			throwLauncherFileSystemError(error, "SDK launcher directory must be private");
		}
		if (directoryHandle === undefined) {
			throw new SdkV3OperationError("invalid_input", "SDK launcher directory must be private");
		}
		const temporaryLauncher = join(this.#options.launcherDir, `.sdk-session-host.${randomUUID()}.tmp`);
		let launcherHandle: Awaited<ReturnType<typeof open>> | undefined;
		let published = false;
		try {
			launcherHandle = await open(
				temporaryLauncher,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				0o600,
			);
			const launcherEntry = await launcherHandle.stat();
			if (!launcherEntry.isFile() || launcherEntry.nlink !== 1) {
				throw new SdkV3OperationError("invalid_input", "SDK session launcher must be a private regular file");
			}
			await launcherHandle.writeFile(
				`#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-env-file --config=/dev/null ${shellQuote(this.#options.cliPath)} sdk session-host-internal "$@"\n`,
			);
			await launcherHandle.sync();
			await launcherHandle.chmod(0o700);
			await launcherHandle.sync();
			await launcherHandle.close();
			launcherHandle = undefined;
			await rename(temporaryLauncher, launcher);
			published = true;
			await directoryHandle.sync();
		} catch (error) {
			throwLauncherFileSystemError(error, "SDK session launcher must be a private regular file");
		} finally {
			try {
				await launcherHandle?.close();
			} finally {
				try {
					if (!published) {
						try {
							await unlink(temporaryLauncher);
						} catch (error) {
							if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
								throwLauncherFileSystemError(error, "SDK session launcher could not be cleaned up");
							}
						}
					}
				} finally {
					await directoryHandle.close();
				}
			}
		}
		return {
			...this.#options.environment,
			GJC_SDK_SESSION_COMMAND: launcher,
		};
	}

	private command(args: readonly string[]): string[] {
		const extension = extname(this.#options.cliPath);
		const prefix = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extension)
			? [process.execPath, "--no-env-file", "--config=/dev/null", this.#options.cliPath]
			: [this.#options.cliPath];
		return [...prefix, ...args];
	}
}

function throwLauncherFileSystemError(error: unknown, message: string): never {
	if (error instanceof SdkV3OperationError) throw error;
	if (error instanceof Error && "code" in error && typeof error.code === "string") {
		throw new SdkV3OperationError("invalid_input", message);
	}
	throw error;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseCliOutput(stdout: string, stderr: string, exitCode: number, boundary: string): SdkRecord {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		throw new SdkV3OperationError(
			"cli_failed",
			`${boundary} produced no JSON${stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`}`,
		);
	}
	const frame = parseJsonRecord(trimmed, `${boundary} CLI output`);
	if (exitCode !== 0 && frame.ok !== false) {
		throw new SdkV3OperationError("cli_failed", `${boundary} exited ${exitCode}: ${stderr.trim()}`);
	}
	return frame;
}
