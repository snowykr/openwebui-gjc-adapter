#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const fixtureDescriptor = readFixtureDescriptor();
const delayMs = Number(process.env.GJC_SDK_FIXTURE_DELAY_MS ?? "0");
if (Number.isFinite(delayMs) && delayMs > 0) await Bun.sleep(delayMs);

const argv = process.argv.slice(2);
const transcript = requiredEnvironment("GJC_SDK_FIXTURE_CLI_TRANSCRIPT");
appendFileSync(
	transcript,
	`${JSON.stringify({
		argv,
		cwd: process.cwd(),
		environment: {
			HOME: process.env.HOME,
			GJC_CONFIG_DIR: process.env.GJC_CONFIG_DIR,
			GJC_CODING_AGENT_DIR: process.env.GJC_CODING_AGENT_DIR,
			PI_CONFIG_DIR_present: process.env.PI_CONFIG_DIR !== undefined,
			XDG_DATA_HOME: process.env.XDG_DATA_HOME,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
			XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
			adapterKeys: Object.keys(process.env).filter(name => name.startsWith("GJC_OPENWEBUI_")),
		},
		hostileDotenv: process.env.GJC_SDK_HOSTILE_DOTENV,
		agentDotenv: process.env.GJC_SDK_AGENT_DOTENV,
		sessionCommand: process.env.GJC_SDK_SESSION_COMMAND,
	})}\n`,
);


await runInteractiveCli();

function valueAfter(flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}
async function runInteractiveCli(): Promise<void> {
	const resumedSessionPath = valueAfter("--resume");
	if (resumedSessionPath !== undefined && (!isAbsolute(resumedSessionPath) || !resumedSessionPath.endsWith(".jsonl"))) {
		throw new TypeError("interactive fixture resume session must be an absolute .jsonl path");
	}

	const sessionId = resumedSessionPath === undefined ? randomUUID() : await readSessionId(resumedSessionPath);
	const sessionPath = resumedSessionPath ?? join(process.cwd(), ".gjc", "sessions", `${sessionId}.jsonl`);
	await retainSessionHeader(sessionPath, sessionId);
	await publishSdkSessionEndpoint(process.cwd(), sessionId, {
		url: requiredEnvironment("GJC_SDK_FIXTURE_ENDPOINT_URL"),
		token: authorityToken(sessionId, process.cwd()),
	});
	const exit = waitForExit(sessionId);
	appendFileSync(
		transcript,
		`${JSON.stringify({ interactive: resumedSessionPath !== undefined ? "resume" : "create", sessionPath })}\n`,
	);
	write({ sessionId, sessionPath });
	await exit;
	process.stdin.pause();
	process.exit(0);
}

async function waitForExit(sessionId: string): Promise<void> {
	const descriptor = join(process.cwd(), ".gjc", "state", "sdk", `${sessionId}.json`);
	const onInputExit = new Promise<void>(resolve => {
		let pending = "";
		const onData = (chunk: string) => {
			pending += chunk;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (line === "/session") {
					appendFileSync(transcript, `${JSON.stringify({ sessionCommand: "/session" })}\n`);
					process.stdout.write(`Session ID: ${sessionId}\n`);
				} else if (line === "/exit") {
					resolve();
					return;
				}
			}
		};
		const onEnd = () => resolve();
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
	});
	await Promise.race([
		onInputExit,
		(async () => {
			for (;;) {
				try {
					await access(descriptor);
				} catch {
					return;
				}
				await Bun.sleep(25);
			}
		})(),
	]);
	process.stdin.pause();
}

async function retainSessionHeader(sessionPath: string, sessionId: string): Promise<void> {
	await mkdir(dirname(sessionPath), { recursive: true });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(sessionPath, "wx", 0o600);
		await handle.writeFile(
			`${JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
		);
		await handle.sync();
	} catch (error) {
		if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST")) throw error;
	} finally {
		await handle?.close();
	}
}
async function readSessionId(sessionPath: string): Promise<string> {
	const line = (await Bun.file(sessionPath).text()).split(/\r?\n/, 1)[0];
	const value: unknown = JSON.parse(line);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof Reflect.get(value, "id") !== "string"
	) {
		throw new TypeError("interactive fixture resume session must have a session id");
	}
	return Reflect.get(value, "id") as string;
}


function requiredEnvironment(name: string): string {
	const value = process.env[name] ?? fixtureDescriptor[name];
	if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`);
	return value;
}
function readFixtureDescriptor(): Readonly<Record<string, string>> {
	const home = process.env.HOME;
	if (home === undefined) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(join(home, "gjc-sdk-fixture.json"), "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

function authorityToken(sessionId: string, cwd: string): string {
	const token = requiredEnvironment("GJC_SDK_FIXTURE_ENDPOINT_TOKEN");
	if (requiredEnvironment("GJC_SDK_FIXTURE_DYNAMIC_AUTHORITY") !== "1") return token;
	return `${token}.${Buffer.from(JSON.stringify({ sessionId, cwd })).toString("base64url")}`;
}

async function publishSdkSessionEndpoint(
	cwd: string,
	sessionId: string,
	endpoint: Readonly<{ url: string; token: string }>,
): Promise<void> {
	const url = new URL(endpoint.url);
	const now = Date.now();
	const file = join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	const directory = dirname(file);
	const temporary = join(directory, `.${sessionId}.${randomUUID()}.tmp`);
	const record = {
		version: 1,
		sessionId,
		pid: process.pid,
		host: url.hostname,
		port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
		url: endpoint.url,
		token: endpoint.token,
		startedAt: now,
		updatedAt: now,
		stale: false,
	};
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "w", 0o600);
		await handle.writeFile(`${JSON.stringify(record)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, file);
		await syncDirectory(directory);
	} finally {
		await handle?.close();
		await rm(temporary, { force: true });
	}
}
async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function write(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
