import { resolveGjcRuntimeLocations } from "../configure/runtime-locations";
import type { GjcRuntimeLocations, NormalizedModelSelection } from "../contracts";
import { createDefaultRpcTransport } from "./rpc-client-transport";
import { GjcRpcRunnerError } from "./rpc-errors";
import type {
	CreateGjcRpcTurnRunnerInput,
	CreateResolvedGjcRpcTurnRunnerInput,
	GjcContinueSessionInput,
	GjcRespondWorkflowGateInput,
	GjcRpcRunnerClientOptions,
	GjcRpcRunnerTransport,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnEvent,
	GjcTurnResult,
	GjcTurnRunner,
} from "./rpc-runner";
import { lastEventText, mapSessionState, stripSessionId } from "./rpc-runner-result";
import {
	assertAcceptedWorkflowGateResolution,
	callRespondGate,
	promptAndCollectWorkflowGates,
	respondAndCollectWorkflowGates,
	toTurnEvent,
} from "./rpc-workflow-events";
import { resolveGjcSdkSessionRoot } from "./session-root";

interface StartedClient {
	readonly client: GjcRpcRunnerTransport;
	readonly ready: Promise<void>;
	tail: Promise<void>;
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

	async stop(): Promise<void> {
		const clients = [...new Set(this.#clients.values())].map(started => started.client);
		this.#clients.clear();
		const results = await Promise.allSettled(clients.map(client => client.stop()));
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0)
			throw new AggregateError(
				failures.map(result => result.reason),
				"GJC cleanup failed",
			);
	}

	resolveSessionRoot = (cwd: string): string => resolveGjcSdkSessionRoot(cwd, this.runtimeLocations);

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		const sessionRoot = this.resolveSessionRoot(input.cwd);
		const clientKey = newSessionClientKey(input.projectId, input.chatId);
		const started = await this.getOrStartClient(clientKey, { ...input, sessionRoot });
		const result = await enqueue(started, async () => {
			const session = await runRpcCommand("new_session", () => started.client.newSession());
			if (isCancelled(session)) throw new GjcRpcRunnerError("new_session", "session creation was cancelled");
			return this.runPrompt(started.client, input.text, 0, 0, input.modelSelection);
		});
		const address = {
			cwd: input.cwd,
			sessionRoot,
			projectId: input.projectId,
			sessionId: result.sessionId,
			chatId: input.chatId,
		};
		this.#clients.set(sessionClientKey(address), started);
		if (this.#clients.get(clientKey) === started) this.#clients.delete(clientKey);
		return { ...address, ...stripSessionId(result) };
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		const started = await this.getOrStartClient(sessionClientKey(input), input);
		return enqueue(started, async () =>
			stripSessionId(
				await this.runPrompt(
					started.client,
					input.text,
					input.rawFrameCursor,
					input.eventCursor,
					input.modelSelection,
				),
			),
		);
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		const started = await this.getOrStartClient(sessionClientKey(input), input);
		await enqueue(started, async () => {
			const result = await runRpcCommand("switch_session", () =>
				started.client.switchSession(input.sessionFile, input.sessionId),
			);
			if (isCancelled(result)) throw new GjcRpcRunnerError("switch_session", "session switch was cancelled");
		});
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		const started = await this.getOrStartClient(sessionClientKey(input), input);
		return enqueue(started, async () => {
			const state = await runRpcCommand("get_state", () => started.client.getState());
			return mapSessionState(state, 0, 0);
		});
	}

	async getAvailableModels(input: GjcSessionStateInput): Promise<readonly unknown[]> {
		const started = await this.getOrStartClient(sessionClientKey(input), input);
		const getAvailableModels = started.client.getAvailableModels;
		if (getAvailableModels === undefined)
			throw new GjcRpcRunnerError("get_available_models", "RPC transport does not support model catalogs");
		return enqueue(started, () => runRpcCommand("get_available_models", getAvailableModels.bind(started.client)));
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		const started = await this.getOrStartClient(sessionClientKey(input), input);
		if (started.client.respondGate === undefined) {
			throw new GjcRpcRunnerError("workflow_gate_response", "RPC transport does not support workflow gates");
		}
		return enqueue(started, async () => {
			const switched = await runRpcCommand("switch_session", () =>
				started.client.switchSession(input.sessionFile, input.sessionId),
			);
			if (isCancelled(switched)) throw new GjcRpcRunnerError("switch_session", "session switch was cancelled");
			const { resolution, workflowGates } = await runRpcCommand("workflow_gate_response", () =>
				respondAndCollectWorkflowGates(started.client, () =>
					callRespondGate(started.client, input.gateId, input.answer, input.idempotencyKey, input.gateCorrelation),
				),
			);
			assertAcceptedWorkflowGateResolution(resolution);
			const state = await runRpcCommand("get_state", () => started.client.getState());
			const assistantText = await runRpcCommand("get_last_assistant_text", () =>
				started.client.getLastAssistantText(),
			);
			return {
				...mapSessionState(state, input.rawFrameCursor, input.eventCursor),
				text: assistantText ?? "",
				events: [
					...(assistantText === null ? [] : [{ type: "assistant", text: assistantText }]),
					...workflowGates.map(toTurnEvent),
				],
			};
		});
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
	): Promise<StartedClient> {
		const existing = this.#clients.get(key);
		if (existing !== undefined) return existing.ready.then(() => existing);
		const client = this.clientFactory({
			cwd: options.cwd,
			sessionRoot: this.resolveSessionRoot(options.cwd),
			...(this.cliPath === undefined ? {} : { cliPath: this.cliPath }),
			runtimeLocations: this.runtimeLocations,
		});
		const readiness = Promise.withResolvers<void>();
		const started: StartedClient = { client, ready: readiness.promise, tail: Promise.resolve() };
		this.#clients.set(key, started);
		void runRpcCommand("start", () => client.start()).then(readiness.resolve, readiness.reject);
		try {
			await started.ready;
			return started;
		} catch (error) {
			if (this.#clients.get(key) === started) {
				this.#clients.delete(key);
				await client.stop();
			}
			throw error;
		}
	}

	private async runPrompt(
		client: GjcRpcRunnerTransport,
		text: string,
		baseRawFrameCursor: number,
		baseEventCursor: number,
		selection?: NormalizedModelSelection,
	): Promise<GjcTurnResult & { readonly sessionId: string }> {
		let modelSelection: NormalizedModelSelection | undefined;
		if (selection !== undefined) {
			await runRpcCommand("get_state", () => client.getState());
			const setter = client.setDefaultModelSelection;
			if (setter === undefined) {
				throw new GjcRpcRunnerError(
					"set_default_model_selection",
					"RPC transport does not support default model selection",
				);
			}
			modelSelection = await runRpcCommand("set_default_model_selection", () =>
				setter.call(client, selection.provider, selection.modelId, selection.thinkingLevel),
			);
		}
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
			...(modelSelection === undefined ? {} : { modelSelection }),
		};
	}
}

async function enqueue<T>(started: StartedClient, operation: () => Promise<T>): Promise<T> {
	const result = started.tail.then(() => started.ready).then(operation);
	started.tail = result.then(releaseQueue, releaseQueue);
	return result;
}

const releaseQueue = (): void => undefined;

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

function sessionClientKey(input: Pick<GjcSessionAddress, "projectId" | "sessionId">): string {
	return `${input.projectId}:${input.sessionId}`;
}

function newSessionClientKey(projectId: string, chatId: string): string {
	return `${projectId}:new:${chatId}`;
}
