import type { SessionOperation } from "../gjc/session-authority";
import {
	closeIngressId,
	type SessionCloseIngress,
	type SessionCloseResult,
	type SessionMapping,
} from "../gjc/session-router";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";

export const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 600_000;

type MappingStore = Pick<import("../gjc/session-router").SessionMappingStore, "get" | "entries" | "operation">;
type SessionCloser = (mapping: SessionMapping, ingress: SessionCloseIngress) => Promise<SessionCloseResult>;
type IdleTimer = ReturnType<typeof setTimeout>;
type TimerFactory = (handler: () => void, timeoutMs: number) => IdleTimer;
type TimerClearer = (timer: IdleTimer) => void;
type RunOutcome = "turn" | "control" | "failure";

export interface CreateGjcIdleSessionReaperInput {
	readonly runner: LiveGatewayRunner;
	readonly mappings: MappingStore;
	readonly closeSession: SessionCloser;
	readonly idleTimeoutMs?: number;
	readonly now?: () => number;
	readonly setTimeout?: TimerFactory;
	readonly clearTimeout?: TimerClearer;
	readonly discardSessionAttachment?: (cwd: string, sessionId: string) => void;
}

export interface GjcIdleSessionReaper {
	readonly runner: LiveGatewayRunner;
	readonly closeSession: SessionCloser;
	stop(): Promise<void>;
}

export function createGjcIdleSessionReaper(input: CreateGjcIdleSessionReaperInput): GjcIdleSessionReaper {
	const reaper = new IdleSessionReaper(input);
	return {
		runner: reaper.runner,
		closeSession: reaper.closeSession,
		stop: () => reaper.stop(),
	};
}

class IdleSessionReaper {
	readonly runner: LiveGatewayRunner = {
		run: turn => this.run(turn),
		stop: () => this.stop(),
	};
	readonly closeSession: SessionCloser = (mapping, ingress) => this.closeExternal(mapping, ingress);
	readonly #states = new Map<string, ChatState>();
	readonly #timeoutMs: number;
	readonly #now: () => number;
	readonly #setTimeout: TimerFactory;
	readonly #clearTimeout: TimerClearer;
	#timer: IdleTimer | undefined;
	#stopped = false;
	#baseStopped = false;

	constructor(private readonly input: CreateGjcIdleSessionReaperInput) {
		const timeoutMs = input.idleTimeoutMs ?? DEFAULT_IDLE_SESSION_TIMEOUT_MS;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
			throw new TypeError("idleTimeoutMs must be a positive finite integer");
		this.#timeoutMs = timeoutMs;
		this.#now = input.now ?? Date.now;
		this.#setTimeout = input.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout));
		this.#clearTimeout = input.clearTimeout ?? (timer => clearTimeout(timer));
		this.refreshMappings();
		this.schedule();
	}

