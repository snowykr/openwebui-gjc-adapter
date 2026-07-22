import type { PublicSdkGate, PublicSdkTurnCorrelation, PublicSdkTurnOutcome } from "./public-sdk-contract";
import type { SdkV3Client } from "./sdk-v3-client";
import { parseRecord, requiredString, type SdkRecord, SdkV3OperationError } from "./sdk-v3-protocol";

export type SdkTurnCorrelation = PublicSdkTurnCorrelation;
export type SdkTerminalOutcome = PublicSdkTurnOutcome;

/**
 * Observes exactly one accepted mutation. Frames received before accept() are
 * quarantined and can never complete that mutation.
 */
export class SdkTerminalWindow {
	readonly #client: SdkV3Client;
	readonly #sessionId: string;
	readonly #frames: SdkRecord[] = [];
	readonly #unsubscribe: () => void;
	readonly #waiters = new Set<() => void>();
	#gateBaseline: ReadonlySet<string> | undefined;
	#acceptedAt: number | undefined;
	#activityVersion = 0;
	readonly #checkedActions = new Set<string>();

	constructor(client: SdkV3Client, sessionId: string) {
		this.#client = client;
		this.#sessionId = sessionId;
		this.#unsubscribe = client.onFrame(frame => {
			if (typeof frame.type !== "string") return;
			this.#frames.push(frame);
			this.#activityVersion += 1;
			for (const wake of this.#waiters) wake();
			this.#waiters.clear();
		});
	}

	close(): void {
		this.#unsubscribe();
		for (const wake of this.#waiters) wake();
		this.#waiters.clear();
	}

	async captureGateBaseline(timeoutMs: number): Promise<void> {
		this.#gateBaseline = new Set((await this.queryGates(timeoutMs)).map(gateId));
	}

	beginMutation(): void {
		if (this.#gateBaseline === undefined)
			throw new SdkV3OperationError("invalid_state", "Workflow gate baseline was not captured");
		if (this.#acceptedAt !== undefined)
			throw new SdkV3OperationError("invalid_state", "Only one mutation is allowed per terminal attachment");
		this.#checkedActions.clear();
	}

	accept(correlation: SdkTurnCorrelation): void {
		if (correlation.sessionId !== this.#sessionId)
			throw new SdkV3OperationError("endpoint_stale", "Accepted turn belongs to another session");
		if (this.#acceptedAt !== undefined)
			throw new SdkV3OperationError("invalid_state", "Only one mutation is allowed per terminal attachment");
		this.#acceptedAt = this.#frames.length;
	}

	async wait(
		correlation: SdkTurnCorrelation,
		timeoutMs: number,
		onGate?: (gate: PublicSdkGate) => void,
	): Promise<SdkTerminalOutcome> {
		if (this.#acceptedAt === undefined || this.#gateBaseline === undefined)
			throw new SdkV3OperationError("invalid_state", "Mutation was not accepted");
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const terminal = this.terminalOutcome(correlation);
			if (terminal !== undefined) return terminal;
			const action = this.pendingAction(correlation);
			if (action !== undefined) {
				const gate = await this.resolveGate(action, correlation, deadline, timeoutMs);
				const afterLookup = this.terminalOutcome(correlation);
				if (afterLookup !== undefined) return afterLookup;
				this.#checkedActions.add(action.id);
				if (gate !== undefined) {
					onGate?.(gate);
					return this.outcome(correlation, gate);
				}
			}
			await this.waitForFrame(deadline, timeoutMs);
		}
	}

	private postAcceptFrames(): readonly SdkRecord[] {
		return this.#frames.slice(this.#acceptedAt);
	}
	private postAcceptEvents(): readonly SdkRecord[] {
		return this.postAcceptFrames()
			.map(normalizeEvent)
			.filter((frame): frame is SdkRecord => frame !== undefined);
	}

	private pendingAction(
		correlation: SdkTurnCorrelation,
	): { readonly id: string; readonly workflowGateId?: string } | undefined {
		for (const frame of this.postAcceptEvents()) {
			if (frame.type !== "action_needed" || !matchesAction(frame, correlation)) continue;
			const id = frame.actionId ?? frame.id;
			if (typeof id !== "string" || id.length === 0 || this.#checkedActions.has(id)) continue;
			const workflowGateId = frame.workflowGateId;
			if (workflowGateId !== undefined && (typeof workflowGateId !== "string" || workflowGateId.length === 0))
				throw new SdkV3OperationError("invalid_result", "action_needed.workflowGateId must be a non-empty string");
			return { id, ...(typeof workflowGateId === "string" ? { workflowGateId } : {}) };
		}
		return undefined;
	}

	private terminalOutcome(correlation: SdkTurnCorrelation): SdkTerminalOutcome | undefined {
		const failed = this.postAcceptEvents().find(
			frame => frame.type === "agent_failed" && matches(frame, correlation),
		);
		if (failed !== undefined) throw new SdkV3OperationError("prompt_failed", failureMessage(failed));
		return this.postAcceptEvents().some(frame => frame.type === "agent_end" && matches(frame, correlation))
			? this.outcome(correlation)
			: undefined;
	}

	private async resolveGate(
		action: { readonly id: string; readonly workflowGateId?: string },
		correlation: SdkTurnCorrelation,
		deadline: number,
		timeoutMs: number,
	): Promise<PublicSdkGate | undefined> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new SdkV3OperationError("timeout", `Prompt terminal timed out after ${timeoutMs}ms`);
		const result = await Promise.race([
			this.queryGates(remaining).then(gates => ({ gates })),
			this.waitForTerminal(correlation, deadline, timeoutMs).then(() => ({})),
		]);
		if (!("gates" in result)) return undefined;
		const newGates = result.gates.filter(gate => !this.#gateBaseline?.has(gateId(gate)));
		const matchingGates =
			action.workflowGateId === undefined
				? newGates
				: newGates.filter(gate => gateId(gate) === action.workflowGateId);
		if (matchingGates.length > 1)
			throw new SdkV3OperationError(
				"invalid_result",
				`SDK turn opened ${matchingGates.length} new durable workflow gates`,
			);
		const gate = matchingGates[0];
		return gate === undefined ? undefined : { gateId: gateId(gate), correlation, payload: gate };
	}

	private async queryGates(timeoutMs: number): Promise<readonly SdkRecord[]> {
		return (await this.#client.queryAll("workflow.gates.list", {}, timeoutMs)).map((value, index) =>
			parseRecord(value, `workflow.gates.list[${index}]`),
		);
	}

	private outcome(
		correlation: SdkTurnCorrelation,
		gate?: PublicSdkGate,
		finalizedAssistantText = this.finalizedText(correlation),
	): SdkTerminalOutcome {
		return {
			events: this.postAcceptEvents(),
			...(finalizedAssistantText === undefined ? {} : { finalizedAssistantText }),
			...(gate === undefined ? {} : { gate }),
		};
	}

	private finalizedText(correlation: SdkTurnCorrelation): string | undefined {
		const events = this.postAcceptEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const frame = events[index]!;
			const hasMatchingLiveStream = events
				.slice(0, index)
				.some(
					previous =>
						previous.type === "turn_stream" &&
						previous.phase === "live" &&
						previous.sessionId === correlation.sessionId &&
						typeof frame.messageRef === "string" &&
						frame.messageRef.length > 0 &&
						previous.messageRef === frame.messageRef,
				);
			if (
				frame.type === "turn_stream" &&
				(matchesTurnStream(frame, correlation) ||
					(hasMatchingLiveStream && matchesSessionOnlyTurnStream(frame, correlation))) &&
				frame.phase === "finalized" &&
				frame.finalAnswer === true &&
				typeof frame.text === "string"
			)
				return frame.text;
		}
		return undefined;
	}
	private async waitForTerminal(correlation: SdkTurnCorrelation, deadline: number, timeoutMs: number): Promise<void> {
		while (this.terminalOutcome(correlation) === undefined) await this.waitForFrame(deadline, timeoutMs);
	}

	private async waitForFrame(deadline: number, timeoutMs: number): Promise<void> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new SdkV3OperationError("timeout", `Prompt terminal timed out after ${timeoutMs}ms`);
		const version = this.#activityVersion;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#waiters.delete(wake);
				reject(new SdkV3OperationError("timeout", `Prompt terminal timed out after ${timeoutMs}ms`));
			}, remaining);
			timeout.unref?.();
			const wake = () => {
				clearTimeout(timeout);
				resolve();
			};
			this.#waiters.add(wake);
			if (version !== this.#activityVersion) {
				this.#waiters.delete(wake);
				wake();
			}
		});
	}
}

