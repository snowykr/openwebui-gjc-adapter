import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type { GjcRpcRunnerClientOptions, GjcRpcRunnerTransport, GjcRpcRunnerTransportEvent } from "./rpc-runner";

export function createDefaultRpcTransport(options: GjcRpcRunnerClientOptions): GjcRpcRunnerTransport {
	return new RpcClientTransport(options);
}

class RpcClientTransport implements GjcRpcRunnerTransport {
	readonly #client: RpcClient;

	constructor(options: GjcRpcRunnerClientOptions) {
		this.#client = new RpcClient({ cwd: options.cwd, sessionDir: options.sessionRoot, cliPath: options.cliPath });
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
			unsubscribeEvent = this.#client.onEvent(event => {
				events.push(event);
				if (event.type === "agent_end") finish([...events]);
			});
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
