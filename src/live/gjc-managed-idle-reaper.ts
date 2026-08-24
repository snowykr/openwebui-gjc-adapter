import type { TenantSessionKey } from "../gjc/managed-sdk-runtime";
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
	prepareClose(record: ManagedIdleGenerationRecord, intent: ManagedIdleCloseIntent): Promise<boolean>;
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
		readonly actor: Readonly<{ id: string; namespace: string }>;
		readonly capability: "session.close";
		readonly requestKey: string;
		readonly target: Readonly<{ sessionId: string; endpointGeneration: number }>;
		readonly timeoutMs?: number;
	}): Promise<Readonly<{ ok: boolean; certainty?: string }>>;
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
}

export interface ManagedIdleReaper {
	runOnce(): Promise<void>;
	stop(): Promise<void>;
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
	#stopped = false;
	#draining: Promise<void> | undefined;

	constructor(private readonly input: CreateManagedIdleReaperInput) {
		this.#timeoutMs = input.idleTimeoutMs ?? DEFAULT_MANAGED_IDLE_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0)
			throw new TypeError("idleTimeoutMs must be a positive safe integer.");
		this.#now = input.now ?? Date.now;
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
		try {
			releaseAdmission = await this.input.admission.acquire(key);
			if (releaseAdmission === undefined || this.#stopped) return;
			lease = await this.input.leases.acquire(key);
			if (lease === undefined || this.#stopped) return;
			await lease.assertFence();
			intent = { key: closeKey(record.authority), authority: record.authority, requestedAt: this.#now() };
			if (!(await this.input.records.prepareClose(record, intent))) return;
			await lease.assertFence();
			let outcome: Readonly<{ ok: boolean; certainty?: string }>;
			try {
				outcome = await this.input.runtime.closeLifecycleSession({
					actor: { id: record.authority.principalId, namespace: record.authority.projectId },
					capability: "session.close",
					requestKey: intent.key,
					target: { sessionId: record.authority.sessionId, endpointGeneration: record.authority.generation },
					timeoutMs: this.input.closeTimeoutMs,
				});
				await lease.assertFence();
				await this.input.runtime.reconcile();
				await lease.assertFence();
				const status = await this.input.runtime.generationStatus(key);
				if (status.status === "retired") {
					await lease.assertFence();
					await this.input.records.retire(record, intent);
					await lease.assertFence();
					await this.input.records.evict(record, intent);
					await lease.assertFence();
					await this.input.records.publishRetired?.(record, intent);
					return;
				}
				if (status.status === "current" && !outcome.ok && outcome.certainty === "retryable") {
					await this.input.records.restoreActive(record, intent);
					return;
				}
				await this.input.records.markUncertain(record, intent, `Exact generation status is ${status.status}.`);
			} catch (error) {
				if (intent !== undefined) await this.input.records.markUncertain(record, intent, errorMessage(error));
			}
		} finally {
			try {
				await lease?.release();
			} catch {}
			releaseAdmission?.();
		}
	}
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
