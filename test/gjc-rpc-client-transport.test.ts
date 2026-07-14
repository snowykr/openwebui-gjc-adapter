import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createDefaultRpcTransport,
	createRpcTransportFromClient,
	type RpcClientTransportClient,
} from "../src/gjc/rpc-client-transport";
import type { GjcRpcRunnerTransportEvent, GjcRpcTransportState } from "../src/gjc/rpc-runner";
import { startSdkFixtureServer } from "./gjc-sdk-v3-fixtures";

describe("createRpcTransportFromClient", () => {
	test("default transport rejects omitted resolved locations before client construction", () => {
		expect(() => Reflect.apply(createDefaultRpcTransport, undefined, [{ cwd: "/tmp", sessionRoot: "/tmp" }])).toThrow(
			new TypeError("resolved runtime locations are required"),
		);
	});

	test("fixture answers committed state, catalog, and positional setter JSONL exchanges byte-for-byte", async () => {
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
		processHandle.stdin.write(
			'{"id":"req_state","type":"get_state"}\n{"id":"req_models","type":"get_available_models"}\n{"id":"req_set","type":"set_default_model_selection","provider":"anthropic","modelId":"claude-sonnet-4","thinkingLevel":"medium"}\n',
		);
		processHandle.stdin.end();
		const stdout = await new Response(processHandle.stdout).text();
		const stderr = await new Response(processHandle.stderr).text();
		const exitCode = await processHandle.exited;

		try {
			// Then: stdout and evidence preserve the exact request identity without conflating RpcClient traffic.
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toBe(
				'{"type":"ready"}\n{"id":"req_state","type":"response","command":"get_state","success":true,"data":{"thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","interruptMode":"immediate","sessionId":"fixture-session","autoCompactionEnabled":true,"messageCount":0,"queuedMessageCount":0,"todoPhases":[]}}\n{"id":"req_models","type":"response","command":"get_available_models","success":true,"data":{"models":[]}}\n{"id":"req_set","type":"response","command":"set_default_model_selection","success":true,"data":{"provider":"anthropic","modelId":"claude-sonnet-4","thinkingLevel":"medium"}}\n',
			);
			expect(readFileSync(protocol, "utf8")).toBe(
				`${JSON.stringify({ type: "process", argv: ["--mode", "rpc"], cwd: root })}\n{"type":"request","payload":{"id":"req_state","type":"get_state"}}\n{"type":"response","payload":{"id":"req_state","type":"response","command":"get_state","success":true,"data":{"thinkingLevel":"off","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","interruptMode":"immediate","sessionId":"fixture-session","autoCompactionEnabled":true,"messageCount":0,"queuedMessageCount":0,"todoPhases":[]}}}\n{"type":"request","payload":{"id":"req_models","type":"get_available_models"}}\n{"type":"response","payload":{"id":"req_models","type":"response","command":"get_available_models","success":true,"data":{"models":[]}}}\n{"type":"request","payload":{"id":"req_set","type":"set_default_model_selection","provider":"anthropic","modelId":"claude-sonnet-4","thinkingLevel":"medium"}}\n{"type":"response","payload":{"id":"req_set","type":"response","command":"set_default_model_selection","success":true,"data":{"provider":"anthropic","modelId":"claude-sonnet-4","thinkingLevel":"medium"}}}\n`,
			);
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
		// Given: hostile ambient GJC/PI values, inherited XDG values, and the SDK daemon CLI.
		const root = mkdtempSync(join(tmpdir(), "gjc-rpc-environment-"));
		const transcript = join(root, "sdk-cli.jsonl");
		const server = startSdkFixtureServer("turn_complete");
		const home = join(root, "home");
		const configDomain = join(home, ".gjc");
		const agentDir = join(configDomain, "agent");
		const readerWorkspace = join(configDomain, "openwebui", "default-reader");
		const readerSessionRoot = join(readerWorkspace, ".gjc", "sessions");
		for (const path of [agentDir, readerSessionRoot]) mkdirSync(path, { recursive: true });
		const locations = {
			home,
			configDomain,
			agentDir,
			readerWorkspace,
			readerSessionRoot,
			protectedProjectPaths: [configDomain, agentDir, readerWorkspace, readerSessionRoot] as const,
			childEnvironment: { HOME: home, GJC_CONFIG_DIR: ".gjc", GJC_CODING_AGENT_DIR: agentDir },
		};
		const adapterKeys = ["GJC_OPENWEBUI_ADAPTER_API_TOKEN", "GJC_OPENWEBUI_ADMIN_PASSWORD"] as const;
		const keys = [
			"GJC_CONFIG_DIR",
			"GJC_CODING_AGENT_DIR",
			"PI_CONFIG_DIR",
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"GJC_SDK_FIXTURE_CLI_TRANSCRIPT",
			"GJC_SDK_FIXTURE_ENDPOINT_URL",
			"GJC_SDK_FIXTURE_ENDPOINT_TOKEN",
			...adapterKeys,
		] as const;
		const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
		Object.assign(process.env, {
			GJC_CONFIG_DIR: "/hostile/config",
			GJC_CODING_AGENT_DIR: "/hostile/agent",
			PI_CONFIG_DIR: "/hostile/pi",
			XDG_DATA_HOME: "/hostile/xdg-data",
			XDG_STATE_HOME: "/hostile/xdg-state",
			XDG_CACHE_HOME: "/hostile/xdg-cache",
			GJC_SDK_FIXTURE_CLI_TRANSCRIPT: transcript,
			GJC_SDK_FIXTURE_ENDPOINT_URL: server.url,
			GJC_SDK_FIXTURE_ENDPOINT_TOKEN: server.token,
			...Object.fromEntries(adapterKeys.map(key => [key, `secret:${key}`])),
		});
		const transport = createDefaultRpcTransport({
			cwd: root,
			sessionRoot: locations.readerSessionRoot,
			cliPath: fileURLToPath(new URL("fixtures/gjc-sdk-daemon-fixture.ts", import.meta.url)),
			runtimeLocations: locations,
		});
		try {
			// When: the SDK lifecycle command creates and authenticates a session.
			await transport.start();
			await transport.newSession();

			// Then: managed locations win, unrelated XDG values survive, and adapter secrets do not cross the boundary.
			const first = readJsonl(transcript)[0];
			if (first === null || typeof first !== "object") throw new TypeError("missing SDK CLI transcript");
			const environment = Reflect.get(first, "environment");
			expect(environment).toEqual({
				HOME: locations.home,
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: locations.agentDir,
				PI_CONFIG_DIR_present: false,
				XDG_DATA_HOME: "/hostile/xdg-data",
				XDG_STATE_HOME: "/hostile/xdg-state",
				XDG_CACHE_HOME: "/hostile/xdg-cache",
				adapterKeys: [],
			});
			expect(JSON.stringify(environment)).not.toContain("/hostile/config");
			expect(JSON.stringify(environment)).not.toContain("/hostile/agent");
			expect(JSON.stringify(environment)).not.toContain("/hostile/pi");
			const launcherDir = join(locations.configDomain, "openwebui", "runtime");
			expect(Reflect.get(first, "sessionCommand")).toBe(join(launcherDir, "sdk-session-host"));
			expect(statSync(launcherDir).mode & 0o777).toBe(0o700);
		} finally {
			transport.stop();
			server.stop();
			for (const key of keys) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function readJsonl(path: string): readonly unknown[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
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
