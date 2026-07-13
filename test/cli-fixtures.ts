import * as path from "node:path";
import type {
	GjcContinueSessionInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../src/gjc/rpc-runner";

export async function reserveTcpPort(): Promise<number> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = server.port;
	await server.stop();
	if (typeof port === "number") return port;
	throw new Error("Bun did not allocate a TCP port");
}

export async function waitForStartedServer(proc: Bun.Subprocess, url: string): Promise<Response> {
	const response = waitForHttpResponse(url);
	const exited = proc.exited.then(async code => {
		const stdout = await readSubprocessOutput(proc.stdout);
		const stderr = await readSubprocessOutput(proc.stderr);
		throw new Error(`start command exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	});
	exited.catch(() => undefined);
	return await Promise.race([response, exited]);
}

export const SERVER_START_DEADLINE_MS = 5_000;

export interface FailedStartCleanupReceipt {
	readonly deadlineMs: number;
	readonly pid: number;
	readonly port: number;
	readonly processExited: boolean;
	readonly root: string;
}

export interface RealSelectionStartOptions {
	readonly failStartup?: boolean;
	readonly invalidRunnerModel?: string;
	readonly onFailedCleanup?: (receipt: FailedStartCleanupReceipt) => void;
}

export async function stopProcess(proc: Bun.Subprocess): Promise<void> {
	proc.kill();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			proc.exited,
			new Promise<void>(resolve => {
				timeout = setTimeout(resolve, 500);
			}),
		]);
		if (proc.exitCode === null) proc.kill("SIGKILL");
		await proc.exited;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	events: GjcTurnResult["events"] = [{ type: "assistant", text: "assistant from gjc" }];

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		this.starts.push(input);
		return {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			sessionId: "session-1",
			chatId: input.chatId,
			text: `assistant from gjc: ${input.text}`,
			events: this.events,
			sessionFile: path.join(input.sessionRoot, "session-1.jsonl"),
			activeLeaf: "leaf-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		return {
			text: `continued: ${input.text}`,
			events: [{ type: "assistant", text: `continued: ${input.text}` }],
			sessionFile: input.sessionFile,
			activeLeaf: input.activeLeaf,
			rawFrameCursor: input.rawFrameCursor + 1,
			eventCursor: input.eventCursor + 1,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
	}

	async switchSession(_input: GjcSwitchSessionInput): Promise<void> {}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		return {
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-1",
			rawFrameCursor: 1,
			eventCursor: 1,
		};
	}
}

export function chatRequest(
	options: { readonly includeOwnerHeader?: boolean; readonly userId?: string } = {},
): Request {
	const headers: Record<string, string> = {
		authorization: "Bearer adapter-token",
		"content-type": "application/json",
		"X-OpenWebUI-Chat-Id": "chat-1",
		"X-OpenWebUI-Message-Id": "assistant-1",
		"X-OpenWebUI-User-Message-Id": "user-1",
		"X-OpenWebUI-User-Message-Parent-Id": "",
	};
	if (options.includeOwnerHeader !== false) {
		headers["X-OpenWebUI-User-Id"] = options.userId ?? "owner-test";
	}
	return new Request("http://adapter.test/v1/chat/completions", {
		method: "POST",
		headers,
		body: JSON.stringify({ model: "gjc", messages: [{ role: "user", content: "hello" }] }),
	});
}

async function waitForHttpResponse(url: string): Promise<Response> {
	const startedAt = Date.now();
	let lastError: Error | null = null;
	while (Date.now() - startedAt < SERVER_START_DEADLINE_MS) {
		try {
			return await fetch(url);
		} catch (error) {
			if (error instanceof Error) {
				lastError = error;
			} else {
				throw error;
			}
		}
		await Bun.sleep(50);
	}
	throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function readSubprocessOutput(output: Bun.Subprocess["stdout"]): Promise<string> {
	if (output instanceof ReadableStream) return await new Response(output).text();
	return "";
}
