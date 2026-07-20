#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SdkClient } from "@gajae-code/coding-agent/sdk";
import { apiKey, providerResponse, writeLocalProviderConfig } from "./gjc-release-compat-fixtures";
import {
	awaitLifecycleTermination,
	awaitTmuxTermination,
	closeTmux,
	closeWithPublicSdkProof,
	exitAndObservePostCloseFailure,
	exitTmux,
} from "./gjc-release-compat-lifecycle";
import {
	branchEntryId,
	openSessionDashboard,
	promptAndAwaitTerminal,
	rediscoverSessionId,
	sessionFromFilesystem,
	sessionIdFrom,
	sessionIdFromEndpoint,
	validateCurrentModel,
} from "./gjc-release-compat-runtime";
import { connectFor, lifecycleSuccessor } from "./gjc-release-compat-sdk";

const root = requiredArgument("--root");
const cli = requiredArgument("--gjc");
const workspace = join(root, "workspace");
const sessionDir = join(root, "sessions");
const tmuxSession = `gjc-compat-${crypto.randomUUID()}`;
const observed: Record<string, unknown> = { schema: 1, startedAt: new Date().toISOString(), operations: [] };
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: providerResponse });
const providerUrl = `http://127.0.0.1:${provider.port}`;
const cliEnvironment = [
	"env",
	"-i",
	`PATH=${process.env.PATH ?? ""}`,
	`TERM=${process.env.TERM ?? "xterm-256color"}`,
	`HOME=${root}`,
	`GJC_CODING_AGENT_DIR=${join(root, ".gjc", "agent")}`,
	`GJC_COMPAT_LOCAL_API_KEY=${apiKey}`,
	"NO_PROXY=*",
];

await mkdir(workspace, { recursive: true });
await mkdir(sessionDir, { recursive: true });
await writeLocalProviderConfig(join(root, ".gjc", "agent"), providerUrl);
const cliVersion = await releasedCliVersion(cli);
observed.cliVersion = cliVersion;
const startupArgs = startupArguments(cliVersion);
let client: SdkClient | undefined;
let publicCloseInvoked = false;
let sdkLogicalClose: Record<string, unknown> | undefined;
try {
	await start(tmuxSession, ["--session-dir", sessionDir, ...startupArgs]);
	const bootstrap = await openSessionDashboard(tmuxSession, run);
	let sessionId = bootstrap.sessionId ?? (await sessionIdFromEndpoint(workspace));
	client = await connectFor(workspace, sessionId);
	await observe("Q14", () => client!.query("session.metadata"));
	await observe("Q12", () => client!.query("workflow.gates.list"));
	const models = await observe("Q10", () => client!.query("models.list/current"));
	const thinkingSupported = await validateCurrentModel(client, models, observe);
	await observe("model.set", () => client!.control("model.set", { id: "compat-local/hermetic-model" }));
	observed.thinking = { supported: thinkingSupported, requested: "off" };
	if (thinkingSupported) await observe("thinking.set", () => client!.control("thinking.set", { level: "off" }));
	const initialTranscriptTurn = await promptAndAwaitTerminal(
		client,
		sessionId,
		"initial-transcript.turn.prompt",
		"Reply with initial-transcript-proof.",
		observe,
	);
	const initialSession = await sessionFromFilesystem(sessionDir, sessionId);
	let successor = await lifecycleSuccessor(client, "session.new", {}, workspace, observe, record, undefined);
	client = successor.client;
	sessionId = successor.sessionId;
	const createdSessionId = sessionId;
	if (createdSessionId === initialSession.sessionId)
		throw new Error("session.new did not produce a uniquely fresh session identity");
	const createdTranscriptTurn = await promptAndAwaitTerminal(
		client,
		sessionId,
		"created-transcript.turn.prompt",
		"Reply with created-transcript-proof.",
		observe,
	);
	const createdSession = await sessionFromFilesystem(sessionDir, createdSessionId);
	const createdTranscript = createdSession.transcript;
	observed.transcripts = {
		initial: {
			path: initialSession.transcript,
			sessionId: initialSession.sessionId,
			headerSessionId: initialSession.headerSessionId,
		},
		created: {
			path: createdTranscript,
			sessionId: createdSession.sessionId,
			headerSessionId: createdSession.headerSessionId,
		},
	};
	successor = await lifecycleSuccessor(
		client,
		"session.resume",
		{ id: initialSession.transcript },
		workspace,
		observe,
		record,
		initialSession.sessionId,
	);
	client = successor.client;
	sessionId = successor.sessionId;
	successor = await lifecycleSuccessor(
		client,
		"session.switch",
		{ id: createdTranscript },
		workspace,
		observe,
		record,
		createdSession.sessionId,
	);
	client = successor.client;
	sessionId = successor.sessionId;
	const turn = await promptAndAwaitTerminal(client, sessionId, "turn.prompt", "Reply with compatibility-ok.", observe);
	await client.close();
	client = await connectFor(workspace, sessionId);
	await observe("post-turn.Q14", () => client!.query("session.metadata"));
	const entryId = await branchEntryId(workspace, sessionId, observe);
	const branch = await observe("session.branch", () => client!.control("session.branch", { entryId }));
	const branchSessionId = sessionIdFrom(branch) ?? (await rediscoverSessionId(workspace, sessionId));
	await client.close().catch(() => undefined);
	client = await connectFor(workspace, branchSessionId);
	await observe("branch.session.metadata", () => client!.query("session.metadata"));
	publicCloseInvoked = true;
	sdkLogicalClose = await closeWithPublicSdkProof(client, workspace, branchSessionId, tmuxSession, observe);
	client = undefined;
	await exitTmux(tmuxSession, run);
	const cliLifecycleTermination = await awaitLifecycleTermination(workspace, sdkLogicalClose.endpoint, tmuxSession);
	observed.close = { sdkLogicalClose, cliLifecycleTermination };
	if (createdSession.sessionId !== sessionId)
		throw new Error("created session transcript did not match the SDK endpoint");
	const resumedTarget = `${tmuxSession}-resume`;
	await start(resumedTarget, ["--resume", createdTranscript, "--session-dir", sessionDir, ...startupArgs]);
	const resumedBootstrap = await openSessionDashboard(resumedTarget, run);
	const resumedSessionId = resumedBootstrap.sessionId ?? (await sessionIdFromEndpoint(workspace));
	client = await connectFor(workspace, resumedSessionId);
	await observe("resume.session.metadata", () => client!.query("session.metadata"));
	const resumedTurn = await promptAndAwaitTerminal(
		client,
		resumedSessionId,
		"resume.turn.prompt",
		"Reply with post-resume-write-proof.",
		observe,
	);
	await observe("Q17", () => client!.query("session.last_assistant"));
	observed.terminals = {
		initialTranscript: initialTranscriptTurn.terminal,
		createdTranscript: createdTranscriptTurn.terminal,
		createdSession: turn.terminal,
		resumed: resumedTurn.terminal,
	};
	observed.absoluteResume = { path: createdTranscript, sessionId: resumedSessionId };
	observed.effects = { providerUrl, transcript: createdTranscript, branchEntryId: entryId, postResumePrompt: true };
	await client.close();
	client = undefined;
	await exitTmux(resumedTarget, run);
	observed.resumeCleanup = await awaitTmuxTermination(resumedTarget, "resumed compatibility tmux session");
	observed.cleanup = { forcedTmuxSessions: [] };
	observed.finishedAt = new Date().toISOString();
	await writeReports(root, observed);
} catch (error) {
	observed.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
	observed.cleanup = publicCloseInvoked
		? {
				forcedTmuxSessions: [],
				postClose: await exitAndObservePostCloseFailure(workspace, sdkLogicalClose?.endpoint, tmuxSession, run),
			}
		: { forcedTmuxSessions: await closeTmux(tmuxSession, run) };
	observed.finishedAt = new Date().toISOString();
	await writeReports(root, observed);
	throw error;
} finally {
	await client?.close();
	await provider.stop();
}

