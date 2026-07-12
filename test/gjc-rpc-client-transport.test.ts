import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import {
	createDefaultRpcTransport,
	createRpcTransportFromClient,
	type RpcClientTransportClient,
} from "../src/gjc/rpc-client-transport";
import type { GjcRpcRunnerTransportEvent, GjcRpcTransportState } from "../src/gjc/rpc-runner";

describe("createRpcTransportFromClient", () => {
	test("default transport rejects omitted resolved locations before client construction", () => {
		expect(() => Reflect.apply(createDefaultRpcTransport, undefined, [{ cwd: "/tmp", sessionRoot: "/tmp" }])).toThrow(
			new TypeError("resolved runtime locations are required"),
		);
	});

	test("fixture answers the committed req_state JSONL exchange byte-for-byte", async () => {
		// Given: the raw fixture process with separate protocol and lifecycle transcripts.
		const root = mkdtempSync(join(tmpdir(), "gjc-rpc-raw-jsonl-"));
		const protocol = join(root, "protocol.jsonl");
		const lifecycle = join(root, "lifecycle.jsonl");
		const fixture = fileURLToPath(new URL("fixtures/gjc-rpc-stdio-fixture.ts", import.meta.url));
		const processHandle = Bun.spawn([process.execPath, fixture, "--mode", "rpc"], {
			cwd: root,
			env: {
				...process.env,
				GJC_RPC_FIXTURE_PROTOCOL_TRANSCRIPT: protocol,
				GJC_RPC_FIXTURE_LIFECYCLE_TRANSCRIPT: lifecycle,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// When: the exact committed request is written and stdin closes.
		processHandle.stdin.write('{"id":"req_state","type":"get_state"}\n');
		processHandle.stdin.end();
		const stdout = await new Response(processHandle.stdout).text();
		const stderr = await new Response(processHandle.stderr).text();
		const exitCode = await processHandle.exited;

		try {
			// Then: stdout and evidence preserve the exact request identity without conflating RpcClient traffic.
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toBe(`{"type":"ready"}\n${JSON.stringify(fixtureResponse("req_state"))}\n`);
			expect(readJsonl(protocol)).toEqual([
				{ type: "process", argv: ["--mode", "rpc"], cwd: root },
				{ type: "request", payload: { id: "req_state", type: "get_state" } },
				{ type: "response", payload: fixtureResponse("req_state") },
			]);
			expect(readJsonl(lifecycle)).toEqual([{ type: "started", pid: processHandle.pid }, { type: "eof" }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("prefers full session events over filtered agent events when the GJC client exposes onSessionEvent", async () => {
		const client = new FullSessionEventClient([
			{ type: "todo_reminder", todos: [{ text: "keep evidence bounded" }] },
			{ type: "agent_end" },
		]);
		const transport = createRpcTransportFromClient(client);

		const events = await transport.promptAndWait("show tui events", 1_000);

		expect(events.map(event => event.type)).toEqual(["todo_reminder", "agent_end"]);
		expect(client.calls).toEqual(["on_session_event", "on_workflow_gate", "prompt:show tui events"]);
	});

	test("overwrites GJC child locations while inheriting unrelated XDG values", async () => {
		// Given: hostile ambient GJC/PI values, inherited XDG values, and the real stdio client.
		const root = mkdtempSync(join(tmpdir(), "gjc-rpc-environment-"));
		const transcript = join(root, "environment.jsonl");
		const protocolTranscript = join(root, "protocol.jsonl");
		const lifecycleTranscript = join(root, "lifecycle.jsonl");
		const locations = resolveGjcRuntimeLocations({ mode: "managed" });
		const keys = [
			"GJC_CONFIG_DIR",
			"GJC_CODING_AGENT_DIR",
			"PI_CONFIG_DIR",
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"GJC_RPC_FIXTURE_ENV_TRANSCRIPT",
			"GJC_RPC_FIXTURE_PROTOCOL_TRANSCRIPT",
			"GJC_RPC_FIXTURE_LIFECYCLE_TRANSCRIPT",
		] as const;
		const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
		Object.assign(process.env, {
			GJC_CONFIG_DIR: "/hostile/config",
			GJC_CODING_AGENT_DIR: "/hostile/agent",
			PI_CONFIG_DIR: "/hostile/pi",
			XDG_DATA_HOME: "/hostile/xdg-data",
			XDG_STATE_HOME: "/hostile/xdg-state",
			XDG_CACHE_HOME: "/hostile/xdg-cache",
			GJC_RPC_FIXTURE_ENV_TRANSCRIPT: transcript,
			GJC_RPC_FIXTURE_PROTOCOL_TRANSCRIPT: protocolTranscript,
			GJC_RPC_FIXTURE_LIFECYCLE_TRANSCRIPT: lifecycleTranscript,
		});
		const transport = createDefaultRpcTransport({
			cwd: root,
			sessionRoot: locations.readerSessionRoot,
			cliPath: fileURLToPath(new URL("fixtures/gjc-rpc-stdio-fixture.ts", import.meta.url)),
			runtimeLocations: locations,
		});
		let childPid: number | undefined;
		try {
			// When: the actual upstream RpcClient starts and performs get_state.
			await transport.start();
			const state = await transport.getState();
			childPid = processRecordPid(readJsonl(lifecycleTranscript)[0]);

			// Then: protocol state is valid and environment evidence stays separate from stdout.
			expect(state).toMatchObject({ sessionId: "fixture-session", messageCount: 0 });
			const environment: unknown = JSON.parse(readFileSync(transcript, "utf8"));
			expect(environment).toEqual({
				HOME: locations.home,
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: locations.agentDir,
				PI_CONFIG_DIR_present: false,
				XDG_DATA_HOME: "/hostile/xdg-data",
				XDG_STATE_HOME: "/hostile/xdg-state",
				XDG_CACHE_HOME: "/hostile/xdg-cache",
			});
			expect(JSON.stringify(environment)).not.toContain("/hostile/config");
			expect(JSON.stringify(environment)).not.toContain("/hostile/agent");
			expect(JSON.stringify(environment)).not.toContain("/hostile/pi");
			const protocol = readJsonl(protocolTranscript);
			expect(protocol).toEqual([
				{
					type: "process",
					argv: ["--mode", "rpc", "--session-dir", locations.readerSessionRoot],
					cwd: root,
				},
				{ type: "request", payload: { id: "req_1", type: "get_state" } },
				{ type: "response", payload: fixtureResponse("req_1") },
			]);
		} finally {
			transport.stop();
			if (childPid !== undefined) await waitForExit(childPid);
			for (const key of keys) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function fixtureResponse(id: string) {
	return {
		id,
		type: "response",
		command: "get_state",
		success: true,
		data: {
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			interruptMode: "immediate",
			sessionId: "fixture-session",
			autoCompactionEnabled: true,
			messageCount: 0,
			queuedMessageCount: 0,
			todoPhases: [],
		},
	};
}

function readJsonl(path: string): readonly unknown[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

function processRecordPid(value: unknown): number {
	if (value === null || typeof value !== "object") throw new Error("fixture process transcript is missing");
	const pid = Reflect.get(value, "pid");
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
		throw new Error("fixture process transcript has an invalid pid");
	return pid;
}

async function waitForExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`fixture process ${pid} did not exit`);
}

class FullSessionEventClient implements RpcClientTransportClient {
	readonly calls: string[] = [];
	readonly #events: readonly GjcRpcRunnerTransportEvent[];
	#sessionListener: ((event: GjcRpcRunnerTransportEvent) => void) | undefined;

	constructor(events: readonly GjcRpcRunnerTransportEvent[]) {
		this.#events = events;
	}

	async start(): Promise<void> {
		this.calls.push("start");
	}

	stop(): void {
		this.calls.push("stop");
	}

	async newSession(): Promise<{ readonly cancelled: boolean }> {
		this.calls.push("new_session");
		return { cancelled: false };
	}

	async switchSession(sessionPath: string): Promise<{ readonly cancelled: boolean }> {
		this.calls.push(`switch_session:${sessionPath}`);
		return { cancelled: false };
	}

	async getState(): Promise<GjcRpcTransportState> {
		this.calls.push("get_state");
		return { sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 };
	}

	async prompt(message: string): Promise<void> {
		this.calls.push(`prompt:${message}`);
		for (const event of this.#events) this.#sessionListener?.(event);
	}

	onEvent(): () => void {
		this.calls.push("on_event");
		return () => undefined;
	}

	onSessionEvent(listener: (event: GjcRpcRunnerTransportEvent) => void): () => void {
		this.calls.push("on_session_event");
		this.#sessionListener = listener;
		return () => {
			this.#sessionListener = undefined;
		};
	}

	onWorkflowGate(): () => void {
		this.calls.push("on_workflow_gate");
		return () => undefined;
	}

	async respondGate(): Promise<unknown> {
		this.calls.push("respond_gate");
		return { status: "accepted" };
	}

	async getLastAssistantText(): Promise<string | null> {
		this.calls.push("get_last_assistant_text");
		return null;
	}

	getStderr(): string {
		return "";
	}
}
