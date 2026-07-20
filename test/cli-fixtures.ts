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
} from "../src/gjc/turn-runner";
import { attachmentProof, lifecycleFixture } from "./gjc-lifecycle-fixtures";

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
	const abort = new AbortController();
	const stdout = observeSubprocessOutput(proc.stdout);
	const response = waitForHttpResponse(url, abort.signal);
	const ready = stdout.ready.then(() => fetch(url, { signal: abort.signal }));
	const exited = proc.exited.then(async code => {
		const [capturedStdout, stderr] = await Promise.all([stdout.complete, readSubprocessOutput(proc.stderr)]);
		throw new Error(`start command exited with ${code}\nstdout:\n${capturedStdout}\nstderr:\n${stderr}`);
	});
	exited.catch(() => undefined);
	try {
		return await Promise.race([ready, response, exited]);
	} catch (error) {
		if (proc.exitCode === null) await stopProcess(proc);
		throw error;
	} finally {
		abort.abort();
	}
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
	readonly catalogMode?: "capabilities" | "current-inherit";
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

	async startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (
			result: GjcSessionAddress & GjcTurnResult,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<T>,
	): Promise<T> {
		this.starts.push(input);
		const result = {
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
		const lifecycle = lifecycleFixture(result);
		return await publish({ ...result, attachment: attachmentProof(result) }, lifecycle);
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
			attachment: attachmentProof(input),
		};
	}

	async switchSession(_input: GjcSwitchSessionInput): Promise<void> {}
	async withLifecyclePublication<T>(
		address: GjcSessionAddress,
		effect: (lifecycle: ReturnType<typeof lifecycleFixture>) => Promise<T>,
	): Promise<T> {
		return await effect(lifecycleFixture(address));
	}
	async withLifecycleClosePreflight<T>(
		address: GjcSessionAddress,
		effect: (lifecycle: ReturnType<typeof lifecycleFixture>) => Promise<T>,
	): Promise<T> {
		return await effect(lifecycleFixture(address));
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		return {
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			attachment: attachmentProof(input),
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

async function waitForHttpResponse(url: string, signal: AbortSignal): Promise<Response> {
	const startedAt = Date.now();
	let lastError: Error | null = null;
	while (Date.now() - startedAt < SERVER_START_DEADLINE_MS) {
		try {
			return await fetch(url, { signal });
		} catch (error) {
			if (signal.aborted) throw error;
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

function observeSubprocessOutput(output: Bun.Subprocess["stdout"]): {
	readonly ready: Promise<void>;
	readonly complete: Promise<string>;
} {
	if (!(output instanceof ReadableStream)) {
		const unavailable = Promise.reject(new Error("start command stdout is unavailable"));
		unavailable.catch(() => undefined);
		return { ready: unavailable, complete: Promise.resolve("") };
	}
	const reader = output.getReader();
	const decoder = new TextDecoder();
	let captured = "";
	let resolveReady: () => void;
	const ready = new Promise<void>(resolve => {
		resolveReady = resolve;
	});
	const complete = (async () => {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				captured += decoder.decode(chunk.value, { stream: true });
				if (/openwebui-gjc-adapter listening on \S+/.test(captured)) resolveReady!();
			}
			captured += decoder.decode();
			if (/openwebui-gjc-adapter listening on \S+/.test(captured)) resolveReady!();
			return captured;
		} finally {
			reader.releaseLock();
		}
	})();
	ready.catch(() => undefined);
	return { ready, complete };
}
async function readSubprocessOutput(output: Bun.Subprocess["stdout"]): Promise<string> {
	if (output instanceof ReadableStream) return await new Response(output).text();
	return "";
}
