import { isAbsolute, resolve } from "node:path";
import type { TenantSessionKey } from "../gjc/managed-sdk-runtime";
import type { SessionOperation, SessionOperationResult } from "../gjc/session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "../gjc/session-authority-v3";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import type { ManagedTurnAuthority } from "../gjc/turn-runner";

export const DEFAULT_MANAGED_IDLE_TIMEOUT_MS = 600_000;

export type ManagedIdleGenerationState = "active" | "inflight" | "closing" | "uncertain";

/**
 * Credential-free durable evidence for a managed generation.  A record is
 * evictable only after the Router positively reports this exact generation as
 * retired.
 */
export interface ManagedIdleGenerationRecord {
	readonly authority: ManagedTurnAuthority;
	readonly lastActivityAt: number;
	readonly state: ManagedIdleGenerationState;
}

export interface ManagedIdleCloseIntent {
	readonly key: string;
	readonly authority: ManagedTurnAuthority;
	readonly requestedAt: number;
}

/** Persistence owns authority records only; it has no user-file capability. */
export interface ManagedIdleGenerationStore {
	active(): Promise<readonly ManagedIdleGenerationRecord[]>;
	prepareClose(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
	): Promise<boolean | ManagedIdleCloseIntent>;
	restoreActive(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void>;
	retire(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void>;
	markUncertain(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent, reason: string): Promise<void>;
	evict(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void>;
	publishRetired?(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void>;
}

export interface ManagedIdleAdmission {
	acquire(key: TenantSessionKey): Promise<(() => void) | undefined>;
}

export interface ManagedIdleLease {
	assertFence(): Promise<void>;
	release(): Promise<void>;
}

export interface ManagedIdleLeaseManager {
	acquire(key: TenantSessionKey): Promise<ManagedIdleLease | undefined>;
}

export interface ManagedIdleLifecycleRuntime {
	closeLifecycleSession(request: {
		readonly tenant: TenantSessionKey;
		readonly actor: Readonly<{ id: string; namespace: string }>;
		readonly capability: "session.close";
		readonly requestKey: string;
		readonly target: Readonly<{ sessionId: string; endpointGeneration: number }>;
		readonly timeoutMs?: number;
	}): Promise<Readonly<{ ok: boolean; certainty?: string; result?: Readonly<{ sessionId: string }> }>>;
	reconcile(): Promise<void>;
	generationStatus(key: TenantSessionKey): Promise<Readonly<{ status: string }>>;
}

export interface CreateManagedIdleReaperInput {
	readonly runtime: ManagedIdleLifecycleRuntime;
	readonly records: ManagedIdleGenerationStore;
	readonly admission: ManagedIdleAdmission;
	readonly leases: ManagedIdleLeaseManager;
	readonly idleTimeoutMs?: number;
	readonly closeTimeoutMs?: number;
	readonly now?: () => number;
	/** Optional production polling. Tests and embedders may drive runOnce directly. */
	readonly pollIntervalMs?: number;
	readonly setInterval?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setInterval>;
	readonly clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface ManagedIdleReaper {
	runOnce(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * Adapts canonical V3 mappings to the idle reaper's credential-free record
 * contract. Every mutation is a SessionMappingStore operation; no runtime
 * endpoint or user artifact is inspected.
 */
export function createManagedV3GenerationStore(mappings: SessionMappingStore): ManagedIdleGenerationStore {
	return new ManagedV3GenerationStore(mappings);
}

/**
 * Isolated public-SDK idle retirement.  It deliberately does not own a Router,
 * process lifecycle, endpoints, terminals, or any user artifact path.
 */
export function createManagedIdleReaper(input: CreateManagedIdleReaperInput): ManagedIdleReaper {
	return new ManagedIdleReaperImpl(input);
}

class ManagedIdleReaperImpl implements ManagedIdleReaper {
	readonly #timeoutMs: number;
	readonly #now: () => number;
	readonly #inFlight = new Map<string, Promise<void>>();
	readonly #clearInterval: (timer: ReturnType<typeof setInterval>) => void;
	#poller: ReturnType<typeof setInterval> | undefined;
	#stopped = false;
	#draining: Promise<void> | undefined;

	constructor(private readonly input: CreateManagedIdleReaperInput) {
		this.#timeoutMs = input.idleTimeoutMs ?? DEFAULT_MANAGED_IDLE_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0)
			throw new TypeError("idleTimeoutMs must be a positive safe integer.");
		this.#now = input.now ?? Date.now;
		this.#clearInterval = input.clearInterval ?? (timer => globalThis.clearInterval(timer));
		if (input.pollIntervalMs !== undefined) {
			if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs <= 0)
				throw new TypeError("pollIntervalMs must be a positive safe integer.");
			const setInterval = input.setInterval ?? ((handler, timeoutMs) => globalThis.setInterval(handler, timeoutMs));
			this.#poller = setInterval(() => {
				void this.runOnce().catch(() => undefined);
			}, input.pollIntervalMs);
			(this.#poller as unknown as { unref?: () => void }).unref?.();
		}
	}

	async runOnce(): Promise<void> {
		if (this.#stopped) return;
		const records = await this.input.records.active();
		await Promise.all(
			records.map(async record => {
				if (this.#stopped || record.state !== "active" || record.lastActivityAt + this.#timeoutMs > this.#now())
					return;
				const key = recordIdentity(record.authority);
				if (this.#inFlight.has(key)) return;
				const work = this.reap(record);
				this.#inFlight.set(key, work);
				try {
					await work;
				} finally {
					this.#inFlight.delete(key);
				}
			}),
		);
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#poller !== undefined) {
			this.#clearInterval(this.#poller);
			this.#poller = undefined;
		}
		if (this.#draining === undefined) {
			this.#draining = (async () => {
				while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight.values()]);
			})();
		}
		await this.#draining;
	}

	private async reap(record: ManagedIdleGenerationRecord): Promise<void> {
		const key = tenantKey(record.authority);
		let releaseAdmission: (() => void) | undefined;
		let lease: ManagedIdleLease | undefined;
		let intent: ManagedIdleCloseIntent | undefined;
		let retired = false;
		try {
			releaseAdmission = await this.input.admission.acquire(key);
			if (releaseAdmission === undefined || this.#stopped) return;
			lease = await this.input.leases.acquire(key);
			if (lease === undefined || this.#stopped) return;
			await lease.assertFence();
			const proposed = { key: closeKey(record.authority), authority: record.authority, requestedAt: this.#now() };
			const prepared = await this.input.records.prepareClose(record, proposed);
			if (prepared === false) return;
			intent = prepared === true ? proposed : prepared;
			let outcome: Awaited<ReturnType<ManagedIdleLifecycleRuntime["closeLifecycleSession"]>>;
			try {
				await lease.assertFence();
				if (this.#stopped) {
					await this.input.records.restoreActive(record, intent);
					return;
				}
				outcome = await this.input.runtime.closeLifecycleSession({
					tenant: key,
					actor: { id: record.authority.principalId, namespace: "openwebui-gjc-adapter" },
					capability: "session.close",
					requestKey: intent.key,
					target: { sessionId: record.authority.sessionId, endpointGeneration: record.authority.generation },
					timeoutMs: this.input.closeTimeoutMs,
				});
				await lease.assertFence();
				await this.input.runtime.reconcile();
				await lease.assertFence();
				const status = await this.input.runtime.generationStatus(key);
				await lease.assertFence();
				if (outcome.ok && outcome.result?.sessionId === key.sessionId && status.status === "retired") {
					await this.input.records.retire(record, intent);
					retired = true;
					await lease.assertFence();
					await this.input.records.evict(record, intent);
					await this.input.records.publishRetired?.(record, intent);
					return;
				}
				if (status.status === "current" && !outcome.ok && outcome.certainty === "retryable") {
					await this.input.records.restoreActive(record, intent);
					return;
				}
				await this.input.records.markUncertain(record, intent, `Exact generation status is ${status.status}.`);
			} catch (error) {
				if (intent !== undefined && !retired)
					await this.input.records.markUncertain(record, intent, errorMessage(error));
			}
		} finally {
			try {
				await lease?.release();
			} catch {}
			releaseAdmission?.();
		}
	}
}

class ManagedV3GenerationStore implements ManagedIdleGenerationStore {
	constructor(private readonly mappings: SessionMappingStore) {}

	async active(): Promise<readonly ManagedIdleGenerationRecord[]> {
		const records: ManagedIdleGenerationRecord[] = [];
		for (const mapping of this.mappings.mappingRecordsIterable()) {
			const authority = mapping.managedAuthority;
			if (
				!isManagedV3Authority(authority) ||
				authority.chatId !== mapping.chatId ||
				mapping.principalId !== authority.principalId ||
				mapping.projectId !== authority.projectId ||
				mapping.sessionId !== authority.sessionId
			)
				continue;
			const scope = { principalId: authority.principalId, chatId: mapping.chatId };
			const operations = this.mappings.operationsScoped(scope);
			records.push({
				authority,
				lastActivityAt: latestActivityAt(operations),
				state: generationState(mapping, operations),
			});
		}
		return records;
	}

	async prepareClose(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
	): Promise<boolean | ManagedIdleCloseIntent> {
		const scope = scopeFor(record.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, record.authority)) return false;
		const operations = this.mappings.operationsScoped(scope);
		if (generationState(mapping, operations) !== "active" || latestActivityAt(operations) !== record.lastActivityAt)
			return false;
		const closeOperations = operations.filter(operation => operation.kind === "close");
		const prior = closeOperations[closeOperations.length - 1];
		const key = nextManagedCloseIngress(intent.key, mapping.operationId, closeOperations, prior);
		this.mappings.beginOperationScoped(scope, {
			id: key,
			kind: "close",
			ingressId: key,
			detail: key,
		});
		return key === intent.key ? true : { ...intent, key };
	}

	async restoreActive(_record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void> {
		const scope = scopeFor(intent.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, intent.authority)) return;
		if (this.mappings.operationScoped(scope, intent.key) === undefined) return;
		this.mappings.transitionOperationScoped(
			scope,
			intent.key,
			"conflict",
			"Managed session close remains current and is retryable.",
		);
	}

	async retire(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void> {
		const scope = scopeFor(record.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, record.authority))
			throw new Error("Managed V3 mapping changed before durable retirement.");
		const result: SessionOperationResult = {
			kind: "close",
			assistantText: "",
			events: [],
			managedAuthority: record.authority,
			mapping: {
				chatId: mapping.chatId,
				projectId: mapping.projectId,
				sessionId: mapping.sessionId,
				rawFrameCursor: mapping.rawFrameCursor,
				eventCursor: mapping.eventCursor,
				operationId: intent.key,
			},
			correlation: { closeStatus: "closed", mappingOperationId: mapping.operationId },
		};
		this.mappings.transitionOperationScoped(scope, intent.key, "complete", intent.key, result);
	}

	async markUncertain(
		_record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		reason: string,
	): Promise<void> {
		const scope = scopeFor(intent.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, intent.authority)) return;
		if (this.mappings.operationScoped(scope, intent.key) === undefined) return;
		this.mappings.transitionOperationScoped(scope, intent.key, "uncertain", reason);
	}

	async evict(record: ManagedIdleGenerationRecord, _intent: ManagedIdleCloseIntent): Promise<void> {
		const scope = scopeFor(record.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, record.authority))
			throw new Error("Managed V3 mapping changed before durable eviction.");
		this.mappings.retireScoped(scope);
	}
}

function scopeFor(authority: ManagedTurnAuthority): { readonly principalId: string; readonly chatId: string } {
	return { principalId: authority.principalId, chatId: authority.chatId };
}

function sameManagedAuthority(mapping: SessionMapping, authority: ManagedTurnAuthority): boolean {
	const candidate = mapping.managedAuthority;
	return (
		isManagedV3Authority(candidate) &&
		mapping.principalId === authority.principalId &&
		mapping.chatId === authority.chatId &&
		mapping.projectId === authority.projectId &&
		mapping.sessionId === authority.sessionId &&
		candidate.principalId === authority.principalId &&
		candidate.projectId === authority.projectId &&
		candidate.canonicalWorkspace === authority.canonicalWorkspace &&
		candidate.chatId === authority.chatId &&
		candidate.sessionId === authority.sessionId &&
		candidate.generation === authority.generation &&
		candidate.leaseId === authority.leaseId &&
		candidate.epoch === authority.epoch &&
		candidate.requestKey === authority.requestKey
	);
}

function isManagedV3Authority(
	authority: ManagedTurnAuthority | undefined,
): authority is ManagedTurnAuthority & { readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH } {
	const candidate = authority as (ManagedTurnAuthority & { readonly authorityEpoch?: unknown }) | undefined;
	return (
		candidate?.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		nonEmpty(candidate.principalId) &&
		nonEmpty(candidate.projectId) &&
		isAbsolute(candidate.canonicalWorkspace) &&
		resolve(candidate.canonicalWorkspace) === candidate.canonicalWorkspace &&
		nonEmpty(candidate.chatId) &&
		nonEmpty(candidate.sessionId) &&
		nonEmpty(candidate.leaseId) &&
		nonEmpty(candidate.epoch) &&
		nonEmpty(candidate.requestKey) &&
		Number.isSafeInteger(candidate.generation) &&
		candidate.generation > 0
	);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function latestActivityAt(operations: readonly SessionOperation[]): number {
	let latest = 0;
	for (const operation of operations) {
		const startedAt = Date.parse(operation.startedAt);
		if (Number.isFinite(startedAt)) latest = Math.max(latest, startedAt);
		if (operation.completedAt !== undefined) {
			const completedAt = Date.parse(operation.completedAt);
			if (Number.isFinite(completedAt)) latest = Math.max(latest, completedAt);
		}
	}
	return latest;
}

function generationState(mapping: SessionMapping, operations: readonly SessionOperation[]): ManagedIdleGenerationState {
	if (operations.some(operation => operation.state === "pending")) return "inflight";
	const current = operations.find(operation => operation.id === mapping.operationId);
	if (current === undefined || current.state !== "complete") return "uncertain";
	const authority = mapping.managedAuthority!;
	const base = closeKey(authority);
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index]!;
		if (operation.kind !== "close") {
			if (operation.state === "uncertain" || operation.state === "conflict") return "uncertain";
			continue;
		}
		const idleClose =
			operation.id === base ||
			operation.id.startsWith(`${base}:retry:`) ||
			operation.id.startsWith(`${base}:rearmed:`);
		if (operation.state !== "complete") {
			// Only an explicitly not-applied idle close is safe to retry. Manual or
			// uncertain closes must be reconciled by their owner, including after restart.
			if (operation.state !== "conflict" || !idleClose) return "uncertain";
			continue;
		}
		const result = operation.result;
		if (
			result?.kind !== "close" ||
			result.correlation?.closeStatus !== "closed" ||
			result.correlation.mappingOperationId !== mapping.operationId ||
			result.mapping.chatId !== mapping.chatId ||
			result.mapping.projectId !== mapping.projectId ||
			result.mapping.sessionId !== mapping.sessionId ||
			!sameManagedAuthority({ ...mapping, managedAuthority: result.managedAuthority }, authority)
		)
			continue;
		const closedAt = Date.parse(operation.completedAt ?? operation.startedAt);
		const laterActivity = operations.some((activity, activityIndex) => {
			if (activity.kind === "close") return false;
			const activityAt = Date.parse(activity.completedAt ?? activity.startedAt);
			return activityAt > closedAt || (activityAt === closedAt && activityIndex > index);
		});
		if (!laterActivity) return "closing";
	}
	return "active";
}

function nextManagedCloseIngress(
	base: string,
	mappingOperationId: string,
	operations: readonly SessionOperation[],
	prior: SessionOperation | undefined,
): string {
	if (prior === undefined) return base;
	const retryCount = operations.filter(operation => operation.id.startsWith(`${base}:retry:`)).length + 1;
	const priorMappingOperationId = prior.result?.correlation?.mappingOperationId;
	if (prior.state === "complete" && priorMappingOperationId !== mappingOperationId) {
		const rearmCount = operations.filter(operation => operation.id.startsWith(`${base}:rearmed:`)).length + 1;
		return `${base}:rearmed:${mappingOperationId}:${rearmCount}`;
	}
	return `${base}:retry:${retryCount}`;
}

function tenantKey(authority: ManagedTurnAuthority): TenantSessionKey {
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
	};
}

function recordIdentity(authority: ManagedTurnAuthority): string {
	return [
		authority.principalId,
		authority.projectId,
		authority.canonicalWorkspace,
		authority.chatId,
		authority.sessionId,
		String(authority.generation),
		authority.leaseId,
		authority.epoch,
	].join("\u0000");
}

function closeKey(authority: ManagedTurnAuthority): string {
	return `managed-idle-close:${recordIdentity(authority)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Managed idle retirement is uncertain.";
}
