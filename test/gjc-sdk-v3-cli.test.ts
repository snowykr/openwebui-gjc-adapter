import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliLifecycleBackend } from "../src/gjc/cli-lifecycle-backend";
import type { TmuxCommandResult, TmuxCommandRunner } from "../src/gjc/tmux-ownership";

describe("endpoint-less CLI lifecycle boundary", () => {
	test("creates a tagged CLI session and discovers its id through /session", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				childEnvironment: {
					HOME: "/runtime-home",
					GJC_CONFIG_DIR: ".gjc",
					GJC_CODING_AGENT_DIR: "/runtime-home/.gjc/agent",
				},
				tmux,
			});

			const result = await backend.create({ sessionRoot });

			expect(result).toMatchObject({
				status: "closed",
				value: { sessionId: "session-1", sessionPath: join(sessionRoot, "session-1.jsonl") },
			});
			if (result.status !== "closed") throw new TypeError("fixture must create an attachment");
			expect(tmux.calls).toContainEqual(["send-keys", "-t", result.value.pane.target, "/session", "Enter"]);
			expect(tmux.calls[0]).toEqual([
				"new-session",
				"-d",
				"-P",
				"-F",
				"#{pane_id}|#{pane_pid}",
				"-s",
				expect.stringMatching(/^openwebui-gjc-/),
				"-c",
				sessionRoot,
				"--",
				`'env' 'HOME=/runtime-home' 'GJC_CONFIG_DIR=.gjc' 'GJC_CODING_AGENT_DIR=/runtime-home/.gjc/agent' '/opt/gjc' '--session-dir' '${sessionRoot}'`,
			]);
		}));
	test("sends /session exactly once across capture rollover and rejects ambiguous fresh captures", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot, undefined, { rollover: true });
			const backend = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux });
			await expect(backend.create({ sessionRoot })).resolves.toMatchObject({
				status: "closed",
				value: { sessionId: "session-1" },
			});
			expect(tmux.calls.filter(call => call[0] === "send-keys" && call.at(-2) === "/session")).toHaveLength(1);

			const ambiguous = new FakeTmuxRunner(sessionRoot, undefined, { ambiguous: true });
			const second = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux: ambiguous });
			await expect(second.create({ sessionRoot })).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringContaining("duplicate or ambiguous"),
			});
			expect(ambiguous.calls.filter(call => call[0] === "send-keys" && call.at(-2) === "/session")).toHaveLength(1);
		}));
	test("resumes with absolute JSONL and its parent session directory", async () =>
		withSessionRoot(async sessionRoot => {
			const sessionPath = join(sessionRoot, "session-1.jsonl");
			await writeFile(sessionPath, sessionJsonl("session-1", sessionRoot));
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux });

			const result = await backend.coldResume({ existingSessionPath: sessionPath });

			expect(result).toMatchObject({ status: "closed", value: { sessionId: "session-1", sessionPath } });
			expect(tmux.calls[0]?.at(-1)).toBe(
				`'env' '/opt/gjc' '--resume' '${sessionPath}' '--session-dir' '${sessionRoot}'`,
			);
		}));
	test("rejects a resume path replaced by rename after its descriptor is opened", async () =>
		withSessionRoot(async sessionRoot => {
			const sessionPath = join(sessionRoot, "session-1.jsonl");
			const replacement = join(sessionRoot, "replacement.jsonl");
			await writeFile(sessionPath, sessionJsonl("session-1", sessionRoot));
			await writeFile(replacement, sessionJsonl("session-1", sessionRoot));
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux: new FakeTmuxRunner(sessionRoot, async () => {
					await rename(replacement, sessionPath);
				}),
			});

			await expect(backend.coldResume({ existingSessionPath: sessionPath })).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringContaining("changed during CLI resume"),
			});
		}));
	test("rejects a resume path replaced by symlink after its descriptor is opened", async () =>
		withSessionRoot(async sessionRoot => {
			const sessionPath = join(sessionRoot, "session-1.jsonl");
			const replacement = join(sessionRoot, "replacement.jsonl");
			await writeFile(sessionPath, sessionJsonl("session-1", sessionRoot));
			await writeFile(replacement, sessionJsonl("session-1", sessionRoot));
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux: new FakeTmuxRunner(sessionRoot, async () => {
					await rm(sessionPath);
					await symlink(replacement, sessionPath);
				}),
			});

			await expect(backend.coldResume({ existingSessionPath: sessionPath })).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringContaining("ELOOP"),
			});
		}));

	test("accepts an owned CLI exit request without treating it as a public close acknowledgement", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux });
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");

			const result = await backend.requestExit(created.value);

			expect(result).toEqual({ status: "closed", value: undefined });
			expect(tmux.calls).toContainEqual(["send-keys", "-t", created.value.pane.target, "/exit", "Enter"]);
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		}));
	test("uses /exit then proves closure after a public SDK acknowledgement without post-ack kill fallback", async () => {
		await withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot, undefined, { exitClosesSession: true });
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => false,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");

			await expect(backend.requestExitAndProveClosedAfterAcknowledgement(created.value, 1)).resolves.toEqual({
				status: "closed",
				value: undefined,
			});
			expect(tmux.calls).toContainEqual(["send-keys", "-t", created.value.pane.target, "/exit", "Enter"]);
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		});

		await withSessionRoot(async sessionRoot => {
			const unresolvedTmux = new FakeTmuxRunner(sessionRoot);
			const unresolved = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux: unresolvedTmux });
			const unresolvedCreated = await unresolved.create({ sessionRoot });
			if (unresolvedCreated.status !== "closed") throw new TypeError("fixture must create an attachment");

			await expect(
				unresolved.requestExitAndProveClosedAfterAcknowledgement(unresolvedCreated.value, 1),
			).resolves.toMatchObject({
				status: "uncertain",
			});
			expect(unresolvedTmux.calls).toContainEqual([
				"send-keys",
				"-t",
				unresolvedCreated.value.pane.target,
				"/exit",
				"Enter",
			]);
			expect(unresolvedTmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		});
	});
	test("proves idempotent close after acknowledgement when tmux has already vanished", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => false,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
			tmux.setOwnershipState("unavailable");
			await rm(join(sessionRoot, ".gjc", "state", "sdk", "session-1.json"));

			await expect(backend.requestExitAndProveClosedAfterAcknowledgement(created.value, 1)).resolves.toEqual({
				status: "closed",
				value: undefined,
			});
			expect(tmux.calls.some(call => call[0] === "send-keys" && call.at(-2) === "/exit")).toBe(false);
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		}));
	test("does not treat vanished tmux as closure proof while the endpoint or original PID remains live", async () => {
		await withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => false,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
			tmux.setOwnershipState("unavailable");

			await expect(backend.requestExitAndProveClosedAfterAcknowledgement(created.value, 1)).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringMatching(
					/server exited unexpectedly; closure proof is uncertain: session endpoint is still available/,
				),
			});
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		});
		await withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => true,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
			tmux.setOwnershipState("unavailable");
			await rm(join(sessionRoot, ".gjc", "state", "sdk", "session-1.json"));

			await expect(backend.requestExitAndProveClosedAfterAcknowledgement(created.value, 1)).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringContaining("original tmux pane process is still running"),
			});
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		});
	});

	test("uses CLI cleanup only before a public close acknowledgement and only for its owned pane", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux });
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");

			expect(await backend.fallbackBeforeCloseAcknowledgement(created.value)).toEqual({
				status: "closed",
				value: undefined,
			});
			expect(tmux.calls).toContainEqual(["kill-pane", "-t", created.value.pane.target]);
		}));
	test("proves close after endpoint disappearance when the private tmux server cannot report its pane", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => false,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
			tmux.makeOwnershipUnobservable();
			await rm(join(sessionRoot, ".gjc", "state", "sdk", "session-1.json"));

			await expect(backend.proveClosedAfterAcknowledgement(created.value, 1)).resolves.toEqual({
				status: "closed",
				value: undefined,
			});
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		}));
	test("polls non-owned panes until the original PID is absent after acknowledgement", async () => {
		for (const state of ["absent", "replaced", "uncertain", "unavailable"] as const) {
			await withSessionRoot(async sessionRoot => {
				let livenessProbes = 0;
				const tmux = new FakeTmuxRunner(sessionRoot);
				const backend = new CliLifecycleBackend({
					cliPath: "/opt/gjc",
					cwd: sessionRoot,
					tmux,
					isProcessAlive: () => ++livenessProbes < 3,
				});
				const created = await backend.create({ sessionRoot });
				if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
				tmux.setOwnershipState(state);
				await rm(join(sessionRoot, ".gjc", "state", "sdk", "session-1.json"));

				await expect(backend.proveClosedAfterAcknowledgement(created.value, 150)).resolves.toEqual({
					status: "closed",
					value: undefined,
				});
				expect(livenessProbes).toBe(3);
				expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
			});
		}
	});
	test("times out uncertain when the original PID remains alive after acknowledgement", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => true,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
			tmux.setOwnershipState("absent");
			await rm(join(sessionRoot, ".gjc", "state", "sdk", "session-1.json"));

			await expect(backend.proveClosedAfterAcknowledgement(created.value, 1)).resolves.toEqual({
				status: "uncertain",
				message: "original tmux pane process is still running",
			});
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		}));
	test("requires endpoint disappearance and distinguishes liveness-query unavailability", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => false,
			});
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");
			tmux.setOwnershipState("absent");
			await expect(backend.proveClosedAfterAcknowledgement(created.value, 1)).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringContaining("session endpoint is still available"),
			});
			await rm(join(sessionRoot, ".gjc", "state", "sdk", "session-1.json"));
			const unavailable = new CliLifecycleBackend({
				cliPath: "/opt/gjc",
				cwd: sessionRoot,
				tmux,
				isProcessAlive: () => {
					throw new Error("process table unavailable");
				},
			});
			await expect(unavailable.proveClosedAfterAcknowledgement(created.value, 1)).resolves.toEqual({
				status: "unavailable",
				message: "process table unavailable",
			});
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		}));
	test("does not kill an owned pane after a close acknowledgement when closure remains unproven", async () =>
		withSessionRoot(async sessionRoot => {
			const tmux = new FakeTmuxRunner(sessionRoot);
			const backend = new CliLifecycleBackend({ cliPath: "/opt/gjc", cwd: sessionRoot, tmux });
			const created = await backend.create({ sessionRoot });
			if (created.status !== "closed") throw new TypeError("fixture must create an attachment");

			await expect(backend.proveClosedAfterAcknowledgement(created.value, 1)).resolves.toMatchObject({
				status: "uncertain",
				message: expect.stringContaining("owned tmux pane is still running"),
			});
			expect(tmux.calls.some(call => call[0] === "kill-pane")).toBe(false);
		}));
});
describe("installed released CLI parser", () => {
	test("advertises resume and session directory argv without a provider prompt", async () => {
		const cli = Bun.which("gjc");
		if (cli === null) return;
		const child = Bun.spawn([cli, "--help"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("--resume=<value>");
		expect(stdout).toContain("--session-dir=<value>");
	});
});

async function withSessionRoot(run: (sessionRoot: string) => Promise<void>): Promise<void> {
	const sessionRoot = await mkdtemp(join(tmpdir(), "gjc-sdk-v3-cli-"));
	try {
		await run(sessionRoot);
	} finally {
		await rm(sessionRoot, { recursive: true, force: true });
	}
}

function sessionJsonl(id: string, cwd: string): string {
	return `${JSON.stringify({ type: "session", id, timestamp: "2026-07-19T00:00:00.000Z", cwd })}\n`;
}

class FakeTmuxRunner implements TmuxCommandRunner {
	readonly calls: string[][] = [];
	constructor(
		private readonly sessionRoot: string,
		private readonly afterOpen?: () => Promise<void>,
		private readonly behavior: {
			readonly rollover?: boolean;
			readonly ambiguous?: boolean;
			readonly exitClosesSession?: boolean;
		} = {},
	) {}
	private ownershipTag = "";
	private exists = true;
	private sessionRequested = false;
	private ownershipState: "normal" | "absent" | "replaced" | "uncertain" | "unavailable" = "normal";
	makeOwnershipUnobservable(): void {
		this.ownershipState = "uncertain";
	}
	setOwnershipState(state: "absent" | "replaced" | "uncertain" | "unavailable"): void {
		this.ownershipState = state;
	}
	async run(argv: readonly string[]): Promise<TmuxCommandResult> {
		this.calls.push([...argv]);
		switch (argv[0]) {
			case "new-session": {
				const cwd = argv[argv.indexOf("-c") + 1];
				if (cwd === undefined) throw new TypeError("tmux session cwd is required");
				await writeFile(join(this.sessionRoot, "session-1.jsonl"), sessionJsonl("session-1", cwd));
				await publishSdkSessionEndpoint(cwd, "session-1");
				await this.afterOpen?.();
				return { exitCode: 0, stdout: "%4|123\n", stderr: "" };
			}
			case "set-option":
				this.ownershipTag = argv.at(-1) ?? "";
				return { exitCode: 0, stdout: "", stderr: "" };
			case "display-message":
				if (argv.at(-1) === "#{history_size}|#{cursor_y}") {
					return {
						exitCode: 0,
						stdout: this.sessionRequested ? (this.behavior.ambiguous ? "0|3\n" : "0|2\n") : "0|1\n",
						stderr: "",
					};
				}
				if (argv.at(-1) === "#{pane_dead}|#{pane_pid}|#{pane_current_command}") {
					return { exitCode: 0, stdout: "0|123|gjc\n", stderr: "" };
				}
				switch (this.ownershipState) {
					case "absent":
						return { exitCode: 1, stdout: "", stderr: "can't find pane" };
					case "replaced":
						return { exitCode: 0, stdout: `%4|124|${this.ownershipTag}\n`, stderr: "" };
					case "uncertain":
						return { exitCode: 0, stdout: "", stderr: "" };
					case "unavailable":
						return { exitCode: 1, stdout: "", stderr: "server exited unexpectedly" };
					case "normal":
						return this.exists
							? { exitCode: 0, stdout: `%4|123|${this.ownershipTag}\n`, stderr: "" }
							: { exitCode: 1, stdout: "", stderr: "can't find pane" };
				}
				return { exitCode: 1, stdout: "", stderr: "unsupported ownership state" };
			case "send-keys":
				this.sessionRequested ||= argv.at(-2) === "/session";
				if (argv.at(-2) === "/exit" && this.behavior.exitClosesSession) {
					this.exists = false;
					await rm(join(this.sessionRoot, ".gjc", "state", "sdk", "session-1.json"));
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			case "capture-pane":
				return {
					exitCode: 0,
					stdout: this.sessionRequested
						? this.behavior.rollover
							? "new screen\nSession ID: session-1\n"
							: this.behavior.ambiguous
								? "ready\nSession ID: session-1\nSession ID: session-2\n"
								: "ready\nSession ID: session-1\n"
						: this.behavior.rollover
							? "old screen\n"
							: "ready\n",
					stderr: "",
				};
			case "kill-pane":
				this.exists = false;
				return { exitCode: 0, stdout: "", stderr: "" };
			default:
				return { exitCode: 0, stdout: "", stderr: "" };
		}
	}
}
async function publishSdkSessionEndpoint(cwd: string, sessionId: string): Promise<void> {
	const directory = join(cwd, ".gjc", "state", "sdk");
	const now = Date.now();
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, `${sessionId}.json`),
		`${JSON.stringify({
			version: 1,
			sessionId,
			pid: process.pid,
			host: "127.0.0.1",
			port: 1234,
			url: "ws://127.0.0.1:1234",
			token: "fixture-token",
			startedAt: now,
			updatedAt: now,
			stale: false,
		})}\n`,
	);
}
