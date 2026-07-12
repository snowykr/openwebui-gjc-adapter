import { resolveGjcRuntimeLocations } from "../configure/runtime-locations";
import type { GjcRuntimeLocations } from "../contracts";
import { createDefaultRpcTransport } from "./rpc-client-transport";
import { GjcRpcRunnerError } from "./rpc-errors";
import type {
	CreateGjcRpcTurnRunnerInput,
	CreateResolvedGjcRpcTurnRunnerInput,
	GjcContinueSessionInput,
	GjcRespondWorkflowGateInput,
	GjcRpcRunnerClientOptions,
	GjcRpcRunnerTransport,
	GjcRpcTransportState,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnEvent,
	GjcTurnResult,
	GjcTurnRunner,
} from "./rpc-runner";
import {
	assertAcceptedWorkflowGateResolution,
	callRespondGate,
	promptAndCollectWorkflowGates,
	toTurnEvent,
} from "./rpc-workflow-events";

interface StartedClient {
	readonly client: GjcRpcRunnerTransport;
}

export { GjcRpcRunnerError };

export function createGjcRpcTurnRunner(input: CreateGjcRpcTurnRunnerInput = {}): GjcTurnRunner {
	const runtimeLocations = input.runtimeLocations ?? resolveGjcRuntimeLocations({ mode: "existing" });
	return createResolvedGjcRpcTurnRunner({ ...input, runtimeLocations });
}

export function createResolvedGjcRpcTurnRunner(input: CreateResolvedGjcRpcTurnRunnerInput): GjcTurnRunner {
	if (input.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	return new RpcBackedGjcTurnRunner(
		input.clientFactory ?? createDefaultRpcTransport,
		input.cliPath,
		input.turnTimeoutMs ?? 60_000,
		input.runtimeLocations,
	);
}

class RpcBackedGjcTurnRunner implements GjcTurnRunner {
	readonly #clients = new Map<string, StartedClient>();

	constructor(
		private readonly clientFactory: (options: GjcRpcRunnerClientOptions) => GjcRpcRunnerTransport,
		private readonly cliPath: string | undefined,
		private readonly turnTimeoutMs: number,
		private readonly runtimeLocations: GjcRuntimeLocations,
	) {}

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		const clientKey = newSessionClientKey(input.projectId, input.chatId);
		const client = await this.getOrStartClient(clientKey, input);
		const session = await runRpcCommand("new_session", () => client.newSession());
		if (isCancelled(session)) throw new GjcRpcRunnerError("new_session", "session creation was cancelled");
		const result = await this.runPrompt(client, input.text, 0, 0);
		const address = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			sessionId: result.sessionId,
			chatId: input.chatId,
		};
		this.#clients.set(sessionClientKey(address), { client });
		return { ...address, ...stripSessionId(result) };
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		const client = await this.getOrStartClient(sessionClientKey(input), input);
		return stripSessionId(await this.runPrompt(client, input.text, input.rawFrameCursor, input.eventCursor));
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		if (input.sessionFile === undefined) {
			throw new GjcRpcRunnerError("switch_session", "sessionFile is required for continuation");
		}
		const client = await this.getOrStartClient(sessionClientKey(input), input);
		const result = await runRpcCommand("switch_session", () => client.switchSession(input.sessionFile ?? ""));
		if (isCancelled(result)) throw new GjcRpcRunnerError("switch_session", "session switch was cancelled");
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		const client = await this.getOrStartClient(sessionClientKey(input), input);
		const state = await runRpcCommand("get_state", () => client.getState());
		return mapSessionState(state, 0, 0);
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		const client = await this.getOrStartClient(sessionClientKey(input), input);
		if (client.respondGate === undefined) {
			throw new GjcRpcRunnerError("workflow_gate_response", "RPC transport does not support workflow gates");
		}
		const resolution = await runRpcCommand("workflow_gate_response", () =>
			callRespondGate(client, input.gateId, input.answer, input.idempotencyKey),
		);
		assertAcceptedWorkflowGateResolution(resolution);
		const state = await runRpcCommand("get_state", () => client.getState());
		const assistantText = await runRpcCommand("get_last_assistant_text", () => client.getLastAssistantText());
		return {
			...mapSessionState(state, input.rawFrameCursor, input.eventCursor),
			text: assistantText ?? "",
			events: assistantText === null ? [] : [{ type: "assistant", text: assistantText }],
		};
	}

	async runTurn(input: GjcStartNewSessionInput | GjcContinueSessionInput): Promise<GjcTurnResult> {
		if ("sessionId" in input) return this.continueSession(input);
		return this.startNewSession(input);
	}

	async *streamTurn(input: GjcStartNewSessionInput | GjcContinueSessionInput): AsyncIterable<GjcTurnEvent> {
		const result = await this.runTurn(input);
		for (const event of result.events) yield event;
	}

	private async getOrStartClient(
		key: string,
		options: Pick<GjcRpcRunnerClientOptions, "cwd" | "sessionRoot">,
	): Promise<GjcRpcRunnerTransport> {
		const existing = this.#clients.get(key);
		if (existing !== undefined) return existing.client;
		const client = this.clientFactory({
			cwd: options.cwd,
			sessionRoot: options.sessionRoot,
			...(this.cliPath === undefined ? {} : { cliPath: this.cliPath }),
			runtimeLocations: this.runtimeLocations,
		});
		await runRpcCommand("start", () => client.start());
		this.#clients.set(key, { client });
		return client;
	}

	private async runPrompt(
		client: GjcRpcRunnerTransport,
		text: string,
		baseRawFrameCursor: number,
		baseEventCursor: number,
	): Promise<GjcTurnResult & { readonly sessionId: string }> {
		const rawEvents = await runRpcCommand("prompt", () =>
			promptAndCollectWorkflowGates(client, text, this.turnTimeoutMs),
		);
		const state = await runRpcCommand("get_state", () => client.getState());
		const assistantText = await runRpcCommand("get_last_assistant_text", () => client.getLastAssistantText());
		const events = rawEvents.map(toTurnEvent);
		return {
			...mapSessionState(state, baseRawFrameCursor, baseEventCursor + events.length),
			sessionId: state.sessionId,
			text: assistantText ?? lastEventText(events) ?? "",
			events,
		};
	}
}