async function start(target: string, args: readonly string[]): Promise<void> {
	await run("tmux", ["new-session", "-d", "-s", target, "-c", workspace, "--", ...cliEnvironment, cli, ...args]);
}
async function observe(name: string, action: () => Promise<unknown>): Promise<unknown> {
	const value = await action();
	(observed.operations as Array<Record<string, unknown>>).push({ name, shape: shapeOf(value), observed: value });
	return value;
}
function record(name: string, value: unknown): void {
	(observed.operations as Array<Record<string, unknown>>).push({ name, observed: value });
}
function shapeOf(value: unknown): unknown {
	return Array.isArray(value)
		? value.map(shapeOf)
		: isRecord(value)
			? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOf(child)]))
			: typeof value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function startupArguments(version: string): readonly string[] {
	const arguments_ = ["--model", "compat-local/hermetic-model"];
	return version === "0.11.1" ? arguments_ : [...arguments_, "--thinking", "off"];
}
async function releasedCliVersion(command: string): Promise<string> {
	const output = (await run(command, ["--version"])).trim();
	const match = /^(?:gjc\/)?(\d+\.\d+\.\d+)$/.exec(output);
	if (match === null) throw new Error(`gjc --version returned an invalid version: ${JSON.stringify(output)}`);
	return match[1];
}
async function run(
	command: string,
	args: readonly string[],
	env?: Record<string, string | undefined>,
	allowFailure = false,
): Promise<string> {
	const process = Bun.spawn([command, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (code !== 0 && !allowFailure) throw new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`);
	return stdout;
}
async function writeReports(directory: string, report: Record<string, unknown>): Promise<void> {
	await writeFile(join(directory, "operation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
	const operations = report.operations as Array<{ name: string }>;
	await writeFile(
		join(directory, "operation-report.md"),
		`## GJC release compatibility\n\n- CLI version: ${JSON.stringify(report.cliVersion ?? null)}\n- Observed operations: ${operations.map(operation => `\`${operation.name}\``).join(", ") || "none"}\n- Absolute resume: ${JSON.stringify(report.absoluteResume ?? null)}\n- Cleanup: ${JSON.stringify(report.cleanup ?? null)}\n- Static source contract artifact: \`test/gjc-sdk-v3-contract.test.ts\` (separate test artifact; not observed by this runtime harness).\n`,
	);
}
function requiredArgument(flag: string): string {
	const index = process.argv.indexOf(flag);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new TypeError(`${flag} is required`);
	return resolve(value);
}