	async stop(): Promise<void> {
		if (!this.#stopped) {
			this.#stopped = true;
			if (this.#timer !== undefined) {
				this.#clearTimeout(this.#timer);
				this.#timer = undefined;
			}
		}
		if (this.#baseStopped) return;
		this.#baseStopped = true;
		await this.input.runner.stop?.();
	}
	private async closeExternal(mapping: SessionMapping, ingress: SessionCloseIngress): Promise<SessionCloseResult> {
		const state = this.stateFor(mapping.chatId);
		state.active += 1;
		let release: (() => void) | undefined;
		try {
			release = await state.gate.acquire();
			const current = this.input.mappings.get(mapping.chatId);
			if (current === undefined || mappingGeneration(current) !== mappingGeneration(mapping))
				throw new Error(`GJC close mapping for chat ${mapping.chatId} is stale.`);
			state.closeInFlight = true;
			const result = await this.input.closeSession(current, ingress);
			if (result.status === "closed") {
				const proof = current.attachment;
				if (proof?.expectedCwd !== undefined)
					this.input.discardSessionAttachment?.(proof.expectedCwd, current.sessionId);
				state.mapping = current;
				state.generation = mappingGeneration(current);
				state.closed = true;
			} else {
				state.lastActivityAt = this.#now();
			}
			return result;
		} catch (error) {
			state.lastActivityAt = this.#now();
			throw error;
		} finally {
			state.closeInFlight = false;
			state.active -= 1;
			release?.();
			this.schedule();
		}
	}

	private async run(turn: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> {
		const state = this.stateFor(turn.chatId);
		state.active += 1;
		this.schedule();
		let release: (() => void) | undefined;
		let handedOff = false;
		let finalized = false;
		const finalize = (outcome: RunOutcome) => {
			if (finalized) return;
			finalized = true;
			state.active -= 1;
			if (outcome === "turn") this.markTurnCompleted(state);
			else if (outcome === "failure") this.deferAfterFailure(state);
			release?.();
			this.schedule();
		};
		try {
			release = await state.gate.acquire();
			const result = await this.input.runner.run(turn);
			const outcome: RunOutcome = turn.control === undefined ? "turn" : "control";
			if (result.chunks !== undefined) {
				handedOff = true;
				return {
					...result,
					chunks: this.consumeChunks(
						result.chunks,
						() => finalize(outcome),
						() => finalize("failure"),
					),
				};
			}
			finalize(outcome);
			return result;
		} catch (error) {
			if (!handedOff) finalize("failure");
			throw error;
		}
	}

	private consumeChunks(
		source: AsyncIterable<string> | Iterable<string>,
		onComplete: () => void,
		onFailure: () => void,
	): AsyncIterable<string> {
		return this.consumeChunksGenerator(source, onComplete, onFailure);
	}

	private async *consumeChunksGenerator(
		source: AsyncIterable<string> | Iterable<string>,
		onComplete: () => void,
		onFailure: () => void,
	): AsyncGenerator<string> {
		let settled = false;
		const fail = () => {
			if (settled) return;
			settled = true;
			onFailure();
		};
		try {
			for await (const chunk of source) yield chunk;
			if (!settled) {
				settled = true;
				onComplete();
			}
		} catch (error) {
			fail();
			throw error;
		} finally {
			fail();
		}
	}

	private stateFor(chatId: string): ChatState {
		const existing = this.#states.get(chatId);
		if (existing !== undefined) return existing;
		const state: ChatState = {
			chatId,
			mapping: undefined,
			generation: undefined,
			lastActivityAt: this.#now(),
			active: 0,
			closed: false,
			closeQueued: false,
			closeInFlight: false,
			gate: new SerialGate(),
		};
		this.#states.set(chatId, state);
		return state;
	}

	private markTurnCompleted(state: ChatState): void {
		const current = this.input.mappings.get(state.chatId);
		if (current === undefined) return;
		const generation = mappingGeneration(current);
		if (state.closed && state.generation === generation) {
			state.mapping = current;
			return;
		}
		state.mapping = current;
		state.generation = generation;
		state.closed = false;
		state.lastActivityAt = this.#now();
	}

	private deferAfterFailure(state: ChatState): void {
		if (state.closed) return;
		state.lastActivityAt = this.#now();
	}

	private refreshMappings(): void {
		for (const mapping of this.input.mappings.entries()) {
			if (!hasOwnedPaneAttachment(mapping.attachment)) continue;
			const idleClose = this.input.mappings.operation(mapping.chatId, closeIngressId(mapping.operationId, mapping));
			if (idleClose?.kind === "close" && idleClose.state !== "complete") continue;
			const alreadyClosed = idleClose?.kind === "close" && idleClose.state === "complete";
			const operation = this.input.mappings.operation(mapping.chatId, mapping.operationId);
			if (operation !== undefined && operation.state !== "complete") continue;
			const completedAt = operationCompletedAt(operation);
			if (completedAt === undefined) continue;
			const generation = mappingGeneration(mapping);
			const state = this.#states.get(mapping.chatId);
			if (state === undefined) {
				this.#states.set(mapping.chatId, {
					chatId: mapping.chatId,
					mapping,
					generation,
					lastActivityAt: completedAt,
					active: 0,
					closed: alreadyClosed,
					closeQueued: false,
					closeInFlight: false,
					gate: new SerialGate(),
				});
				continue;
			}
			if (
				state.mapping === undefined ||
				(state.generation !== generation && state.active === 0 && !state.closeQueued && !state.closeInFlight)
			) {
				state.mapping = mapping;
				state.generation = generation;
				state.lastActivityAt = completedAt;
				state.closed = alreadyClosed;
			}
		}
	}

