import type { ManagedSdkRuntime, TenantSessionKey } from "./managed-sdk-runtime";
import {
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityMigrationCheckpoint,
	type ManagedSessionAuthorityMigrationRecord,
	type ManagedSessionAuthorityRecord,
	managedSessionAuthorityHash,
} from "./managed-session-authority";

/** Durable coordinator states. Only `active` permits normal public work. */
export const MANAGED_AUTHORITY_ACTIVATION_PHASES = [
	"inactive",
	"preparing",
	"router_bootstrap",
	"rebinding",
	"committing",
	"active",
	"blocked",
	"failed",
] as const;

export type ManagedAuthorityActivationPhase = (typeof MANAGED_AUTHORITY_ACTIVATION_PHASES)[number];

export interface ManagedAuthorityActivationResult {
	readonly phase: ManagedAuthorityActivationPhase;
	readonly ready: boolean;
	readonly routerAvailable: boolean;
	readonly epoch?: string;
	readonly reason?: string;
}

export interface ManagedAuthorityActivationBinding {
	readonly record: ManagedSessionAuthorityRecord;
	readonly tenant: TenantSessionKey;
}

/**
 * This is deliberately a capability interface rather than a filesystem API.
 * Implementations own only authority database inputs; they MUST NOT enumerate,
 * copy, rename, delete, or otherwise access user transcript/artifact paths.
 */
export interface ManagedAuthorityActivationStorage {
	load(): Promise<ManagedAuthorityActivationJournal | undefined>;
	save(journal: ManagedAuthorityActivationJournal): Promise<void>;
	backupSource(): Promise<void>;
	fsyncBackup(): Promise<void>;
	fsyncSource(): Promise<void>;
	fsyncWal(): Promise<void>;
	writeManifest(manifest: ManagedAuthorityActivationManifest): Promise<void>;
	fsyncManifest(): Promise<void>;
	stageRecord(record: ManagedSessionAuthorityRecord): Promise<void>;
	fsyncStagedRecord(identity: string): Promise<void>;
	fsyncCheckpoint(): Promise<void>;
	replaceCanonical(): Promise<void>;
	/** Recovery proof for a crash in the replacement syscall window. */
	canonicalReplacementState(): Promise<"replaced" | "not_replaced" | "uncertain">;
	writeActiveMarker(epoch: string, manifestDigest: string): Promise<void>;
	fsyncActiveMarker(): Promise<void>;
	rollbackPreReplacement(): Promise<void>;
}

export interface ManagedAuthorityActivationLock {
	assertHeld(): Promise<void>;
	release(): Promise<void>;
}

export interface ManagedAuthorityActivationOwner {
	acquire(): Promise<ManagedAuthorityActivationLock>;
}

/** The Router is started only for bootstrap attachment proof; it never admits public work here. */
export type ManagedAuthorityBootstrapRuntime = Pick<
	ManagedSdkRuntime,
	"start" | "reconcile" | "registerTenant" | "acquireAttachment"
>;

export interface ManagedAuthorityLifecycleRecovery {
	/** Resume exactly the tenant key paired with the staged record. */
	resume(record: ManagedSessionAuthorityRecord, tenant: TenantSessionKey): Promise<void>;
}

export interface ManagedAuthorityAdmission {
	open(): Promise<void>;
}

export interface ManagedAuthorityActivationManifest {
	readonly authorityEpoch: typeof MANAGED_SESSION_AUTHORITY_EPOCH;
	readonly digest: string;
	readonly checkpoint: ManagedSessionAuthorityMigrationCheckpoint;
	readonly records: readonly ManagedSessionAuthorityMigrationRecord[];
}

export interface ManagedAuthorityActivationJournal {
	readonly manifest: ManagedAuthorityActivationManifest;
	readonly phase: Exclude<ManagedAuthorityActivationPhase, "inactive" | "blocked" | "failed" | "active"> | "active";
	readonly staged: readonly string[];
	readonly canonicalReplaced: boolean;
	readonly activeMarker: boolean;
}

export interface ManagedAuthorityActivationOptions {
	readonly manifest: ManagedAuthorityActivationManifest;
	readonly bindings: readonly ManagedAuthorityActivationBinding[];
	readonly storage: ManagedAuthorityActivationStorage;
	readonly owner: ManagedAuthorityActivationOwner;
	readonly runtime: ManagedAuthorityBootstrapRuntime;
	readonly lifecycle: ManagedAuthorityLifecycleRecovery;
	readonly admission: ManagedAuthorityAdmission;
}

