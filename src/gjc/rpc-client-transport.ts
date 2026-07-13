import { randomUUID } from "node:crypto";
import type { NormalizedModelSelection } from "../contracts";
import type {
	GjcRpcRunnerClientOptions,
	GjcRpcRunnerTransportEvent,
	GjcRpcSelectionTransport,
	GjcRpcTransportState,
} from "./rpc-runner";
import { SdkV3Cli } from "./sdk-v3-cli";
import { SdkV3Client } from "./sdk-v3-client";
import {
	ensureCapabilityCatalog,
	parseLastAssistant,
	parseRecord,
	parseSelection,
	parseState,
	requiredString,
	type SdkSessionAuthority,
	SdkV3OperationError,
} from "./sdk-v3-protocol";
import { SdkTerminalWindow, type SdkTurnCorrelation } from "./sdk-v3-terminal";
import { resolveGjcSdkSessionRoot } from "./session-root";

export { createRpcTransportFromClient, type RpcClientTransportClient } from "./rpc-client-test-adapter";

export function createDefaultRpcTransport(options: GjcRpcRunnerClientOptions): GjcRpcSelectionTransport {
	if (options.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	const environment: Record<string, string | undefined> = {
		...process.env,
		...options.runtimeLocations.childEnvironment,
		PI_CONFIG_DIR: undefined,
	};
	for (const name of Object.keys(environment)) {
		if (name.startsWith("GJC_OPENWEBUI_")) environment[name] = undefined;
	}
	return new SdkV3Transport(
		new SdkV3Cli({
			cliPath: options.cliPath ?? "gjc",
			cwd: options.cwd,
			agentDir: options.runtimeLocations.agentDir,
			sessionRoot: resolveGjcSdkSessionRoot(options.cwd, options.runtimeLocations),
			environment,
		}),
	);
}

class SdkV3Transport implements GjcRpcSelectionTransport {
	readonly #cli: SdkV3Cli;
	readonly #gateListeners = new Set<(gate: GjcRpcRunnerTransportEvent) => void>();
	#authority: SdkSessionAuthority | undefined;
	#client: SdkV3Client | undefined;
	#ephemeralSessionId: string | undefined;
	#lastFinalizedAssistantText: string | undefined;
	readonly #pendingGateTurns = new Map<string, SdkTurnCorrelation>();

	constructor(cli: SdkV3Cli) {
		this.#cli = cli;
	}

	async start(): Promise<void> {}

	async stop(): Promise<void> {
		const client = this.#client;
		const ephemeralSessionId = this.#ephemeralSessionId;
		this.#client = undefined;
		this.#authority = undefined;
		this.#ephemeralSessionId = undefined;
		this.#pendingGateTurns.clear();
		client?.close();
		if (ephemeralSessionId === undefined) return;
		await this.#cli.closeSession(ephemeralSessionId, randomUUID());
	}

	async newSession(): Promise<{ readonly cancelled: boolean }> {
		await this.connect(await this.#cli.createSession(randomUUID()));
		return { cancelled: false };
	}

	async newEphemeralSession(): Promise<void> {
		const authority = await this.#cli.createSession(randomUUID());
		this.#ephemeralSessionId = authority.sessionId;
		await this.connect(authority);
	}

	async switchSession(sessionPath?: string, sessionId?: string): Promise<{ readonly cancelled: boolean }> {
		if (sessionId === undefined) throw new SdkV3OperationError("invalid_input", "sessionId is required to resume");
		const saved = await this.#cli.resolveSession(sessionId);
		if (sessionPath !== undefined && saved.path !== sessionPath)
			throw new SdkV3OperationError("endpoint_stale", "Saved SDK session path no longer matches the mapping");
		await this.connect(await this.#cli.resumeSession(saved.sessionId, saved.path, randomUUID()));
		return { cancelled: false };
	}

	async getState(): Promise<GjcRpcTransportState> {
		const { client, authority } = this.connected();
		const [metadata, config] = await Promise.all([
			this.singleQuery(client, "session.metadata"),
			this.singleQuery(client, "config.list/get"),
		]);
		return parseState(metadata, config, authority);
	}

	async getAvailableModels(): Promise<readonly unknown[]> {
		return ensureCapabilityCatalog(await this.connected().client.queryAll("models.list/current"));
	}

	async setDefaultModelSelection(
		provider: string,
		modelId: string,
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
	): Promise<NormalizedModelSelection> {
		const result = await this.connected().client.control("model.set", {
			id: `${provider}/${modelId}`,
			thinkingLevel,
		});
		return parseSelection(result);
	}

	async promptAndWait(message: string, timeoutMs = 60_000): Promise<readonly GjcRpcRunnerTransportEvent[]> {
		const { client, authority } = this.connected();
		const deadline = Date.now() + timeoutMs;
		this.#lastFinalizedAssistantText = undefined;
		const window = new SdkTerminalWindow(client, authority.sessionId);
		try {
			await window.captureGateBaseline(remainingTimeout(deadline, timeoutMs));
			window.beginMutation();
			const result = parseRecord(
				await client.control("turn.prompt", { text: message }, remainingTimeout(deadline, timeoutMs)),
				"turn.prompt result",
			);
			const commandId = requiredString(result, "commandId", "turn.prompt result");
			const turnId = requiredString(result, "turnId", "turn.prompt result");
			const correlation = {
				commandId,
				turnId,
				sessionId: authority.sessionId,
			};
			const outcome = await window.wait(correlation, remainingTimeout(deadline, timeoutMs), gate =>
				this.emitGate(gate),
			);
			if (outcome.finalizedAssistantText !== undefined) {
				this.#lastFinalizedAssistantText = outcome.finalizedAssistantText;
			}
			if (outcome.gate !== undefined) {
				const gateId = outcome.gate.gateId;
				if (gateId === undefined) {
					throw new SdkV3OperationError("invalid_result", "Workflow gate omitted its normalized id");
				}
				this.#pendingGateTurns.set(gateId, correlation);
			}
			return outcome.events;
		} finally {
			window.close();
		}
	}

	onWorkflowGate(listener: (gate: GjcRpcRunnerTransportEvent) => void): () => void {
		this.#gateListeners.add(listener);
		return () => this.#gateListeners.delete(listener);
	}

	async respondGate(
		gateId: string,
		answer: unknown,
		idempotencyKey?: string,
		persistedCorrelation?: SdkTurnCorrelation,
	): Promise<unknown> {
		const { client, authority } = this.connected();
		const correlation = this.#pendingGateTurns.get(gateId) ?? persistedCorrelation;
		if (correlation === undefined || correlation.sessionId !== authority.sessionId) {
			throw new SdkV3OperationError("endpoint_stale", "Workflow gate is not bound to the connected SDK turn");
		}
		const timeoutMs = 60_000;
		const deadline = Date.now() + timeoutMs;
		const window = new SdkTerminalWindow(client, authority.sessionId);
		try {
			await window.captureGateBaseline(remainingTimeout(deadline, timeoutMs));
			window.beginMutation();
			const result = await client.control(
				"workflow.gate_answer",
				{ id: gateId, response: answer },
				remainingTimeout(deadline, timeoutMs),
				idempotencyKey,
			);
			const outcome = await window.wait(correlation, remainingTimeout(deadline, timeoutMs), gate =>
				this.emitGate(gate),
			);
			if (outcome.finalizedAssistantText !== undefined) {
				this.#lastFinalizedAssistantText = outcome.finalizedAssistantText;
			}
			this.#pendingGateTurns.delete(gateId);
			if (outcome.gate?.gateId !== undefined) {
				this.#pendingGateTurns.set(outcome.gate.gateId, correlation);
			}
			return result;
		} finally {
			window.close();
		}
	}

	async getLastAssistantText(): Promise<string | null> {
		try {
			return parseLastAssistant(await this.connected().client.queryAll("session.last_assistant"));
		} catch (error) {
			if (error instanceof SdkV3OperationError && error.code === "resource_gone") {
				return this.#lastFinalizedAssistantText ?? null;
			}
			throw error;
		}
	}

	private async connect(authority: SdkSessionAuthority): Promise<void> {
		this.#client?.close();
		this.#client = undefined;
		this.#authority = undefined;
		this.#lastFinalizedAssistantText = undefined;
		this.#pendingGateTurns.clear();
		const client = new SdkV3Client(authority.endpoint);
		try {
			await client.connect();
		} catch (error) {
			client.close();
			throw error;
		}
		this.#client = client;
		this.#authority = authority;
	}

	private connected(): { readonly client: SdkV3Client; readonly authority: SdkSessionAuthority } {
		if (this.#client === undefined || this.#authority === undefined) {
			throw new SdkV3OperationError("session_unavailable", "No SDK session is connected");
		}
		return { client: this.#client, authority: this.#authority };
	}

	private async singleQuery(client: SdkV3Client, query: string): Promise<unknown> {
		const items = await client.queryAll(query);
		if (items.length !== 1)
			throw new SdkV3OperationError("invalid_result", `${query} returned ${items.length} items`);
		return items[0];
	}

	private emitGate(gate: GjcRpcRunnerTransportEvent): void {
		for (const listener of this.#gateListeners) listener(gate);
	}
}

function remainingTimeout(deadline: number, budgetMs: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new SdkV3OperationError("timeout", `SDK turn timed out after ${budgetMs}ms`);
	return remaining;
}
