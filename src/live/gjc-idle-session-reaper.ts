import type { SessionOperation } from "../gjc/session-authority";
import {
	closeIngressId,
	type SessionCloseIngress,
	type SessionCloseResult,
	type SessionMapping,
} from "../gjc/session-router";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";

export const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 600_000;

type MappingStore = Pick<import("../gjc/session-router").SessionMappingStore, "get" | "entries" | "operation"> & {
	readonly operations?: (chatId: string) => readonly SessionOperation[];
};
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
	#inFlightIdleCloses = new Set<Promise<void>>();

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
		while (this.#inFlightIdleCloses.size > 0) {
			await Promise.allSettled([...this.#inFlightIdleCloses]);
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
			const generation = mappingGeneration(current);
			if (state.generation === generation && state.closed) return { status: "closed" };
			if (
				!state.rearmAfterActivity &&
				this.closeOperations(current, state).some(operation => operation.state === "complete")
			) {
				state.mapping = current;
				state.generation = generation;
				state.rearmAfterActivity = false;
				state.closed = true;
				return { status: "closed" };
			}
			const pendingOperation = this.input.mappings
				.operations?.(current.chatId)
				?.find(operation => operation.state === "pending");
			if (pendingOperation !== undefined)
				return { status: "unavailable", message: "GJC close is deferred while a session operation is pending." };
			const currentOperation = this.input.mappings.operation(current.chatId, current.operationId);
			if (currentOperation !== undefined && currentOperation.state !== "complete")
				return {
					status: "unavailable",
					message: "GJC close is deferred until the current session operation completes.",
				};
			state.closeInFlight = true;
			const closeIngress = this.rearmedCloseIngress(current, ingress, state);
			const result = await this.input.closeSession(current, closeIngress);
			if (result.status === "closed") {
				const proof = current.attachment;
				if (proof?.expectedCwd !== undefined)
					this.input.discardSessionAttachment?.(proof.expectedCwd, current.sessionId);
				state.mapping = current;
				state.generation = generation;
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
			if (outcome === "turn" || outcome === "control") this.markTurnCompleted(state);
			else this.deferAfterFailure(state);
			release?.();
			this.schedule();
		};
		try {
			release = await state.gate.acquire();
			const result = await this.input.runner.run(turn);
			const outcome: RunOutcome = turn.control === undefined ? "turn" : "control";
			if (result.chunks !== undefined) {
				const chunks = this.consumeChunks(
					result.chunks,
					() => finalize(outcome),
					() => finalize("failure"),
				);
				handedOff = true;
				return { ...result, chunks, abandon: () => chunks.abandon() };
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
	): TrackedChunks {
		return new TrackedChunks(source, onComplete, onFailure);
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
			rearmAfterActivity: false,
			closeAttempt: 0,
			rearmAttempt: 0,
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
		const rearm = state.rearmAfterActivity || (state.closed && state.generation === generation);
		state.mapping = current;
		state.generation = generation;
		state.rearmAfterActivity = rearm;
		if (!rearm) {
			state.closeAttempt = 0;
			state.rearmAttempt = 0;
		}
		state.closed = false;
		state.lastActivityAt = this.#now();
	}

	private deferAfterFailure(state: ChatState): void {
		const current = this.input.mappings.get(state.chatId);
		if (current === undefined) return;
		const generation = mappingGeneration(current);
		const rearm = state.rearmAfterActivity || (state.closed && state.generation === generation);
		state.mapping = current;
		state.generation = generation;
		state.rearmAfterActivity = rearm;
		if (!rearm) {
			state.closeAttempt = 0;
			state.rearmAttempt = 0;
		}
		state.closed = false;
		state.lastActivityAt = this.#now();
	}

	private refreshMappings(): void {
		for (const mapping of this.input.mappings.entries()) {
			if (!hasOwnedPaneAttachment(mapping.attachment)) continue;
			const operations = this.input.mappings.operations?.(mapping.chatId);
			const closeOperations = this.closeOperations(mapping);
			const alreadyClosed = closeOperations.some(operation => operation.state === "complete");
			const currentOperation = this.input.mappings.operation(mapping.chatId, mapping.operationId);
			const activityAt = mappingActivityAt(
				mapping,
				operations ?? (currentOperation === undefined ? [] : [currentOperation]),
			);
			if (activityAt === undefined) continue;
			const generation = mappingGeneration(mapping);
			const rearmAfterActivity = activityFollowsCompletedClose(
				mapping,
				operations ?? (currentOperation === undefined ? [] : [currentOperation]),
				closeOperations,
			);
			const state = this.#states.get(mapping.chatId);
			if (state === undefined) {
				this.#states.set(mapping.chatId, {
					chatId: mapping.chatId,
					mapping,
					generation,
					lastActivityAt: activityAt,
					active: 0,
					closeAttempt: 0,
					rearmAttempt: 0,
					rearmAfterActivity,
					closed: alreadyClosed && !rearmAfterActivity,
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
				state.closeAttempt = 0;
				state.rearmAttempt = 0;
				state.rearmAfterActivity = rearmAfterActivity;
				state.lastActivityAt = activityAt;
				state.closed = alreadyClosed && !rearmAfterActivity;
				continue;
			}
			if (
				state.generation === generation &&
				activityAt > state.lastActivityAt &&
				state.active === 0 &&
				!state.closeQueued &&
				!state.closeInFlight
			) {
				state.lastActivityAt = activityAt;
				if (rearmAfterActivity) {
					state.rearmAfterActivity = true;
					state.closed = false;
				}
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
			this.trackIdleClose(state);
		}
		this.schedule();
	}
	private trackIdleClose(state: ChatState): void {
		const close = this.attemptClose(state);
		this.#inFlightIdleCloses.add(close);
		void close.then(
			() => this.#inFlightIdleCloses.delete(close),
			() => this.#inFlightIdleCloses.delete(close),
		);
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
			const pendingOperation = this.input.mappings
				.operations?.(current.chatId)
				?.find(operation => operation.state === "pending");
			if (pendingOperation !== undefined) {
				state.lastActivityAt = this.#now();
				return;
			}
			const closeOperations = this.closeOperations(current, state);
			if (closeOperations.some(operation => operation.state === "complete") && !state.rearmAfterActivity) {
				state.closed = true;
				return;
			}
			if (closeOperations.some(operation => operation.state === "pending")) {
				state.lastActivityAt = this.#now();
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
				const ingress = this.nextCloseIngress(current, state);
				const result = await this.input.closeSession(current, ingress);
				if (result.status !== "closed") {
					state.lastActivityAt = this.#now();
					return;
				}
				const proof = current.attachment;
				if (proof?.expectedCwd !== undefined)
					this.input.discardSessionAttachment?.(proof.expectedCwd, current.sessionId);
				state.closed = true;
				state.rearmAfterActivity = false;
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

	private closeOperations(mapping: SessionMapping, state?: ChatState): readonly SessionOperation[] {
		const prefix = closeIngressId(mapping.operationId, mapping);
		const persisted = this.input.mappings.operations?.(mapping.chatId);
		if (persisted !== undefined) {
			const currentOperation = this.input.mappings.operation(mapping.chatId, mapping.operationId);
			return persisted.filter(
				operation =>
					operation.kind === "close" &&
					(operationResultMatchesMapping(operation, mapping, currentOperation, persisted) ||
						(operation.state !== "complete" && closeOperationIndex(operation, prefix) >= 0)),
			);
		}
		const operations: SessionOperation[] = [];
		const maxAttempt = state?.closeAttempt ?? 0;
		for (let attempt = 0; attempt <= maxAttempt; attempt++) {
			const ingressId = closeIngressIdForAttempt(prefix, attempt);
			const operation = this.input.mappings.operation(mapping.chatId, ingressId);
			if (operation !== undefined && operation.kind === "close") operations.push(operation);
		}
		return operations;
	}

	private nextCloseIngress(mapping: SessionMapping, state: ChatState): SessionCloseIngress {
		const prefix = closeIngressId(mapping.operationId, mapping);
		const operations = this.closeOperations(mapping, state);
		const nextAttempt = Math.max(
			state.closeAttempt,
			...operations.map(operation => closeOperationIndex(operation, prefix) + 1),
		);
		state.closeAttempt = nextAttempt + 1;
		const ingressId = closeIngressIdForAttempt(prefix, nextAttempt);
		return { ingressId, ingressHash: ingressId };
	}
	private rearmedCloseIngress(
		mapping: SessionMapping,
		ingress: SessionCloseIngress,
		state: ChatState,
	): SessionCloseIngress {
		const prior = this.input.mappings.operation(mapping.chatId, ingress.ingressId);
		if (!state.rearmAfterActivity || prior?.kind !== "close" || prior.state !== "complete") return ingress;
		const prefix = `${ingress.ingressId}:rearmed:${mapping.operationId}:`;
		const attempts = this.input.mappings
			.operations?.(mapping.chatId)
			?.map(operation => rearmedIngressAttempt(operation, prefix))
			.filter((attempt): attempt is number => attempt !== undefined);
		const attempt = attempts === undefined ? state.rearmAttempt + 1 : Math.max(0, ...attempts) + 1;
		state.rearmAttempt = attempt;
		const rearmKey = `${mapping.operationId}:${attempt}`;
		return {
			ingressId: `${ingress.ingressId}:rearmed:${rearmKey}`,
			ingressHash: `${ingress.ingressHash}:rearmed:${rearmKey}`,
		};
	}
	private adoptCurrentMapping(state: ChatState, mapping: SessionMapping): void {
		state.rearmAfterActivity = false;
		state.mapping = mapping;
		state.generation = mappingGeneration(mapping);
		state.closeAttempt = 0;
		state.rearmAttempt = 0;
		state.closed = false;
		const operation = this.input.mappings.operation(mapping.chatId, mapping.operationId);
		state.lastActivityAt = operationCompletedAt(operation) ?? this.#now();
	}
}
function operationResultMatchesMapping(
	operation: SessionOperation,
	mapping: SessionMapping,
	currentOperation: SessionOperation | undefined,
	persisted: readonly SessionOperation[],
): boolean {
	const result = operation.result;
	const resultMapping = result?.mapping;
	const matchesIdentity =
		resultMapping !== undefined &&
		resultMapping.chatId === mapping.chatId &&
		resultMapping.projectId === mapping.projectId &&
		resultMapping.sessionId === mapping.sessionId &&
		resultMapping.sessionFile === mapping.sessionFile &&
		JSON.stringify(resultMapping.attachment) === JSON.stringify(mapping.attachment);
	if (!matchesIdentity) return false;
	if (result?.correlation?.mappingOperationId !== undefined)
		return result.correlation.mappingOperationId === mapping.operationId;
	const currentIndex = operationIndex(persisted, currentOperation);
	const closeIndex = operationIndex(persisted, operation);
	if (currentIndex !== undefined && closeIndex !== undefined) return closeIndex > currentIndex;
	const mappingCompletedAt = operationCompletedAt(currentOperation);
	const closeActivityAt = operationActivityAt(operation);
	return mappingCompletedAt !== undefined && closeActivityAt !== undefined && closeActivityAt > mappingCompletedAt;
}
function operationIndex(
	operations: readonly SessionOperation[],
	target: SessionOperation | undefined,
): number | undefined {
	if (target === undefined) return undefined;
	const index = operations.findIndex(
		operation =>
			operation.id === target.id || (operation.ingressId !== undefined && operation.ingressId === target.ingressId),
	);
	return index < 0 ? undefined : index;
}
function closeIngressIdForAttempt(prefix: string, attempt: number): string {
	return attempt === 0 ? prefix : `${prefix}:retry:${attempt}`;
}

function closeOperationIndex(operation: SessionOperation, prefix: string): number {
	const id = operation.ingressId ?? operation.id;
	if (id === prefix) return 0;
	const retryPrefix = `${prefix}:retry:`;
	if (!id.startsWith(retryPrefix)) return -1;
	const attempt = Number(id.slice(retryPrefix.length));
	return Number.isInteger(attempt) && attempt > 0 ? attempt : -1;
}
function rearmedIngressAttempt(operation: SessionOperation, prefix: string): number | undefined {
	const ingressId = operation.ingressId ?? operation.id;
	if (!ingressId.startsWith(prefix)) return undefined;
	const attempt = Number(ingressId.slice(prefix.length));
	return Number.isInteger(attempt) && attempt > 0 ? attempt : undefined;
}

interface ChatState {
	readonly chatId: string;
	readonly gate: SerialGate;
	mapping: SessionMapping | undefined;
	generation: string | undefined;
	lastActivityAt: number;
	active: number;
	closed: boolean;
	closeAttempt: number;
	rearmAfterActivity: boolean;
	rearmAttempt: number;
	closeQueued: boolean;
	closeInFlight: boolean;
}

class TrackedChunks implements AsyncIterable<string> {
	readonly #iterator: AsyncIterator<string> | Iterator<string>;
	#finished = false;
	#error: unknown;
	#draining: Promise<void> | undefined;
	#nextInFlight: Promise<IteratorResult<string>> | undefined;

	constructor(
		source: AsyncIterable<string> | Iterable<string>,
		private readonly onComplete: () => void,
		private readonly onFailure: () => void,
	) {
		this.#iterator = chunkIterator(source);
	}

	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: () => this.next(),
			return: async () => {
				await this.abandon();
				return { value: undefined, done: true };
			},
		};
	}

	async abandon(): Promise<void> {
		if (this.#finished) return;
		if (this.#draining !== undefined) return await this.#draining;
		const drain = this.drain();
		this.#draining = drain;
		await drain;
	}

	private async next(): Promise<IteratorResult<string>> {
		if (this.#finished) {
			if (this.#error !== undefined) throw this.#error;
			return { value: undefined, done: true };
		}
		return await this.read();
	}

	private async drain(): Promise<void> {
		try {
			await this.#nextInFlight;
			while (!this.#finished) await this.read();
		} catch {
			// read() already records the stream failure and releases the chat gate.
		}
	}

	private async read(): Promise<IteratorResult<string>> {
		const next = Promise.resolve().then(() => this.#iterator.next());
		this.#nextInFlight = next;
		try {
			const result = await next;
			if (result.done) this.complete();
			return result;
		} catch (error) {
			this.fail(error);
			throw error;
		} finally {
			if (this.#nextInFlight === next) this.#nextInFlight = undefined;
		}
	}

	private complete(): void {
		if (this.#finished) return;
		this.#finished = true;
		this.onComplete();
	}

	private fail(error: unknown): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#error = error;
		this.onFailure();
	}
}

function chunkIterator(source: AsyncIterable<string> | Iterable<string>): AsyncIterator<string> | Iterator<string> {
	if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
	return source[Symbol.iterator]();
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

function latestCompletedAt(operations: readonly SessionOperation[]): number | undefined {
	let latest: number | undefined;
	for (const operation of operations) {
		const completedAt = operationCompletedAt(operation);
		if (completedAt !== undefined && (latest === undefined || completedAt > latest)) latest = completedAt;
	}
	return latest;
}

function mappingActivityAt(mapping: SessionMapping, operations: readonly SessionOperation[]): number | undefined {
	const activities = mappingActivityOperations(mapping, operations);
	let latest: number | undefined;
	for (const operation of activities) {
		const operationAt = operationActivityAt(operation);
		if (operationAt !== undefined && (latest === undefined || operationAt > latest)) latest = operationAt;
	}
	return latest;
}

function activityFollowsCompletedClose(
	mapping: SessionMapping,
	operations: readonly SessionOperation[],
	closeOperations: readonly SessionOperation[],
): boolean {
	const lastCloseAt = latestCompletedAt(closeOperations);
	const activityAt = mappingActivityAt(mapping, operations);
	if (lastCloseAt === undefined || activityAt === undefined) return false;
	if (activityAt !== lastCloseAt) return activityAt > lastCloseAt;
	const closeIds = new Set(
		closeOperations
			.filter(operation => operation.state === "complete" && operationCompletedAt(operation) === lastCloseAt)
			.map(operation => operation.id),
	);
	const activityIds = new Set(
		mappingActivityOperations(mapping, operations)
			.filter(operation => operationActivityAt(operation) === activityAt)
			.map(operation => operation.id),
	);
	const lastCloseIndex = operations.reduce(latestIndexForOperationIds(closeIds), Number.NEGATIVE_INFINITY);
	const lastActivityIndex = operations.reduce(latestIndexForOperationIds(activityIds), Number.NEGATIVE_INFINITY);
	return lastActivityIndex > lastCloseIndex;
}

function latestIndexForOperationIds(ids: ReadonlySet<string>) {
	return (latest: number, operation: SessionOperation, index: number): number =>
		ids.has(operation.id) ? index : latest;
}

function mappingActivityOperations(
	mapping: SessionMapping,
	operations: readonly SessionOperation[],
): readonly SessionOperation[] {
	const generation = mappingGeneration(mapping);
	const current = operations.find(
		operation => operation.id === mapping.operationId || operation.ingressId === mapping.operationId,
	);
	const baseline = operationActivityAt(current) ?? Number.NEGATIVE_INFINITY;
	return operations.filter(operation => {
		if (operation.kind === "close") return false;
		const operationAt = operationActivityAt(operation);
		if (operationAt === undefined) return false;
		const resultMapping = operation.result?.mapping;
		const sameGeneration = resultMapping === undefined || mappingGeneration(resultMapping) === generation;
		const isCurrent = operation.id === mapping.operationId || operation.ingressId === mapping.operationId;
		const hasSameGenerationResult = resultMapping !== undefined && sameGeneration;
		const isReconciliation = ["pending", "uncertain", "conflict"].includes(operation.state);
		return sameGeneration && (isCurrent || hasSameGenerationResult || (isReconciliation && operationAt >= baseline));
	});
}

function operationActivityAt(
	operation: Pick<SessionOperation, "startedAt" | "completedAt"> | undefined,
): number | undefined {
	if (operation === undefined) return undefined;
	const completedAt = parseTimestamp(operation.completedAt);
	if (completedAt !== undefined) return completedAt;
	return parseTimestamp(operation.startedAt);
}

function parseTimestamp(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const timestamp = Date.parse(value);
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