/**
 * Atomic v2-to-v3 managed-authority activation. It is intentionally un-wired:
 * callers supply every side effect and are responsible for constructing the
 * manifest from authenticated legacy evidence.
 */
export class ManagedAuthorityActivationCoordinator {
	readonly #options: ManagedAuthorityActivationOptions;
	#routerAvailable = false;
	#replacementComplete = false;

	constructor(options: ManagedAuthorityActivationOptions) {
		assertManifest(options.manifest);
		assertBindings(options.manifest, options.bindings);
		this.#options = options;
	}

	async activate(): Promise<ManagedAuthorityActivationResult> {
		let lock: ManagedAuthorityActivationLock | undefined;
		try {
			lock = await this.#options.owner.acquire();
			await lock.assertHeld();
			const prior = await this.#options.storage.load();
			if (prior !== undefined) {
				assertJournal(prior);
				assertSameManifest(prior.manifest, this.#options.manifest);
				if (prior.activeMarker) {
					this.#replacementComplete = true;
					return await this.#activateAdmission(lock, prior);
				}
				if (prior.canonicalReplaced) {
					this.#replacementComplete = true;
					return await this.#recoverCommitting(lock, prior);
				}
				if (prior.phase === "committing") {
					const replacement = await this.#options.storage.canonicalReplacementState();
					if (replacement === "replaced") {
						this.#replacementComplete = true;
						return await this.#recoverCommitting(lock, { ...prior, canonicalReplaced: true });
					}
					if (replacement === "uncertain") return blocked("Canonical replacement state is uncertain.");
				}
				await this.#options.storage.rollbackPreReplacement();
			}
			if (this.#options.manifest.records.some(record => record.status === "migration_blocked"))
				return blocked("Migration contains blocked tenant authority.");
			return await this.#prepareAndActivate(lock);
		} catch (error) {
			if (!this.#replacementComplete && lock !== undefined) {
				try {
					await lock.assertHeld();
					await this.#options.storage.rollbackPreReplacement();
				} catch {
					// A lost lock makes rollback unsafe; durable recovery remains fail-closed.
				}
			}
			return this.#failed(error);
		} finally {
			await lock?.release().catch(() => undefined);
		}
	}

	async #prepareAndActivate(lock: ManagedAuthorityActivationLock): Promise<ManagedAuthorityActivationResult> {
		const journal = this.#journal("preparing", []);
		await this.#save(lock, journal);
		await this.#boundary(lock, () => this.#options.storage.backupSource());
		await this.#boundary(lock, () => this.#options.storage.fsyncBackup());
		await this.#boundary(lock, () => this.#options.storage.fsyncSource());
		await this.#boundary(lock, () => this.#options.storage.fsyncWal());
		await this.#boundary(lock, () => this.#options.storage.writeManifest(this.#options.manifest));
		await this.#boundary(lock, () => this.#options.storage.fsyncManifest());

		await this.#save(lock, { ...journal, phase: "router_bootstrap" });
		await this.#boundary(lock, async () => {
			await this.#options.runtime.start();
			this.#routerAvailable = true;
		});
		await this.#save(lock, { ...journal, phase: "rebinding" });
		const staged: string[] = [];
		for (const binding of this.#options.bindings) {
			await this.#boundary(lock, () => this.#options.lifecycle.resume(binding.record, binding.tenant));
			await this.#boundary(lock, async () => {
				this.#options.runtime.registerTenant(binding.tenant);
				await this.#options.runtime.reconcile();
				const attachment = await this.#options.runtime.acquireAttachment(binding.tenant);
				if (attachment.generation !== binding.tenant.generation || !attachment.attachment.isCurrent())
					throw new Error("Exact current Router attachment proof is required.");
			});
			const identity = managedSessionAuthorityHash(binding.record);
			await this.#boundary(lock, () => this.#options.storage.stageRecord(binding.record));
			await this.#boundary(lock, () => this.#options.storage.fsyncStagedRecord(identity));
			staged.push(identity);
			await this.#save(lock, this.#journal("rebinding", staged));
		}
		const committing = this.#journal("committing", staged);
		await this.#save(lock, committing);
		await this.#boundary(lock, () => this.#options.storage.fsyncCheckpoint());
		await this.#boundary(lock, () => this.#options.storage.replaceCanonical());
		this.#replacementComplete = true;
		const replaced = { ...committing, canonicalReplaced: true };
		await this.#save(lock, replaced);
		return await this.#finishMarker(lock, replaced);
	}

	async #recoverCommitting(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		if (journal.phase !== "committing") throw new Error("Canonical replacement requires a committing checkpoint.");
		return await this.#finishMarker(lock, journal);
	}

	async #finishMarker(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		await this.#save(lock, { ...journal, phase: "committing", canonicalReplaced: true });
		await this.#boundary(lock, () =>
			this.#options.storage.writeActiveMarker(MANAGED_SESSION_AUTHORITY_EPOCH, this.#options.manifest.digest),
		);
		await this.#boundary(lock, () => this.#options.storage.fsyncActiveMarker());
		return await this.#activateAdmission(lock, {
			...journal,
			phase: "active",
			canonicalReplaced: true,
			activeMarker: true,
		});
	}

	async #activateAdmission(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		await this.#save(lock, { ...journal, phase: "active", canonicalReplaced: true, activeMarker: true });
		await this.#boundary(lock, () => this.#options.admission.open());
		return { phase: "active", ready: true, routerAvailable: true, epoch: MANAGED_SESSION_AUTHORITY_EPOCH };
	}

	#journal(
		phase: ManagedAuthorityActivationJournal["phase"],
		staged: readonly string[],
	): ManagedAuthorityActivationJournal {
		return {
			manifest: this.#options.manifest,
			phase,
			staged: [...staged],
			canonicalReplaced: false,
			activeMarker: false,
		};
	}

	async #save(lock: ManagedAuthorityActivationLock, journal: ManagedAuthorityActivationJournal): Promise<void> {
		await this.#boundary(lock, () => this.#options.storage.save(journal));
	}

	async #boundary(lock: ManagedAuthorityActivationLock, effect: () => Promise<void>): Promise<void> {
		await lock.assertHeld();
		await effect();
		await lock.assertHeld();
	}

	#failed(error: unknown): ManagedAuthorityActivationResult {
		return {
			phase: "failed",
			ready: false,
			routerAvailable: this.#routerAvailable,
			reason: error instanceof Error ? error.message : "Managed authority activation failed.",
		};
	}
}

