import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { transitionManagedLifecycleEvidence } from "../gjc/managed-lifecycle-evidence";
import type { TenantSessionKey } from "../gjc/managed-sdk-runtime";
import type { SessionOperation } from "../gjc/session-authority";
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
	/** Revalidates a durable successful retirement against the current full mapping authority. */
	pendingRetirement(record: ManagedIdleGenerationRecord): Promise<ManagedIdleCloseIntent | undefined>;
	acknowledge(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		acknowledgedSessionId: string,
	): Promise<void>;
	retire(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		evidence: Readonly<Record<string, unknown>>,
	): Promise<void>;
	markUncertain(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent, reason: string): Promise<void>;
	evict(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void>;
	/** Runs after durable retirement and before eviction; must be idempotent by intent.key. */
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
	generationStatus(key: TenantSessionKey): Promise<
		Readonly<{
			status: string;
			evidence?: {
				readonly source: string;
				readonly observedIndexSeq: number;
				readonly evidenceIndexSeq?: number;
				readonly event?: string;
			};
		}>
	>;
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

export interface ManagedIdlePollFailure {
	readonly error: unknown;
	readonly at: number;
}

export interface ManagedIdleReaper {
	/** Polling has no awaiting caller; retain its latest failure and also reject stop with it. */
	readonly lastPollFailure: ManagedIdlePollFailure | undefined;
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
	readonly #scans = new Set<Promise<void>>();
	readonly #clearInterval: (timer: ReturnType<typeof setInterval>) => void;
	#poller: ReturnType<typeof setInterval> | undefined;
	#lastPollFailure: ManagedIdlePollFailure | undefined;
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
				void this.runOnce().catch(error => {
					this.#lastPollFailure = Object.freeze({ error, at: this.#now() });
				});
			}, input.pollIntervalMs);
			(this.#poller as unknown as { unref?: () => void }).unref?.();
		}
	}

	get lastPollFailure(): ManagedIdlePollFailure | undefined {
		return this.#lastPollFailure;
	}

	runOnce(): Promise<void> {
		if (this.#stopped) return Promise.resolve();
		const scan = Promise.resolve()
			.then(() => this.scan())
			.finally(() => this.#scans.delete(scan));
		this.#scans.add(scan);
		return scan;
	}

	private async scan(): Promise<void> {
		if (this.#stopped) return;
		const records = await this.input.records.active();
		const results = await Promise.allSettled(
			records.map(async record => {
				if (
					this.#stopped ||
					(record.state !== "closing" &&
						(record.state !== "active" || record.lastActivityAt + this.#timeoutMs > this.#now()))
				)
					return;
				if (record.state === "closing" && (await this.input.records.pendingRetirement(record)) === undefined)
					return;
				if (this.#stopped) return;
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
		throwFailures(results.flatMap(result => (result.status === "rejected" ? [result.reason] : [])));
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#poller !== undefined) {
			this.#clearInterval(this.#poller);
			this.#poller = undefined;
		}
		if (this.#draining === undefined) {
			this.#draining = (async () => {
				const results = await Promise.allSettled([...this.#scans]);
				const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
				if (this.#lastPollFailure !== undefined) errors.push(this.#lastPollFailure.error);
				throwFailures([...new Set(errors)]);
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
		const errors: unknown[] = [];
		try {
			releaseAdmission = await this.input.admission.acquire(key);
			if (releaseAdmission === undefined || this.#stopped) return;
			lease = await this.input.leases.acquire(key);
			if (lease === undefined || this.#stopped) return;
			await lease.assertFence();
			if (record.state === "closing") {
				intent = await this.input.records.pendingRetirement(record);
				if (intent === undefined) return;
				retired = true;
				await this.finishRetirement(record, intent, lease);
				return;
			}
			const proposed = { key: closeKey(record.authority), authority: record.authority, requestedAt: this.#now() };
			const prepared = await this.input.records.prepareClose(record, proposed);
			if (prepared === false) return;
			intent = prepared === true ? proposed : prepared;
			let outcome: Awaited<ReturnType<ManagedIdleLifecycleRuntime["closeLifecycleSession"]>>;
			try {
				await lease.assertFence();
				if (this.#stopped) {
					await this.input.records.markUncertain(record, intent, "Stopped after durable close reservation.");
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
				if (!outcome.ok || outcome.result?.sessionId !== key.sessionId)
					throw new Error("Managed close lacks matching success and exact retirement.");
				await this.input.records.acknowledge(record, intent, outcome.result.sessionId);
				await lease.assertFence();
				await this.input.runtime.reconcile();
				await lease.assertFence();
				const status = await this.input.runtime.generationStatus(key);
				await lease.assertFence();
				if (status.status === "retired" && status.evidence !== undefined) {
					await this.input.records.retire(record, intent, { ...status.evidence });
					retired = true;
					await this.finishRetirement(record, intent, lease);
					return;
				}
				throw new Error(
					`Managed close lacks matching success and exact retirement; generation status is ${status.status}.`,
				);
			} catch (error) {
				errors.push(error);
				if (!retired) {
					try {
						await this.input.records.markUncertain(record, intent, errorMessage(error));
					} catch (persistenceError) {
						errors.push(persistenceError);
					}
				}
			}
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				await lease?.release();
			} catch (releaseError) {
				errors.push(releaseError);
			}
			try {
				releaseAdmission?.();
			} catch (releaseError) {
				errors.push(releaseError);
			}
			throwFailures(errors);
		}
	}

	private async finishRetirement(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		lease: ManagedIdleLease,
	): Promise<void> {
		const revalidate = async () => {
			await lease.assertFence();
			const pending = await this.input.records.pendingRetirement(record);
			if (
				pending === undefined ||
				pending.key !== intent.key ||
				recordIdentity(pending.authority) !== recordIdentity(record.authority) ||
				pending.authority.requestKey !== record.authority.requestKey
			)
				throw new Error("Managed retirement receipt changed before local cleanup.");
		};
		await revalidate();
		await this.input.records.publishRetired?.(record, intent);
		await revalidate();
		await this.input.records.evict(record, intent);
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
		const key = intent.key;
		this.mappings.reserveManagedRetirementScoped(scope, record.authority, {
			operationId: key,
			requestKey: key,
			payloadHash: managedIdleClosePayloadHash(record.authority, key),
		});
		return key === intent.key ? true : { ...intent, key };
	}

	async pendingRetirement(record: ManagedIdleGenerationRecord): Promise<ManagedIdleCloseIntent | undefined> {
		return this.retirementIntent(record);
	}

	private retirementIntent(record: ManagedIdleGenerationRecord): ManagedIdleCloseIntent | undefined {
		const scope = scopeFor(record.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, record.authority)) return undefined;
		const operations = this.mappings.operationsScoped(scope);
		if (generationState(mapping, operations) !== "closing") return undefined;
		const operation = completedRetirement(mapping, operations);
		if (operation === undefined) return undefined;
		return { key: operation.id, authority: record.authority, requestedAt: Date.parse(operation.startedAt) };
	}

	async acknowledge(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		acknowledgedSessionId: string,
	): Promise<void> {
		const scope = scopeFor(record.authority);
		const mapping = this.mappings.getScoped(scope);
		const operation = this.mappings.operationScoped(scope, intent.key);
		if (
			mapping === undefined ||
			!sameManagedAuthority(mapping, record.authority) ||
			acknowledgedSessionId !== record.authority.sessionId ||
			operation?.lifecycle === undefined
		)
			throw new Error("Managed close acknowledgement does not match its canonical reservation.");
		const observedAt = new Date().toISOString();
		this.mappings.recordLifecycleEvidenceScoped(
			scope,
			intent.key,
			operation.detail!,
			transitionManagedLifecycleEvidence(
				operation.lifecycle,
				"closing",
				{
					closeAcknowledgement: {
						sessionId: acknowledgedSessionId,
						generation: record.authority.generation,
						observedAt,
					},
				},
				observedAt,
			),
		);
	}

	async retire(
		record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		evidence: Readonly<Record<string, unknown>>,
	): Promise<void> {
		this.mappings.completeManagedRetirementScoped(scopeFor(record.authority), record.authority, intent.key, evidence);
	}

	async markUncertain(
		_record: ManagedIdleGenerationRecord,
		intent: ManagedIdleCloseIntent,
		reason: string,
	): Promise<void> {
		const scope = scopeFor(intent.authority);
		const mapping = this.mappings.getScoped(scope);
		if (mapping === undefined || !sameManagedAuthority(mapping, intent.authority)) return;
		const operation = this.mappings.operationScoped(scope, intent.key);
		if (operation === undefined) return;
		if (operation.lifecycle?.state === "closing")
			this.mappings.recordLifecycleEvidenceScoped(
				scope,
				intent.key,
				operation.detail!,
				transitionManagedLifecycleEvidence(operation.lifecycle, "uncertain"),
			);
		// The payload binding is immutable; error text is caller-visible, not a new hash.
		void reason;
		this.mappings.transitionOperationScoped(scope, intent.key, "uncertain", operation.detail);
	}

	async evict(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<void> {
		const scope = scopeFor(record.authority);
		const pending = this.retirementIntent(record);
		if (pending === undefined || pending.key !== intent.key)
			throw new Error("Managed V3 retirement receipt changed before durable eviction.");
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
	for (const operation of operations) {
		if (operation.kind !== "close") {
			if (operation.state === "uncertain" || operation.state === "conflict") return "uncertain";
			continue;
		}
		if (operation.state !== "complete") {
			// A retryable label or conflict journal state is not public not-applied proof.
			return "uncertain";
		}
		if (completedRetirement(mapping, [operation]) === undefined) return "uncertain";
	}
	return completedRetirement(mapping, operations) === undefined ? "active" : "closing";
}

function completedRetirement(
	mapping: SessionMapping,
	operations: readonly SessionOperation[],
): SessionOperation | undefined {
	const authority = mapping.managedAuthority!;
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index]!;
		if (operation.kind !== "close" || operation.state !== "complete") continue;
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
		if (!laterActivity) return operation;
	}
	return undefined;
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
	return `managed-idle-close:${createHash("sha256").update(recordIdentity(authority)).digest("hex")}`;
}

export function managedIdleClosePayloadHash(authority: ManagedTurnAuthority, requestKey: string): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"session.close",
				recordIdentity(authority),
				authority.requestKey,
				requestKey,
				authority.sessionId,
				authority.generation,
			]),
		)
		.digest("hex");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Managed idle retirement is uncertain.";
}

function throwFailures(errors: readonly unknown[]): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Managed idle retirement failed.");
}
