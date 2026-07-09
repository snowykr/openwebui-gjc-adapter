import { describe, expect, test } from "bun:test";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import { createRpcTransportFromClient, type RpcClientTransportClient } from "../src/gjc/rpc-client-transport";
import type { GjcRpcRunnerTransportEvent, GjcRpcTransportState } from "../src/gjc/rpc-runner";

describe("createRpcTransportFromClient", () => {
	test("uses a GJC client version that exposes full session events", () => {
		expect(typeof RpcClient.prototype.onSessionEvent).toBe("function");
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
});

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
