import { GjcRpcRunnerError } from "./rpc-errors";
import type { GjcRpcRunnerTransportEvent } from "./rpc-runner";
import type { SdkV3Client } from "./sdk-v3-client";
import { asTransportEvent, parseRecord, requiredString, type SdkRecord, SdkV3OperationError } from "./sdk-v3-protocol";

export interface SdkTurnCorrelation {
	readonly commandId: string;
	readonly turnId: string;
	readonly sessionId: string;
}

export interface SdkTerminalOutcome {
	readonly events: readonly GjcRpcRunnerTransportEvent[];
	readonly finalizedAssistantText?: string;
	readonly gate?: GjcRpcRunnerTransportEvent;
}

export class SdkTerminalWindow {
	readonly #client: SdkV3Client;
	readonly #sessionId: string;
	readonly #frames: SdkRecord[] = [];
	readonly #unsubscribe: () => void;
	#wake: (() => void) | undefined;
	#gateBaseline: ReadonlySet<string> | undefined;
	#activityVersion = 0;
	readonly #checkedAskActions = new Set<string>();

	constructor(client: SdkV3Client, sessionId: string) {
		this.#client = client;
		this.#sessionId = sessionId;
		this.#unsubscribe = client.onFrame(frame => {
			const event = unwrapEvent(frame);
			if (event !== undefined) this.#frames.push(event);
			this.#activityVersion += 1;
			this.#wake?.();
			this.#wake = undefined;
		});
	}

	close(): void {
		this.#unsubscribe();
		this.#wake?.();
		this.#wake = undefined;
	}

	async captureGateBaseline(timeoutMs: number): Promise<void> {
		const gates = await this.queryGates(timeoutMs);
		this.#gateBaseline = new Set(gates.map(gate => gateId(gate)));
	}

	beginMutation(): void {
		if (this.#gateBaseline === undefined) {
			throw new SdkV3OperationError("invalid_state", "Workflow gate baseline was not captured");
		}
		this.#frames.length = 0;
		this.#checkedAskActions.clear();
	}

	async wait(
		correlation: SdkTurnCorrelation,
		timeoutMs: number,
		onGate: (gate: GjcRpcRunnerTransportEvent) => void,
	): Promise<SdkTerminalOutcome> {
		const deadline = Date.now() + timeoutMs;
		if (this.#gateBaseline === undefined) {
			throw new SdkV3OperationError("invalid_state", "Workflow gate baseline was not captured");
		}
		for (;;) {
			const terminal = this.terminalOutcome(correlation);
			if (terminal !== undefined) return terminal;
			const askActionId = this.pendingAskActionId(correlation);
			if (askActionId !== undefined) {
				const gate = await this.resolveGateForAction(correlation, deadline, timeoutMs);
				const terminalAfterQuery = this.terminalOutcome(correlation);
				if (terminalAfterQuery !== undefined) return terminalAfterQuery;
				this.#checkedAskActions.add(askActionId);
				if (gate !== undefined) {
					onGate(gate);
					return this.outcome(gate);
				}
			}
			const idle = this.#frames.find(frame => isCurrentAction(frame, correlation) && frame.kind === "idle");
			if (idle !== undefined) {
				const finalized = this.finalizedTextBefore(this.#frames.indexOf(idle));
				if (finalized !== undefined) return this.outcome(undefined, finalized);
			}
			await this.waitForFrame(deadline, timeoutMs);
		}
	}

	private pendingAskActionId(correlation: SdkTurnCorrelation): string | undefined {
		for (const frame of this.#frames) {
			if (!isCurrentAction(frame, correlation) || frame.kind !== "ask") continue;
			const actionId = frame.id;
			if (typeof actionId === "string" && actionId.length > 0 && !this.#checkedAskActions.has(actionId)) {
				return actionId;
			}
		}
		return undefined;
	}

	private async resolveGateForAction(
		correlation: SdkTurnCorrelation,
		deadline: number,
		timeoutMs: number,
	): Promise<GjcRpcRunnerTransportEvent | undefined> {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				const gate = await this.resolveNewGate(correlation, deadline, timeoutMs);
				if (gate !== undefined) return gate;
			} catch (error) {
				if (this.terminalOutcome(correlation) !== undefined) return undefined;
				throw error;
			}
			if (this.terminalOutcome(correlation) !== undefined) return undefined;
			if (attempt < 4) await this.waitForFrame(deadline, timeoutMs, 50);
		}
		return undefined;
	}

	private terminalOutcome(correlation: SdkTurnCorrelation): SdkTerminalOutcome | undefined {
		const failed = this.#frames.find(frame => isTerminal(frame, "agent_failed", correlation));
		if (failed !== undefined) throw promptFailure(failed);
		return this.#frames.some(frame => isTerminal(frame, "agent_end", correlation)) ? this.outcome() : undefined;
	}

	private async resolveNewGate(
		correlation: SdkTurnCorrelation,
		deadline: number,
		timeoutMs: number,
	): Promise<GjcRpcRunnerTransportEvent | undefined> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new SdkV3OperationError("timeout", `Prompt terminal timed out after ${timeoutMs}ms`);
		}
		const gates = await this.queryGates(remaining);
		const matches = gates.filter(gate => !this.#gateBaseline?.has(gateId(gate)));
		if (matches.length > 1) {
			throw new SdkV3OperationError(
				"invalid_result",
				`SDK turn opened ${matches.length} new durable workflow gates`,
			);
		}
		const match = matches[0];
		if (match === undefined) return undefined;
		const id = gateId(match);
		const gate = { ...match, type: "workflow_gate", gateId: id, ...correlation };
		return asTransportEvent(gate, "workflow gate");
	}

	private async queryGates(timeoutMs: number): Promise<readonly SdkRecord[]> {
		const values = await this.#client.queryAll("workflow.gates.list", {}, timeoutMs);
		return values.map((value, index) => parseRecord(value, `workflow.gates.list[${index}]`));
	}

	private outcome(gate?: GjcRpcRunnerTransportEvent, finalized = this.latestFinalizedText()): SdkTerminalOutcome {
		return {
			events: [...this.#frames.map(frame => asTransportEvent(frame)), ...(gate === undefined ? [] : [gate])],
			...(finalized === undefined ? {} : { finalizedAssistantText: finalized }),
			...(gate === undefined ? {} : { gate }),
		};
	}

	private latestFinalizedText(): string | undefined {
		return this.finalizedTextBefore(this.#frames.length);
	}

	private finalizedTextBefore(index: number): string | undefined {
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
			const frame = this.#frames[cursor];
			if (
				frame?.type === "turn_stream" &&
				frame.sessionId === this.#sessionId &&
				frame.phase === "finalized" &&
				frame.finalAnswer === true &&
				typeof frame.text === "string"
			) {
				return frame.text;
			}
		}
		return undefined;
	}

	private async waitForFrame(deadline: number, timeoutMs: number, maximumDelay?: number): Promise<void> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new SdkV3OperationError("timeout", `Prompt terminal timed out after ${timeoutMs}ms`);
		}
		const activityVersion = this.#activityVersion;
		await new Promise<void>((resolve, reject) => {
			const pollDelay = Math.min(maximumDelay ?? remaining, remaining);
			const timeout = setTimeout(() => {
				if (maximumDelay === undefined || pollDelay === remaining) {
					reject(new SdkV3OperationError("timeout", `Prompt terminal timed out after ${timeoutMs}ms`));
				} else {
					resolve();
				}
			}, pollDelay);
			timeout.unref?.();
			this.#wake = () => {
				clearTimeout(timeout);
				resolve();
			};
			if (this.#activityVersion !== activityVersion) {
				this.#wake();
				this.#wake = undefined;
			}
		});
	}
}