function normalizeEvent(frame: SdkRecord): SdkRecord | undefined {
	if (frame.type === "event") {
		const payload = recordOrUndefined(frame.payload);
		if (payload === undefined) return undefined;
		const event = unwrapEmbeddedEvent(payload, payload.event_type);
		if (event !== undefined) return event;
		if (payload.type !== "event") return payload;
		return normalizeSessionEvent(payload);
	}
	if (isPayloadWrappedTerminal(frame)) {
		const payload = recordOrUndefined(frame.payload);
		return payload?.type === frame.type ? payload : undefined;
	}
	return typeof frame.type === "string" && !frame.type.endsWith("_response") ? frame : undefined;
}

function isPayloadWrappedTerminal(frame: SdkRecord): boolean {
	return (
		(frame.type === "turn_stream" ||
			frame.type === "agent_end" ||
			frame.type === "agent_failed" ||
			frame.type === "action_needed") &&
		"payload" in frame
	);
}

function normalizeSessionEvent(frame: SdkRecord): SdkRecord | undefined {
	if (typeof frame.kind !== "string") return undefined;
	const payload = recordOrUndefined(frame.payload);
	if (payload === undefined) return undefined;
	return unwrapEmbeddedEvent(payload, frame.kind) ?? { ...payload, type: frame.kind };
}

