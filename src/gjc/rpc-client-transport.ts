import { RpcClient } from "@gajae-code/coding-agent";
import type { NormalizedModelSelection } from "../contracts";
import type {
	GjcRpcRunnerClientOptions,
	GjcRpcRunnerTransportEvent,
	GjcRpcSelectionTransport,
	GjcRpcTransportState,
} from "./rpc-runner";

export interface RpcClientTransportClient {
	start(): Promise<void>;
	stop(): void;
	newSession(): Promise<{ readonly cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<{ readonly cancelled: boolean }>;
	getState(): Promise<GjcRpcTransportState>;
	getAvailableModels?(): Promise<readonly unknown[]>;
	setDefaultModelSelection?(
		provider: string,
		modelId: string,
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
	): Promise<NormalizedModelSelection>;
	prompt(message: string): Promise<void>;
	onEvent(listener: (event: GjcRpcRunnerTransportEvent) => void): () => void;
	onWorkflowGate(listener: (gate: GjcRpcRunnerTransportEvent) => void): () => void;
	respondGate(gateId: string, answer: unknown, idempotencyKey?: string): Promise<unknown>;
	getLastAssistantText(): Promise<string | null>;
	getStderr(): string;
}

interface FullSessionEventRpcClient {
	onSessionEvent(listener: (event: GjcRpcRunnerTransportEvent) => void): () => void;
}

export function createDefaultRpcTransport(options: GjcRpcRunnerClientOptions): GjcRpcSelectionTransport {
	if (options.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	return createRpcTransportFromClient(
		new RpcClient({
			cwd: options.cwd,
			sessionDir: options.sessionRoot,
			cliPath: options.cliPath,
			env: { ...options.runtimeLocations.childEnvironment, PI_CONFIG_DIR: undefined },
		}),
	);
}

export function createRpcTransportFromClient(client: RpcClientTransportClient): GjcRpcSelectionTransport {
	return new RpcClientTransport(client);
}

class RpcClientTransport implements GjcRpcSelectionTransport {
	readonly #client: RpcClientTransportClient;

	constructor(client: RpcClientTransportClient) {
		this.#client = client;
	}

	async start(): Promise<void> {
		await this.#client.start();
	}

	stop(): void {
		this.#client.stop();
	}

	async newSession(): Promise<{ readonly cancelled: boolean }> {
		return this.#client.newSession();
	}

	async switchSession(sessionPath: string): Promise<{ readonly cancelled: boolean }> {
		return this.#client.switchSession(sessionPath);
	}

	async getState() {
		return this.#client.getState();
	}

	async getAvailableModels(): Promise<readonly unknown[]> {
		const getAvailableModels = this.#client.getAvailableModels;
		if (getAvailableModels === undefined) throw new TypeError("RPC client does not support model catalogs");
		return getAvailableModels.call(this.#client);
	}

	async setDefaultModelSelection(
		provider: string,
		modelId: string,
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
	): Promise<NormalizedModelSelection> {
		const setDefaultModelSelection = this.#client.setDefaultModelSelection;
		if (setDefaultModelSelection === undefined) throw new TypeError("RPC client does not support model selection");
		return setDefaultModelSelection.call(this.#client, provider, modelId, thinkingLevel);
	}

	async promptAndWait(message: string, timeoutMs?: number): Promise<readonly GjcRpcRunnerTransportEvent[]> {
		const timeout = timeoutMs ?? 60_000;
		const events: GjcRpcRunnerTransportEvent[] = [];
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let unsubscribeEvent: (() => void) | undefined;
		let unsubscribeGate: (() => void) | undefined;

		const cleanup = () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			unsubscribeEvent?.();
			unsubscribeGate?.();
		};
		const collected = new Promise<readonly GjcRpcRunnerTransportEvent[]>((resolve, reject) => {
			const finish = (value: readonly GjcRpcRunnerTransportEvent[]) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};
			if (supportsFullSessionEvents(this.#client)) {
				unsubscribeEvent = this.#client.onSessionEvent(event => {
					events.push(event);
					if (event.type === "agent_end") finish([...events]);
				});
			} else {
				unsubscribeEvent = this.#client.onEvent(event => {
					events.push(event);
					if (event.type === "agent_end") finish([...events]);
				});
			}
			unsubscribeGate = this.#client.onWorkflowGate(gate => {
				finish([...events, gate]);
			});
			timeoutId = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(`Timeout collecting events. Stderr: ${this.#client.getStderr()}`));
			}, timeout);
			timeoutId.unref?.();
		});

		try {
			await this.#client.prompt(message);
			return await collected;
		} catch (error) {
			cleanup();
			throw error;
		}
	}

	onWorkflowGate(listener: (gate: GjcRpcRunnerTransportEvent) => void): () => void {
		return this.#client.onWorkflowGate(gate => listener(gate));
	}

	async respondGate(gateId: string, answer: unknown, idempotencyKey?: string): Promise<unknown> {
		return this.#client.respondGate(gateId, answer, idempotencyKey);
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#client.getLastAssistantText();
	}
}

function supportsFullSessionEvents(
	client: RpcClientTransportClient,
): client is RpcClientTransportClient & FullSessionEventRpcClient {
	return "onSessionEvent" in client && typeof client.onSessionEvent === "function";
}