function unwrapEvent(frame: SdkRecord): SdkRecord | undefined {
	if (frame.type === "event") return parseRecord(frame.payload, "event payload");
	return typeof frame.type === "string" && !frame.type.endsWith("_response") ? frame : undefined;
}

function isTerminal(frame: SdkRecord, type: string, correlation: SdkTurnCorrelation): boolean {
	return (
		frame.type === type &&
		frame.sessionId === correlation.sessionId &&
		frame.commandId === correlation.commandId &&
		frame.turnId === correlation.turnId
	);
}

function isCurrentAction(frame: SdkRecord, correlation: SdkTurnCorrelation): boolean {
	if (frame.type !== "action_needed") return false;
	const hasCorrelation = typeof frame.commandId === "string" || typeof frame.turnId === "string";
	return hasCorrelation
		? frame.commandId === correlation.commandId && frame.turnId === correlation.turnId
		: frame.sessionId === correlation.sessionId;
}

function gateId(gate: SdkRecord): string {
	const value = gate.gate_id ?? gate.gateId ?? gate.id;
	if (typeof value !== "string" || value.length === 0) {
		throw new SdkV3OperationError("invalid_result", "durable workflow gate omitted its id");
	}
	return value;
}

function promptFailure(frame: SdkRecord): GjcRpcRunnerError {
	const error = parseRecord(frame.error, "agent_failed.error");
	return new GjcRpcRunnerError("prompt", requiredString(error, "message", "agent_failed.error"));
}
