#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { apiKey, providerResponse, writeLocalProviderConfig } from "./gjc-release-compat-fixtures";
import { closeWithPublicSdkProof } from "./gjc-release-compat-lifecycle";
import {
	branchEntryId,
	promptAndAbortTerminal,
	promptAndAwaitTerminal,
	rediscoverSessionId,
	sessionFromFilesystem,
	sessionIdFrom,
	validateCurrentModel,
} from "./gjc-release-compat-runtime";
import { lifecycleSuccessor, type PublicSdkSession, startPublicSdk, stopPublicSdk } from "./gjc-release-compat-sdk";

const root = requiredArgument("--root");
const cli = requiredArgument("--gjc");
const workspace = join(root, "workspace");
const agentDir = join(root, ".gjc", "agent");
const stateRoot = join(workspace, ".gjc", "state");
const observed: Record<string, unknown> = { schema: 1, startedAt: new Date().toISOString(), operations: [] };
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: providerResponse });
const providerUrl = `http://127.0.0.1:${provider.port}`;
let client: PublicSdkSession | undefined;
let publicCloseInvoked = false;
let sdkLogicalClose: Record<string, unknown> | undefined;

await mkdir(workspace, { recursive: true });
await writeLocalProviderConfig(agentDir, providerUrl);
process.env.GJC_CODING_AGENT_DIR = agentDir;
process.env.GJC_COMPAT_LOCAL_API_KEY = apiKey;
const cliVersion = await releasedCliVersion(cli);
observed.cliVersion = cliVersion;

