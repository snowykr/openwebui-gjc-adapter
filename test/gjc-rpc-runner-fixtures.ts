import type {
	GjcRpcRunnerClientFactory,
	GjcRpcRunnerClientOptions,
	GjcRpcRunnerTransport,
	GjcRpcTransportState,
} from "../src/gjc/rpc-runner";

export interface RecordedClient {
	readonly options: GjcRpcRunnerClientOptions;
	readonly client: FakeRpcTransport;
}

type FakeCall =
	| { readonly type: "start" }
	| { readonly type: "new_session" }
	| { readonly type: "switch_session"; readonly sessionPath: string }
	| { readonly type: "get_state" }
	| { readonly type: "prompt"; readonly message: string }
	| { readonly type: "get_last_assistant_text" }
	| { readonly type: "stop" };

type GjcRpcRunnerTransportEvent =
	| {
			readonly type: "message_update";
			readonly message: { readonly content: readonly [{ readonly type: "text"; readonly text: string }] };
	  }
	| { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string };

export class FakeRpcTransport implements GjcRpcRunnerTransport {
	readonly calls: FakeCall[] = [];
	readonly states: GjcRpcTransportState[];
	readonly promptEvents: readonly GjcRpcRunnerTransportEvent[][];
	readonly assistantTexts: readonly string[];
	failCommand: FakeCall["type"] | undefined;

	#stateIndex = 0;
	#promptIndex = 0;
	#textIndex = 0;

	constructor(input: {
		readonly states: readonly GjcRpcTransportState[];
		readonly promptEvents?: readonly (readonly GjcRpcRunnerTransportEvent[])[];
		readonly assistantTexts?: readonly string[];
	}) {
		this.states = [...input.states];
		this.promptEvents = input.promptEvents?.map(events => [...events]) ?? [[]];
		this.assistantTexts = input.assistantTexts ?? [""];
	}

	async start(): Promise<void> {
		this.record({ type: "start" });
	}

	stop(): void {
		this.calls.push({ type: "stop" });
	}

	async newSession(): Promise<{ readonly cancelled: boolean }> {
		this.record({ type: "new_session" });
		return { cancelled: false };
	}

	async switchSession(sessionPath: string): Promise<{ readonly cancelled: boolean }> {
		this.record({ type: "switch_session", sessionPath });
		return { cancelled: false };
	}

	async getState(): Promise<GjcRpcTransportState> {
		this.record({ type: "get_state" });
		const state = this.states[this.#stateIndex] ?? this.states[this.states.length - 1];
		if (state === undefined) throw new Error("missing fake RPC state");
		this.#stateIndex += 1;
		return state;
	}

	async promptAndWait(message: string): Promise<readonly GjcRpcRunnerTransportEvent[]> {
		this.record({ type: "prompt", message });
		const events = this.promptEvents[this.#promptIndex] ?? [];
		this.#promptIndex += 1;
		return events;
	}

	async getLastAssistantText(): Promise<string | null> {
		this.record({ type: "get_last_assistant_text" });
		const text = this.assistantTexts[this.#textIndex] ?? null;
		this.#textIndex += 1;
		return text;
	}

	private record(call: FakeCall): void {
		if (this.failCommand === call.type) throw new Error(`fake ${call.type} failure`);
		this.calls.push(call);
	}
}

export function recordFactory(created: RecordedClient[], client: FakeRpcTransport): GjcRpcRunnerClientFactory {
	return (options: GjcRpcRunnerClientOptions) => {
		created.push({ options, client });
		return client;
	};
}