async function runRpcCommand<T>(command: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof GjcRpcRunnerError) throw error;
		if (error instanceof Error) throw new GjcRpcRunnerError(command, error.message);
		throw new GjcRpcRunnerError(command, String(error));
	}
}

function isCancelled(value: undefined | { readonly cancelled: boolean }): boolean {
	return value?.cancelled ?? false;
}

function mapSessionState(state: GjcRpcTransportState, rawFrameCursor: number, eventCursor: number): GjcSessionState {
	const rawCursor = state.rawFrameCursor ?? rawFrameCursor;
	const projectedEventCursor = state.eventCursor ?? state.messageCount ?? eventCursor;
	return {
		...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
		...(state.activeLeaf === undefined ? {} : { activeLeaf: state.activeLeaf }),
		rawFrameCursor: rawCursor,
		eventCursor: projectedEventCursor,
	};
}

function lastEventText(events: readonly GjcTurnEvent[]): string | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const text = events[index]?.text;
		if (text !== undefined) return text;
	}
	return undefined;
}

function stripSessionId(result: GjcTurnResult & { readonly sessionId: string }): GjcTurnResult {
	return {
		text: result.text,
		events: result.events,
		...(result.sessionFile === undefined ? {} : { sessionFile: result.sessionFile }),
		...(result.activeLeaf === undefined ? {} : { activeLeaf: result.activeLeaf }),
		rawFrameCursor: result.rawFrameCursor,
		eventCursor: result.eventCursor,
	};
}

function sessionClientKey(input: Pick<GjcSessionAddress, "projectId" | "sessionId">): string {
	return `${input.projectId}:${input.sessionId}`;
}

function newSessionClientKey(projectId: string, chatId: string): string {
	return `${projectId}:new:${chatId}`;
}