function unwrapEmbeddedEvent(payload: SdkRecord, type: unknown): SdkRecord | undefined {
	const event = recordOrUndefined(payload.event);
	if (event === undefined || typeof type !== "string") return undefined;
	const { event: _event, event_type: _eventType, ...metadata } = payload;
	return { ...metadata, ...event, type };
}

function recordOrUndefined(value: unknown): SdkRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SdkRecord) : undefined;
}
function matches(frame: SdkRecord, correlation: SdkTurnCorrelation): boolean {
	const nested = frame.correlation === undefined ? frame : recordOrUndefined(frame.correlation);
	return (
		nested !== undefined &&
		nested.sessionId === correlation.sessionId &&
		nested.commandId === correlation.commandId &&
		nested.turnId === correlation.turnId
	);
}
function matchesTurnStream(frame: SdkRecord, correlation: SdkTurnCorrelation): boolean {
	return (
		frame.sessionId === correlation.sessionId &&
		frame.commandId === correlation.commandId &&
		frame.turnId === correlation.turnId
	);
}

function matchesSessionOnlyTurnStream(frame: SdkRecord, correlation: SdkTurnCorrelation): boolean {
	return frame.sessionId === correlation.sessionId && frame.commandId === undefined && frame.turnId === undefined;
}
function matchesAction(frame: SdkRecord, correlation: SdkTurnCorrelation): boolean {
	if (frame.sessionId !== correlation.sessionId) return false;
	const commandId = frame.commandId;
	const turnId = frame.turnId;
	return (
		(commandId === undefined && turnId === undefined) ||
		(commandId === correlation.commandId && turnId === correlation.turnId)
	);
}
function gateId(gate: SdkRecord): string {
	const value = gate.gate_id ?? gate.gateId ?? gate.id;
	if (typeof value !== "string" || value.length === 0)
		throw new SdkV3OperationError("invalid_result", "durable workflow gate omitted its id");
	return value;
}
function failureMessage(frame: SdkRecord): string {
	return typeof frame.error === "object" && frame.error !== null
		? requiredString(parseRecord(frame.error, "agent_failed.error"), "message", "agent_failed.error")
		: "SDK prompt failed";
}