try {
	await startPublicSdk(workspace);
	let successor = await lifecycleSuccessor(
		undefined,
		"session.create",
		{ cwd: workspace, stateRoot, readinessTimeoutMs: 15_000 },
		workspace,
		observe,
		record,
	);
	client = successor.client;
	let sessionId = successor.sessionId;
	await observe("Q14", () => client!.query("session.metadata"));
	await observe("Q12", () => client!.query("workflow.gates.list"));
	const models = await observe("Q10", () => client!.query("models.list/current"));
	const thinkingSupported = await validateCurrentModel(client, models, observe);
	await observe("model.set", () => client!.control("model.set", { id: "compat-local/hermetic-model" }));
	observed.thinking = { supported: thinkingSupported, requested: "off" };
	if (thinkingSupported) await observe("thinking.set", () => client!.control("thinking.set", { level: "off" }));
	const terminalAbort = await promptAndAbortTerminal(
		client,
		sessionId,
		"terminal-abort.turn.prompt",
		"Reply only after the terminal abort arrives.",
		observe,
	);
	observed.terminalAbort = terminalAbort;
	const initialTranscriptTurn = await promptAndAwaitTerminal(
		client,
		sessionId,
		"initial-transcript.turn.prompt",
		"Reply with initial-transcript-proof.",
		observe,
	);
	const initialSession = await sessionFromFilesystem(root, sessionId);

	successor = await lifecycleSuccessor(
		client,
		"session.create",
		{ cwd: workspace, stateRoot, readinessTimeoutMs: 15_000 },
		workspace,
		observe,
		record,
	);
	client = successor.client;
	sessionId = successor.sessionId;
	const createdSessionId = sessionId;
	const createdTranscriptTurn = await promptAndAwaitTerminal(
		client,
		sessionId,
		"created-transcript.turn.prompt",
		"Reply with created-transcript-proof.",
		observe,
	);
	const createdSession = await sessionFromFilesystem(root, createdSessionId);
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
		{
			sessionId: initialSession.sessionId,
			cwd: workspace,
			stateRoot,
			sessionPath: initialSession.transcript,
			sessionIdentity: initialSession.identity,
		},
		workspace,
		observe,
		record,
		initialSession.sessionId,
	);
	client = successor.client;
	sessionId = successor.sessionId;

	successor = await lifecycleSuccessor(
		client,
		"session.resume",
		{
			sessionId: createdSession.sessionId,
			cwd: workspace,
			stateRoot,
			sessionPath: createdTranscript,
			sessionIdentity: createdSession.identity,
		},
		workspace,
		observe,
		record,
		createdSession.sessionId,
	);
	client = successor.client;
	sessionId = successor.sessionId;

	const entryId = await branchEntryId(workspace, sessionId, observe);
	successor = await lifecycleSuccessor(
		client,
		"session.fork",
		{
			cwd: workspace,
			stateRoot,
			sourceSessionId: sessionId,
			sourceSessionPath: createdTranscript,
			sourceSessionIdentity: createdSession.identity,
		},
		workspace,
		observe,
		record,
	);
	client = successor.client;
	sessionId = successor.sessionId;
	const branchSessionId = sessionIdFrom(successor) ?? (await rediscoverSessionId(workspace, createdSessionId));
	const branchClient = client;
	publicCloseInvoked = true;
	sdkLogicalClose = await closeWithPublicSdkProof(branchClient, workspace, branchSessionId, observe);
	client = undefined;
	observed.close = { sdkLogicalClose };

	successor = await lifecycleSuccessor(
		undefined,
		"session.resume",
		{
			sessionId: createdSession.sessionId,
			cwd: workspace,
			stateRoot,
			sessionPath: createdTranscript,
			sessionIdentity: createdSession.identity,
		},
		workspace,
		observe,
		record,
		createdSession.sessionId,
	);
	client = successor.client;
	sessionId = successor.sessionId;
	const resumedTurn = await promptAndAwaitTerminal(
		client,
		sessionId,
		"resume.turn.prompt",
		"Reply with post-resume-write-proof.",
		observe,
	);
	await observe("Q17", () => client!.query("session.last_assistant"));
	observed.terminals = {
		initialTranscript: initialTranscriptTurn.terminal,
		createdTranscript: createdTranscriptTurn.terminal,
		createdSession: resumedTurn.terminal,
		resumed: resumedTurn.terminal,
	};
	observed.absoluteResume = { path: createdTranscript, sessionId };
	observed.effects = { providerUrl, transcript: createdTranscript, branchEntryId: entryId, postResumePrompt: true };
	await client.close();
	client = undefined;
	observed.cleanup = { publicRouterStopped: true };
	observed.finishedAt = new Date().toISOString();
	await writeReports(root, observed);
} catch (error) {
	observed.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
	observed.cleanup = publicCloseInvoked
		? { publicRouterStopped: true, postClose: sdkLogicalClose }
		: { publicRouterStopped: true };
	observed.finishedAt = new Date().toISOString();
	await writeReports(root, observed);
	throw error;
} finally {
	await client?.close();
	await stopPublicSdk(workspace);
	await provider.stop();
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

async function releasedCliVersion(command: string): Promise<string> {
	const process = Bun.spawn([command, "--version"], { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (code !== 0) throw new Error(`${command} --version failed: ${stderr.trim()}`);
	const output = stdout.trim();
	const match = /^(?:gjc\/)?(\d+\.\d+\.\d+)$/.exec(output);
	if (match === null) throw new Error(`gjc --version returned an invalid version: ${JSON.stringify(output)}`);
	return match[1]!;
}

async function writeReports(directory: string, report: Record<string, unknown>): Promise<void> {
	await writeFile(join(directory, "operation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
	const operations = report.operations as Array<{ name: string }>;
	await writeFile(
		join(directory, "operation-report.md"),
		`## GJC release compatibility\n\n- CLI version: ${JSON.stringify(report.cliVersion ?? null)}\n- Observed operations: ${operations.map(operation => `\`${operation.name}\``).join(", ") || "none"}\n- Absolute resume: ${JSON.stringify(report.absoluteResume ?? null)}\n- Cleanup: ${JSON.stringify(report.cleanup ?? null)}\n- Public managed SDK harness: lifecycle and Router APIs only; no direct transport observations.\n- Static source contract artifact: \`test/gjc-sdk-v3-contract.test.ts\` (separate test artifact; not observed by this runtime harness).\n`,
	);
}

function requiredArgument(flag: string): string {
	const index = process.argv.indexOf(flag);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new TypeError(`${flag} is required`);
	return resolve(value);
}