	private schedule(): void {
		if (this.#stopped) return;
		if (this.#timer !== undefined) {
			this.#clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		let delay: number | undefined;
		const now = this.#now();
		for (const state of this.#states.values()) {
			if (
				state.mapping === undefined ||
				state.closed ||
				state.active > 0 ||
				state.closeQueued ||
				state.closeInFlight
			)
				continue;
			const remaining = Math.max(0, state.lastActivityAt + this.#timeoutMs - now);
			delay = delay === undefined ? remaining : Math.min(delay, remaining);
		}
		if (delay === undefined) return;
		this.#timer = this.#setTimeout(() => {
			this.#timer = undefined;
			void this.tick();
		}, delay);
		const timer = this.#timer as IdleTimer & { unref?: () => void };
		timer.unref?.();
	}

	private async tick(): Promise<void> {
		if (this.#stopped) return;
		this.refreshMappings();
		const now = this.#now();
		for (const state of this.#states.values()) {
			if (
				state.mapping === undefined ||
				state.closed ||
				state.active > 0 ||
				state.closeQueued ||
				state.closeInFlight ||
				state.lastActivityAt + this.#timeoutMs > now
			)
				continue;
			state.closeQueued = true;
			void this.attemptClose(state);
		}
		this.schedule();
	}

	private async attemptClose(state: ChatState): Promise<void> {
		const release = await state.gate.acquire();
		try {
			state.closeQueued = false;
			if (this.#stopped || state.closed || state.active > 0) return;
			const current = this.input.mappings.get(state.chatId);
			if (current === undefined) {
				state.closed = true;
				return;
			}
			const generation = mappingGeneration(current);
			if (state.generation !== generation) {
				this.adoptCurrentMapping(state, current);
				return;
			}
			if (!hasOwnedPaneAttachment(current.attachment)) {
				state.closed = true;
				return;
			}
			const idleClose = this.input.mappings.operation(current.chatId, closeIngressId(current.operationId, current));
			if (idleClose?.kind === "close") {
				if (idleClose.state === "complete") state.closed = true;
				else state.lastActivityAt = this.#now();
				return;
			}
			const operation = this.input.mappings.operation(current.chatId, current.operationId);
			if (operation !== undefined && operation.state !== "complete") {
				state.lastActivityAt = this.#now();
				return;
			}
			if (state.lastActivityAt + this.#timeoutMs > this.#now()) return;
			state.closeInFlight = true;
			try {
				const ingressId = closeIngressId(current.operationId, current);
				const result = await this.input.closeSession(current, { ingressId, ingressHash: ingressId });
				if (result.status !== "closed") {
					state.lastActivityAt = this.#now();
					return;
				}
				const proof = current.attachment;
				if (proof?.expectedCwd !== undefined)
					this.input.discardSessionAttachment?.(proof.expectedCwd, current.sessionId);
				state.closed = true;
				state.mapping = current;
			} catch {
				state.lastActivityAt = this.#now();
			} finally {
				state.closeInFlight = false;
			}
		} finally {
			release();
			this.schedule();
		}
	}

	private adoptCurrentMapping(state: ChatState, mapping: SessionMapping): void {
		state.mapping = mapping;
		state.generation = mappingGeneration(mapping);
		state.closed = false;
		const operation = this.input.mappings.operation(mapping.chatId, mapping.operationId);
		state.lastActivityAt = operationCompletedAt(operation) ?? this.#now();
	}
}

interface ChatState {
	readonly chatId: string;
	readonly gate: SerialGate;
	mapping: SessionMapping | undefined;
	generation: string | undefined;
	lastActivityAt: number;
	active: number;
	closed: boolean;
	closeQueued: boolean;
	closeInFlight: boolean;
}

class SerialGate {
	#tail = Promise.resolve();
	async acquire(): Promise<() => void> {
		const previous = this.#tail;
		let release!: () => void;
		this.#tail = new Promise<void>(resolve => {
			release = resolve;
		});
		await previous;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			release();
		};
	}
}

function operationCompletedAt(
	operation: Pick<SessionOperation, "state" | "completedAt"> | undefined,
): number | undefined {
	if (operation === undefined || operation.state !== "complete" || operation.completedAt === undefined)
		return undefined;
	const timestamp = Date.parse(operation.completedAt);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function mappingGeneration(mapping: SessionMapping): string {
	return JSON.stringify([
		mapping.chatId,
		mapping.projectId,
		mapping.sessionId,
		mapping.sessionFile,
		mapping.operationId,
		mapping.attachment,
	]);
}

function hasOwnedPaneAttachment(
	proof: SessionMapping["attachment"],
): proof is NonNullable<SessionMapping["attachment"]> &
	Required<
		Pick<NonNullable<SessionMapping["attachment"]>, "tmuxSocket" | "tmuxPane" | "tmuxPanePid" | "tmuxOwnershipTag">
	> {
	return (
		proof?.tmuxSocket !== undefined &&
		proof.tmuxPane !== undefined &&
		proof.tmuxPanePid !== undefined &&
		proof.tmuxOwnershipTag !== undefined
	);
}
