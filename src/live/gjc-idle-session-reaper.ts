import { randomUUID } from "node:crypto";
import type { SessionOperation } from "../gjc/session-authority";
import {
	closeIngressId,
	type SessionCloseIngress,
	type SessionCloseResult,
	type SessionMapping,
} from "../gjc/session-router";
import type { UserWorkspaceRegistry } from "../security/user-workspace";
import type { WorkspaceLease, WorkspaceLeaseManager } from "../security/workspace-lease";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { acquireWorkspaceAdmission } from "./chat-completions";

export const DEFAULT_IDLE_SESSION_TIMEOUT_MS = 600_000;
const DEFAULT_WORKSPACE_LEASE_DURATION_MS = 210_000;
const REAPER_WORKSPACE_ADMISSION_QUEUE_LIMIT = 32;

type MappingScope = Readonly<{ principalId: string; chatId: string }>;
type MappingStore = Pick<import("../gjc/session-router").SessionMappingStore, "entries"> & {
	readonly getScoped: (scope: MappingScope) => SessionMapping | undefined;
	readonly operationScoped: (scope: MappingScope, operationId: string) => SessionOperation | undefined;
	readonly operationsScoped: (scope: MappingScope) => readonly SessionOperation[];
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
	/** User workspace admission is required for non-admin principals. */
	readonly workspaceRegistry?: Pick<UserWorkspaceRegistry, "open">;
	/** User workspace fencing is required for non-admin principals. */
	readonly workspaceLeaseManager?: Pick<WorkspaceLeaseManager, "acquire">;
	readonly workspaceLeaseDurationMs?: number;
	/** The configured OpenWebUI owner is an administrator and has no user workspace. */
	readonly adminPrincipalId?: string;
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
	#stopPromise: Promise<void> | undefined;
	#inFlightIdleCloses = new Map<string, Set<Promise<void>>>();
	#inFlightNonIdleWork = new Map<string, Set<Promise<void>>>();
	#handedOffStreams = new Map<string, Set<() => Promise<void>>>();
	readonly #workspaceGates = new Map<string, SerialGate>();

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

	stop(): Promise<void> {
		if (this.#stopPromise === undefined) this.#stopPromise = this.stopInternal();
		return this.#stopPromise;
	}
	private async stopInternal(): Promise<void> {
		this.#stopped = true;
		if (this.#timer !== undefined) {
			this.#clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		while (
			trackedCount(this.#inFlightIdleCloses) > 0 ||
			trackedCount(this.#inFlightNonIdleWork) > 0 ||
			trackedCount(this.#handedOffStreams) > 0
		) {
			const abandonment = [...this.#handedOffStreams.values()].flatMap(streams =>
				[...streams].map(stream => Promise.resolve().then(stream)),
			);
			await Promise.allSettled([
				...trackedPromises(this.#inFlightIdleCloses),
				...trackedPromises(this.#inFlightNonIdleWork),
				...abandonment,
			]);
		}
		if (this.#baseStopped) return;
		this.#baseStopped = true;
		await this.input.runner.stop?.();
	}
	private async closeExternal(mapping: SessionMapping, ingress: SessionCloseIngress): Promise<SessionCloseResult> {
		if (this.#stopped) throw new Error("GJC idle session reaper is stopped.");
		const principalId = principalIdForMapping(mapping);
		if (principalId === undefined) throw new Error("GJC close requires an explicit principal owner.");
		const state = this.stateFor(principalId, mapping.chatId);
		const settleWork = this.trackNonIdleWork(state);
		state.active += 1;
		let release: (() => void) | undefined;
		let closeAttempted = false;
		let attemptedMapping: SessionMapping | undefined;
		let attemptedIngressId: string | undefined;
		try {
			release = await state.gate.acquire();
			if (this.#stopped) throw new Error("GJC idle session reaper is stopped.");
			const result = await this.withWorkspaceLease(
				principalId,
				"close",
				async (assertFence): Promise<SessionCloseResult> => {
					if (this.#stopped) throw new Error("GJC idle session reaper is stopped.");
					const current = this.mappingFor(principalId, mapping.chatId);
					if (current === undefined || mappingGeneration(current) !== mappingGeneration(mapping))
						throw new Error(`GJC close mapping for chat ${mapping.chatId} is stale.`);
					attemptedMapping = current;
					const generation = mappingGeneration(current);
					const pendingOperation = this.operationsFor(principalId, current.chatId)?.find(
						operation => operation.state === "pending",
					);
					if (pendingOperation !== undefined)
						return {
							status: "unavailable",
							message: "GJC close is deferred while a session operation is pending.",
						};
					const currentOperation = this.operationFor(principalId, current.chatId, current.operationId);
					if (currentOperation !== undefined && currentOperation.state !== "complete")
						return {
							status: "unavailable",
							message: "GJC close is deferred until the current session operation completes.",
						};
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
					await assertFence();
					state.closeInFlight = true;
					const closeIngress = this.rearmedCloseIngress(current, ingress, state);
					closeAttempted = true;
					attemptedIngressId = closeIngress.ingressId;
					const result = await this.input.closeSession(current, closeIngress);
					if (result.status === "closed") {
						await assertFence();
						const proof = current.attachment;
						if (proof?.expectedCwd !== undefined)
							this.input.discardSessionAttachment?.(proof.expectedCwd, current.sessionId);
						state.mapping = current;
						state.generation = generation;
						state.closed = true;
					} else {
						state.idleIneligible = state.idleIneligible || !isReaperCloseIngress(current, closeIngress.ingressId);
						state.lastActivityAt = this.#now();
					}
					return result;
				},
			);
			return result;
		} catch (error) {
			if (
				closeAttempted &&
				attemptedMapping !== undefined &&
				!isReaperCloseIngress(attemptedMapping, attemptedIngressId ?? ingress.ingressId)
			)
				state.idleIneligible = true;
			state.lastActivityAt = this.#now();
			throw error;
		} finally {
			state.closeInFlight = false;
			state.active -= 1;
			release?.();
			this.schedule();
			settleWork();
		}
	}

	private async run(turn: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> {
		if (this.#stopped) throw new Error("GJC idle session reaper is stopped.");
		const principalId = principalIdForTurn(turn);
		if (principalId === undefined) throw new Error("GJC turn requires an explicit principal owner.");
		const state = this.stateFor(principalId, turn.chatId);
		const settleWork = this.trackNonIdleWork(state);
		state.active += 1;
		this.schedule();
		let release: (() => void) | undefined;
		let handedOff = false;
		let finalized = false;
		let streamAbandonment: (() => Promise<void>) | undefined;
		const finalize = (outcome: RunOutcome) => {
			if (finalized) return;
			finalized = true;
			state.active -= 1;
			if (streamAbandonment !== undefined) this.deleteHandedOffStream(state, streamAbandonment);
			if (outcome === "turn" || outcome === "control") this.markTurnCompleted(state);
			else this.deferAfterFailure(state);
			release?.();
			this.schedule();
			settleWork();
		};
		try {
			release = await state.gate.acquire();
			if (this.#stopped) throw new Error("GJC idle session reaper is stopped.");
			const result = await this.input.runner.run(turn);
			const outcome: RunOutcome = turn.control === undefined ? "turn" : "control";
			if (result.chunks !== undefined) {
				const chunks = this.consumeChunks(
					result.chunks,
					() => finalize(outcome),
					() => finalize("failure"),
				);
				const sourceAbandon = result.abandon;
				let abandonment: Promise<void> | undefined;
				const abandon = (): Promise<void> => {
					if (abandonment === undefined)
						abandonment = (async () => {
							const source = Promise.resolve().then(() => sourceAbandon?.());
							const drain = chunks.abandon();
							const failures = (await Promise.allSettled([source, drain])).flatMap(result =>
								result.status === "rejected" ? [result.reason] : [],
							);
							if (failures.length === 1) throw failures[0];
							if (failures.length > 1) throw new AggregateError(failures, "GJC stream abandonment failed");
						})();
					return abandonment;
				};
				streamAbandonment = abandon;
				this.addHandedOffStream(state, abandon);
				const wrapped = { ...result, chunks, abandon };
				handedOff = true;
				return wrapped;
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
	private trackNonIdleWork(state: ChatState): () => void {
		let resolve!: () => void;
		let settled = false;
		const work = new Promise<void>(completion => {
			resolve = completion;
		});
		const tracked = this.#inFlightNonIdleWork.get(state.key) ?? new Set<Promise<void>>();
		tracked.add(work);
		this.#inFlightNonIdleWork.set(state.key, tracked);
		return () => {
			if (settled) return;
			settled = true;
			tracked.delete(work);
			if (tracked.size === 0) this.#inFlightNonIdleWork.delete(state.key);
			resolve();
		};
	}
	private addHandedOffStream(state: ChatState, stream: () => Promise<void>): void {
		const tracked = this.#handedOffStreams.get(state.key) ?? new Set<() => Promise<void>>();
		tracked.add(stream);
		this.#handedOffStreams.set(state.key, tracked);
	}
	private deleteHandedOffStream(state: ChatState, stream: () => Promise<void>): void {
		const tracked = this.#handedOffStreams.get(state.key);
		if (tracked === undefined) return;
		tracked.delete(stream);
		if (tracked.size === 0) this.#handedOffStreams.delete(state.key);
	}
	private mappingFor(principalId: string, chatId: string): SessionMapping | undefined {
		const mapping = this.input.mappings.getScoped({ principalId, chatId });
		if (mapping === undefined) return undefined;
		return principalIdForMapping(mapping) === principalId ? mapping : undefined;
	}
	private operationFor(principalId: string, chatId: string, operationId: string): SessionOperation | undefined {
		return this.input.mappings.operationScoped({ principalId, chatId }, operationId);
	}
	private operationsFor(principalId: string, chatId: string): readonly SessionOperation[] {
		return this.input.mappings.operationsScoped({ principalId, chatId });
	}
	private stateFor(principalId: string, chatId: string): ChatState {
		const key = stateKey(principalId, chatId);
		const existing = this.#states.get(key);
		if (existing !== undefined) return existing;
		const state: ChatState = {
			key,
			principalId,
			chatId,
			mapping: undefined,
			generation: undefined,
			lastActivityAt: this.#now(),
			active: 0,
			closed: false,
			idleIneligible: false,
			rearmAfterActivity: false,
			closeAttempt: 0,
			rearmAttempt: 0,
			closeQueued: false,
			closeInFlight: false,
			gate: new SerialGate(),
		};
		this.#states.set(key, state);
		return state;
	}
	private workspaceGateFor(principalId: string): SerialGate {
		const existing = this.#workspaceGates.get(principalId);
		if (existing !== undefined) return existing;
		const gate = new SerialGate();
		this.#workspaceGates.set(principalId, gate);
		return gate;
	}

	private markTurnCompleted(state: ChatState): void {
		const current = this.mappingFor(state.principalId, state.chatId);
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
		state.idleIneligible = false;
		state.lastActivityAt = this.#now();
	}

	private deferAfterFailure(state: ChatState): void {
		const current = this.mappingFor(state.principalId, state.chatId);
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
		state.idleIneligible = false;
		state.lastActivityAt = this.#now();
	}

	private refreshMappings(): void {
		for (const rawMapping of this.input.mappings.entries()) {
			if (!hasOwnedPaneAttachment(rawMapping.attachment)) continue;
			const principalId = principalIdForMapping(rawMapping) ?? normalizePrincipalId(this.input.adminPrincipalId);
			if (principalId === undefined) continue;
			// Legacy admin rows are intentionally unscoped; bind the configured
			// admin so upgraded sessions enter idle tracking and can be closed.
			const mapping = rawMapping.principalId === undefined ? { ...rawMapping, principalId } : rawMapping;
			const operations = this.operationsFor(principalId, mapping.chatId);
			const currentOperation = this.operationFor(principalId, mapping.chatId, mapping.operationId);
			const journal = operations ?? (currentOperation === undefined ? [] : [currentOperation]);
			const closeOperations = this.closeOperations(mapping);
			const manualClosePending = hasPendingManualClose(mapping, journal, currentOperation);
			const alreadyClosed = closeOperations.some(operation => operation.state === "complete");
			const generation = mappingGeneration(mapping);
			const key = stateKey(principalId, mapping.chatId);
			const state = this.#states.get(key);
			const activityAt =
				mappingActivityAt(mapping, journal) ??
				(state?.generation === generation ? state.lastActivityAt : this.#now());
			const rearmAfterActivity = activityFollowsCompletedClose(mapping, journal, closeOperations);
			if (state === undefined) {
				this.#states.set(key, {
					key,
					principalId,
					chatId: mapping.chatId,
					mapping,
					generation,
					lastActivityAt: activityAt,
					active: 0,
					idleIneligible: manualClosePending,
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
				state.idleIneligible = manualClosePending;
				state.lastActivityAt = activityAt;
				state.closed = alreadyClosed && !rearmAfterActivity;
				continue;
			}
			if (state.generation === generation && manualClosePending) state.idleIneligible = true;
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
				state.idleIneligible ||
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
				state.idleIneligible ||
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
		const tracked = this.#inFlightIdleCloses.get(state.key) ?? new Set<Promise<void>>();
		tracked.add(close);
		this.#inFlightIdleCloses.set(state.key, tracked);
		void close.then(
			() => this.deleteIdleClose(state, close),
			() => this.deleteIdleClose(state, close),
		);
	}
	private deleteIdleClose(state: ChatState, close: Promise<void>): void {
		const tracked = this.#inFlightIdleCloses.get(state.key);
		if (tracked === undefined) return;
		tracked.delete(close);
		if (tracked.size === 0) this.#inFlightIdleCloses.delete(state.key);
	}

	private async attemptClose(state: ChatState): Promise<void> {
		const release = await state.gate.acquire();
		try {
			state.closeQueued = false;
			if (this.#stopped || state.closed || state.idleIneligible || state.active > 0) return;
			try {
				await this.withWorkspaceLease(state.principalId, "reaper", async assertFence => {
					if (this.#stopped || state.closed || state.idleIneligible || state.active > 0) return;
					const current = this.mappingFor(state.principalId, state.chatId);
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
						state.idleIneligible = true;
						return;
					}
					const pendingOperation = this.operationsFor(state.principalId, current.chatId)?.find(
						operation => operation.state === "pending",
					);
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
					const operation = this.operationFor(state.principalId, current.chatId, current.operationId);
					if (operation !== undefined && operation.state !== "complete") {
						state.lastActivityAt = this.#now();
						return;
					}
					if (state.lastActivityAt + this.#timeoutMs > this.#now()) return;
					await assertFence();
					state.closeInFlight = true;
					try {
						const ingress = this.nextCloseIngress(current, state);
						const result = await this.input.closeSession(current, ingress);
						if (result.status !== "closed") {
							state.lastActivityAt = this.#now();
							return;
						}
						await assertFence();
						const proof = current.attachment;
						if (proof?.expectedCwd !== undefined)
							this.input.discardSessionAttachment?.(proof.expectedCwd, current.sessionId);
						state.closed = true;
						state.rearmAfterActivity = false;
						state.mapping = current;
					} finally {
						state.closeInFlight = false;
					}
				});
			} catch {
				state.lastActivityAt = this.#now();
			}
		} finally {
			release();
			this.schedule();
		}
	}
	private async withWorkspaceLease<T>(
		principalId: string,
		operation: "close" | "reaper",
		work: (assertFence: () => Promise<void>) => Promise<T>,
	): Promise<T> {
		const adminPrincipalId = normalizePrincipalId(this.input.adminPrincipalId);
		if (adminPrincipalId !== undefined && principalId === adminPrincipalId)
			return work(async () => {
				// Configured administrator sessions intentionally do not have a user workspace lease.
			});
		const releaseWorkspaceGate = await this.workspaceGateFor(principalId).acquire();
		let releaseAdmission: (() => void) | undefined;
		try {
			const registry = this.input.workspaceRegistry;
			const leaseManager = this.input.workspaceLeaseManager;
			if (registry === undefined || leaseManager === undefined) throw new WorkspaceLeaseUncertainError();
			const durationMs = this.input.workspaceLeaseDurationMs ?? DEFAULT_WORKSPACE_LEASE_DURATION_MS;
			if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new WorkspaceLeaseUncertainError();
			let safeKey: string;
			try {
				const workspace = await registry.open(principalId);
				if (
					workspace === undefined ||
					normalizePrincipalId(workspace.userId) !== principalId ||
					normalizePrincipalId(workspace.safeKey) === undefined
				)
					throw new Error("Workspace identity could not be verified.");
				safeKey = workspace.safeKey;
			} catch {
				throw new WorkspaceLeaseUncertainError();
			}
			// Join the same workspace admission queue as chat/model requests so an
			// admitted completion waits behind a close/reap (and vice versa)
			// instead of losing the durable-lease race.
			try {
				releaseAdmission = await acquireWorkspaceAdmission(
					leaseManager,
					safeKey,
					durationMs,
					REAPER_WORKSPACE_ADMISSION_QUEUE_LIMIT,
				);
			} catch {
				throw new WorkspaceLeaseUncertainError();
			}
			let lease: WorkspaceLease;
			try {
				lease = await leaseManager.acquire({
					safeKey,
					holderId: `gjc-${operation}-${process.pid}-${randomUUID()}`,
					operation,
					leaseMs: durationMs,
				});
				if (lease === undefined) throw new Error("Workspace lease was not returned.");
			} catch {
				throw new WorkspaceLeaseUncertainError();
			}
			const assertFence = async (): Promise<void> => {
				try {
					await lease.assertFence();
				} catch {
					throw new WorkspaceLeaseUncertainError();
				}
			};
			let failed = false;
			let workError: unknown;
			let result!: T;
			try {
				await assertFence();
				result = await work(assertFence);
			} catch (error) {
				failed = true;
				workError = error;
			}
			let releaseFailed = false;
			try {
				await lease.release();
			} catch {
				releaseFailed = true;
			}
			if (releaseFailed) {
				const uncertainty = new WorkspaceLeaseUncertainError();
				if (failed) throw new AggregateError([workError, uncertainty], "Workspace lease finalization failed.");
				throw uncertainty;
			}
			if (failed) throw workError;
			return result;
		} finally {
			releaseAdmission?.();
			releaseWorkspaceGate();
		}
	}

	private closeOperations(mapping: SessionMapping, _state?: ChatState): readonly SessionOperation[] {
		const principalId = principalIdForMapping(mapping);
		if (principalId === undefined) return [];
		const prefix = closeIngressId(mapping.operationId, mapping);
		const persisted = this.operationsFor(principalId, mapping.chatId);
		const currentOperation = this.operationFor(principalId, mapping.chatId, mapping.operationId);
		return persisted.filter(
			operation =>
				operation.kind === "close" &&
				(operationResultMatchesMapping(operation, mapping, currentOperation, persisted) ||
					(operation.state !== "complete" && closeOperationIndex(operation, prefix) >= 0)),
		);
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
		const prior = this.operationFor(state.principalId, mapping.chatId, ingress.ingressId);
		if (!state.rearmAfterActivity || prior?.kind !== "close" || prior.state !== "complete") return ingress;
		const prefix = `${ingress.ingressId}:rearmed:${mapping.operationId}:`;
		const attempts = this.operationsFor(state.principalId, mapping.chatId)
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
		state.idleIneligible = false;
		state.mapping = mapping;
		state.generation = mappingGeneration(mapping);
		state.closeAttempt = 0;
		state.rearmAttempt = 0;
		state.closed = false;
		const operation = this.operationFor(state.principalId, mapping.chatId, mapping.operationId);
		state.lastActivityAt = operationCompletedAt(operation) ?? this.#now();
	}
}
class WorkspaceLeaseUncertainError extends Error {
	constructor() {
		super("Workspace lease admission is uncertain.");
		this.name = "WorkspaceLeaseUncertainError";
	}
}
function hasPendingManualClose(
	mapping: SessionMapping,
	operations: readonly SessionOperation[],
	currentOperation: SessionOperation | undefined,
): boolean {
	const prefix = closeIngressId(mapping.operationId, mapping);
	if (currentOperation === undefined)
		return operations.some(
			operation =>
				operation.kind === "close" && operation.state !== "complete" && !isReaperCloseOperation(operation, prefix),
		);
	return operations.some(
		operation =>
			operation.kind === "close" &&
			operation.state !== "complete" &&
			!isReaperCloseOperation(operation, prefix) &&
			operationFollowsMapping(operation, currentOperation, operations),
	);
}
function isReaperCloseOperation(operation: SessionOperation, prefix: string): boolean {
	return closeOperationIndex(operation, prefix) >= 0;
}
function isReaperCloseIngress(mapping: SessionMapping, ingressId: string): boolean {
	const prefix = closeIngressId(mapping.operationId, mapping);
	if (ingressId === prefix) return true;
	const retryPrefix = `${prefix}:retry:`;
	if (!ingressId.startsWith(retryPrefix)) return false;
	const attempt = Number(ingressId.slice(retryPrefix.length));
	return Number.isInteger(attempt) && attempt > 0;
}
function operationFollowsMapping(
	operation: SessionOperation,
	currentOperation: SessionOperation | undefined,
	persistedOperations: readonly SessionOperation[],
): boolean {
	const mappingActivityAt = operationActivityAt(currentOperation);
	const operationAt = operationActivityAt(operation);
	if (mappingActivityAt === undefined || operationAt === undefined) return false;
	if (operationAt !== mappingActivityAt) return operationAt > mappingActivityAt;
	const currentIndex = operationIndex(persistedOperations, currentOperation);
	const operationIndexAt = operationIndex(persistedOperations, operation);
	return currentIndex !== undefined && operationIndexAt !== undefined && operationIndexAt > currentIndex;
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
	return operationFollowsMapping(operation, currentOperation, persisted);
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

function trackedCount<T>(tracked: ReadonlyMap<string, ReadonlySet<T>>): number {
	let count = 0;
	for (const values of tracked.values()) count += values.size;
	return count;
}
function trackedPromises<T>(tracked: ReadonlyMap<string, ReadonlySet<T>>): T[] {
	const values: T[] = [];
	for (const entries of tracked.values()) values.push(...entries);
	return values;
}
function stateKey(principalId: string, chatId: string): string {
	return JSON.stringify([principalId, chatId]);
}
function principalIdForMapping(mapping: SessionMapping): string | undefined {
	return normalizePrincipalId(mapping.principalId);
}
function principalIdForTurn(turn: LiveGatewayRunnerInput): string | undefined {
	return normalizePrincipalId(turn.ownerUserId);
}
function normalizePrincipalId(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}
interface ChatState {
	readonly key: string;
	readonly principalId: string;
	readonly chatId: string;
	readonly gate: SerialGate;
	mapping: SessionMapping | undefined;
	generation: string | undefined;
	lastActivityAt: number;
	active: number;
	closed: boolean;
	idleIneligible: boolean;
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
	if (
		source !== null &&
		(typeof source === "object" || typeof source === "function") &&
		Symbol.asyncIterator in source
	)
		return source[Symbol.asyncIterator]();
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
