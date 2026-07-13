import type { NormalizedModelSelection } from "../contracts";
import type { GjcRpcRunnerTransportEvent, GjcRpcSelectionTransport, GjcRpcTransportState } from "./rpc-runner";
import { ensureCapabilityCatalog, SdkV3OperationError } from "./sdk-v3-protocol";

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

interface FullSessionEventClient {
	onSessionEvent(listener: (event: GjcRpcRunnerTransportEvent) => void): () => void;
}

export function createRpcTransportFromClient(client: RpcClientTransportClient): GjcRpcSelectionTransport {
	return new ClientBackedTransport(client);
}

class ClientBackedTransport implements GjcRpcSelectionTransport {
	constructor(private readonly client: RpcClientTransportClient) {}
	async start(): Promise<void> {
		await this.client.start();
	}
	stop(): void {
		this.client.stop();
	}
	async newSession(): Promise<{ readonly cancelled: boolean }> {
		return this.client.newSession();
	}
	async switchSession(sessionPath?: string): Promise<{ readonly cancelled: boolean }> {
		if (sessionPath === undefined) throw new TypeError("Legacy test client requires a session path");
		return this.client.switchSession(sessionPath);
	}
	async getState(): Promise<GjcRpcTransportState> {
		return this.client.getState();
	}
	async getAvailableModels(): Promise<readonly unknown[]> {
		const getModels = this.client.getAvailableModels;
		if (getModels === undefined) throw new TypeError("RPC client does not support model catalogs");
		return ensureCapabilityCatalog(await getModels.call(this.client));
	}
	async setDefaultModelSelection(
		provider: string,
		modelId: string,
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
	): Promise<NormalizedModelSelection> {
		const setSelection = this.client.setDefaultModelSelection;
		if (setSelection === undefined) throw new TypeError("RPC client does not support model selection");
		return setSelection.call(this.client, provider, modelId, thinkingLevel);
	}
	async promptAndWait(message: string, timeoutMs = 60_000): Promise<readonly GjcRpcRunnerTransportEvent[]> {
		const events: GjcRpcRunnerTransportEvent[] = [];
		const sessionListener = supportsFullSessionEvents(this.client)
			? this.client.onSessionEvent.bind(this.client)
			: this.client.onEvent.bind(this.client);
		return new Promise<readonly GjcRpcRunnerTransportEvent[]>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new SdkV3OperationError("timeout", "Prompt terminal timed out")),
				timeoutMs,
			);
			const unsubscribeEvent = sessionListener(event => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timeout);
					unsubscribeEvent();
					unsubscribeGate();
					resolve(events);
				}
			});
			const unsubscribeGate = this.client.onWorkflowGate(gate => {
				clearTimeout(timeout);
				unsubscribeEvent();
				unsubscribeGate();
				resolve([...events, gate]);
			});
			void this.client.prompt(message).catch(error => {
				clearTimeout(timeout);
				unsubscribeEvent();
				unsubscribeGate();
				reject(error instanceof Error ? error : new TypeError("Prompt failed"));
			});
		});
	}
	onWorkflowGate(listener: (gate: GjcRpcRunnerTransportEvent) => void): () => void {
		return this.client.onWorkflowGate(listener);
	}
	async respondGate(gateId: string, answer: unknown, idempotencyKey?: string): Promise<unknown> {
		return this.client.respondGate(gateId, answer, idempotencyKey);
	}
	async getLastAssistantText(): Promise<string | null> {
		return this.client.getLastAssistantText();
	}
}

function supportsFullSessionEvents(
	client: RpcClientTransportClient,
): client is RpcClientTransportClient & FullSessionEventClient {
	return "onSessionEvent" in client && typeof client.onSessionEvent === "function";
}