function assertManifest(manifest: ManagedAuthorityActivationManifest): void {
	if (
		manifest.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH ||
		typeof manifest.digest !== "string" ||
		manifest.digest.length === 0 ||
		manifest.checkpoint.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH
	)
		throw new TypeError("A v3 authority manifest with an exact epoch and digest is required.");
	if (manifest.checkpoint.records.some(record => record.status === "migration_blocked")) return;
	if (manifest.checkpoint.canonicalReplaced || manifest.checkpoint.activeMarkerReady)
		throw new TypeError("Activation input must be an inactive checkpoint.");
}

function assertBindings(
	manifest: ManagedAuthorityActivationManifest,
	bindings: readonly ManagedAuthorityActivationBinding[],
): void {
	if (
		!manifest.records.some(record => record.status === "migration_blocked") &&
		bindings.length !== manifest.records.length
	)
		throw new TypeError("Every manifest record requires an exact tenant binding.");
	const seen = new Set<string>();
	for (const binding of bindings) {
		const record = binding.record;
		if (
			record.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH ||
			record.principalId !== binding.tenant.principalId ||
			record.projectId !== binding.tenant.projectId ||
			record.canonicalWorkspace !== binding.tenant.canonicalWorkspace ||
			record.chatId !== binding.tenant.chatId ||
			record.sessionId !== binding.tenant.sessionId ||
			record.generation !== binding.tenant.generation ||
			record.lifecycle.state === "uncertain" ||
			record.lifecycle.state === "cleanup_pending" ||
			record.lifecycle.state === "cleanup_uncertain"
		)
			throw new TypeError("Every binding requires exact non-uncertain managed tenant authority.");
		const identity = managedSessionAuthorityHash(record);
		if (seen.has(identity)) throw new TypeError("Duplicate managed authority binding.");
		seen.add(identity);
	}
}

function assertJournal(journal: ManagedAuthorityActivationJournal): void {
	assertManifest(journal.manifest);
	if (journal.activeMarker && !journal.canonicalReplaced)
		throw new Error("Active marker cannot precede canonical replacement.");
}

function assertSameManifest(left: ManagedAuthorityActivationManifest, right: ManagedAuthorityActivationManifest): void {
	if (left.authorityEpoch !== right.authorityEpoch || left.digest !== right.digest)
		throw new Error("Activation manifest digest does not match durable activation state.");
}

function blocked(reason: string): ManagedAuthorityActivationResult {
	return { phase: "blocked", ready: false, routerAvailable: false, reason };
}
