import { createHash } from "node:crypto";
import type { ManagedSdkRuntime, TenantSessionKey } from "./managed-sdk-runtime";
import {
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityMigrationCheckpoint,
	type ManagedSessionAuthorityMigrationRecord,
	type ManagedSessionAuthorityRecord,
	managedSessionAuthorityHash,
} from "./managed-session-authority";

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

/** Generation-free, credential-free public lifecycle input recovered from immutable evidence. */
export interface ManagedAuthorityPreparedRebindIntent {
	readonly principalId: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly actorDigest: string;
	readonly actorRef: string;
	readonly stableKey: string;
	readonly operationHash: string;
	readonly requestHash: string;
	readonly payloadHash: string;
	readonly leaseId: string;
	readonly epoch: string;
	readonly preparedAt: string;
	readonly observedAt: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly activeLeaf?: string;
}

/** Legacy inputs deliberately carry no endpoint generation and cannot be authority records. */
export interface ManagedAuthorityActivationBinding {
	readonly intent: ManagedAuthorityPreparedRebindIntent;
}

export type ManagedAuthorityLifecycleOutcome =
	| Readonly<{ ok: true; sessionId: string; endpointGeneration: number; acknowledgedAt: string }>
	| Readonly<{ ok: false; reason: string }>;

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
/** Router bootstrapping is proof-only and must never open public admission. */
export type ManagedAuthorityBootstrapRuntime = Pick<
	ManagedSdkRuntime,
	"state" | "start" | "reconcile" | "registerTenant" | "acquireAttachment"
>;
export interface ManagedAuthorityLifecycleRecovery {
	resume(intent: ManagedAuthorityPreparedRebindIntent): Promise<ManagedAuthorityLifecycleOutcome>;
	recover(
		intent: ManagedAuthorityPreparedRebindIntent,
		state: ManagedAuthorityActivationItemJournal["state"],
		record?: ManagedSessionAuthorityRecord,
	): Promise<ManagedAuthorityLifecycleOutcome>;
}
export interface ManagedAuthorityAdmission {
	open(): Promise<void>;
	close?(): Promise<void>;
}
export interface ManagedAuthorityActivationManifest {
	readonly authorityEpoch: typeof MANAGED_SESSION_AUTHORITY_EPOCH;
	readonly digest: string;
	readonly checkpoint: ManagedSessionAuthorityMigrationCheckpoint;
	readonly records: readonly ManagedSessionAuthorityMigrationRecord[];
}
export interface ManagedAuthorityActivationItemJournal {
	readonly intent: ManagedAuthorityPreparedRebindIntent;
	readonly state: "intent_prepared" | "invoking" | "acknowledged_unproven" | "active_generation_proven";
	readonly record?: ManagedSessionAuthorityRecord;
}
export interface ManagedAuthorityActivationJournal {
	readonly manifest: ManagedAuthorityActivationManifest;
	readonly phase: Exclude<ManagedAuthorityActivationPhase, "inactive" | "blocked" | "failed">;
	readonly staged: readonly string[];
	readonly items: readonly ManagedAuthorityActivationItemJournal[];
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
	readonly preparedIntentFence: (intent: ManagedAuthorityPreparedRebindIntent) => boolean | Promise<boolean>;
	/** Exact external lease/epoch proof. Bootstrap proof alone never admits public work. */
	readonly tenantFence: (key: TenantSessionKey) => boolean | Promise<boolean>;
}

export class ManagedAuthorityActivationCoordinator {
	readonly #options: ManagedAuthorityActivationOptions;
	#routerAvailable = false;
	constructor(options: ManagedAuthorityActivationOptions) {
		assertManifest(options.manifest);
		assertBindings(options.manifest, options.bindings);
		this.#options = options;
	}

	async activate(): Promise<ManagedAuthorityActivationResult> {
		let lock: ManagedAuthorityActivationLock | undefined;
		let result: ManagedAuthorityActivationResult;
		try {
			lock = await this.#options.owner.acquire();
			await lock.assertHeld();
			const prior = await this.#options.storage.load();
			if (prior !== undefined) {
				assertJournal(prior);
				assertSameManifest(prior.manifest, this.#options.manifest);
				assertRecoveryItems(prior.items, this.#options.bindings);
				if (prior.activeMarker) {
					result = await this.#activateAdmission(lock, prior);
				} else if (prior.canonicalReplaced) {
					result = await this.#recoverCommitting(lock, prior);
				} else {
					if (prior.phase === "committing") {
						const replacement = await this.#options.storage.canonicalReplacementState();
						if (replacement === "uncertain") result = blocked("Canonical replacement state is uncertain.");
						else if (replacement === "replaced") {
							result = await this.#recoverCommitting(lock, { ...prior, canonicalReplaced: true });
						} else result = await this.#recoverPreReplacement(lock, prior);
					} else {
						result = await this.#recoverPreReplacement(lock, prior);
					}
				}
			} else if (this.#options.manifest.records.some(record => record.status !== "intent_prepared"))
				result = blocked("Migration contains non-serving tenant authority.");
			else result = await this.#prepareAndActivate(lock);
		} catch (error) {
			// Durable item evidence is recovery input. Never erase it after an
			// invocation boundary; a later owner must use lifecycle.recover.
			result = this.#failed(error);
		}
		if (lock !== undefined) {
			try {
				await lock.release();
			} catch (error) {
				await this.#options.admission.close?.();
				return blocked(`Managed authority lock release failed: ${message(error)}`);
			}
		}
		return result!;
	}

	async #prepareAndActivate(lock: ManagedAuthorityActivationLock): Promise<ManagedAuthorityActivationResult> {
		let journal = this.#journal(
			"preparing",
			[],
			this.#options.bindings.map(binding => ({ intent: binding.intent, state: "intent_prepared" as const })),
		);
		await this.#save(lock, journal);
		for (const effect of [
			() => this.#options.storage.backupSource(),
			() => this.#options.storage.fsyncBackup(),
			() => this.#options.storage.fsyncSource(),
			() => this.#options.storage.fsyncWal(),
			() => this.#options.storage.writeManifest(this.#options.manifest),
			() => this.#options.storage.fsyncManifest(),
		])
			await this.#boundary(lock, effect);
		await this.#save(lock, { ...journal, phase: "router_bootstrap" });
		await this.#boundary(lock, async () => {
			await this.#options.runtime.start();
			this.#routerAvailable = true;
		});
		journal = { ...journal, phase: "rebinding" };
		await this.#save(lock, journal);
		const staged: string[] = [];
		for (let index = 0; index < journal.items.length; index++) {
			let item = journal.items[index]!;
			if (item.state !== "intent_prepared") throw new Error("Only prepared lifecycle intents may resume.");
			await this.#assertPreparedIntentFence(lock, item.intent);
			item = { ...item, state: "invoking" };
			journal = replaceItem(journal, index, item);
			await this.#save(lock, journal);
			await this.#assertPreparedIntentFence(lock, item.intent);
			const outcome = await this.#boundaryResult(lock, () => this.#options.lifecycle.resume(item.intent));
			await this.#assertPreparedIntentFence(lock, item.intent);
			if (
				!outcome.ok ||
				outcome.sessionId !== item.intent.sessionId ||
				!isPositiveGeneration(outcome.endpointGeneration) ||
				!isTimestamp(outcome.acknowledgedAt)
			)
				throw new Error("Lifecycle resume did not return a validated exact public outcome.");
			item = { ...item, state: "acknowledged_unproven" };
			journal = replaceItem(journal, index, item);
			await this.#save(lock, journal);
			const tenant = toTenant(item.intent, outcome.endpointGeneration);
			await this.#assertFence(lock, tenant);
			await this.#boundary(lock, async () => {
				this.#options.runtime.registerTenant(tenant);
				await this.#options.runtime.reconcile();
			});
			await this.#assertFence(lock, tenant);
			const attachment = await this.#boundaryResult(lock, () => this.#options.runtime.acquireAttachment(tenant));
			if (attachment.generation !== tenant.generation || !attachment.isCurrent())
				throw new Error("Exact current Router attachment proof is required.");
			await this.#assertFence(lock, tenant);
			const record = toRecord(item.intent, outcome);
			item = { ...item, state: "active_generation_proven", record };
			journal = replaceItem(journal, index, item);
			await this.#save(lock, journal);
			const identity = managedSessionAuthorityHash(record);
			await this.#boundary(lock, () => this.#options.storage.stageRecord(record));
			await this.#boundary(lock, () => this.#options.storage.fsyncStagedRecord(identity));
			staged.push(identity);
			journal = { ...journal, staged: [...staged] };
			await this.#save(lock, journal);
		}
		const committing = { ...journal, phase: "committing" as const };
		await this.#save(lock, committing);
		await this.#boundary(lock, () => this.#options.storage.fsyncCheckpoint());
		await this.#boundary(lock, () => this.#options.storage.replaceCanonical());
		return await this.#finishMarker(lock, { ...committing, canonicalReplaced: true });
	}
	async #recoverCommitting(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		if (journal.phase !== "committing") throw new Error("Canonical replacement requires a committing checkpoint.");
		return await this.#finishMarker(lock, journal);
	}
	async #recoverPreReplacement(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		if (this.#options.runtime.state !== "running")
			await this.#boundary(lock, async () => {
				await this.#options.runtime.start();
				this.#routerAvailable = true;
			});
		let recovered: ManagedAuthorityActivationJournal = { ...journal, phase: "rebinding" };
		for (let index = 0; index < recovered.items.length; index++) {
			let item = recovered.items[index]!;
			await this.#assertPreparedIntentFence(lock, item.intent);
			let outcome: ManagedAuthorityLifecycleOutcome;
			if (item.state === "intent_prepared") {
				item = { ...item, state: "invoking" };
				recovered = replaceItem(recovered, index, item);
				await this.#save(lock, recovered);
				await this.#assertPreparedIntentFence(lock, item.intent);
				outcome = await this.#boundaryResult(lock, () => this.#options.lifecycle.resume(item.intent));
			} else if (item.state === "active_generation_proven" && item.record !== undefined) {
				outcome = {
					ok: true,
					sessionId: item.record.sessionId,
					endpointGeneration: item.record.generation,
					acknowledgedAt: item.record.lifecycle.recordedAt,
				};
			} else {
				outcome = await this.#boundaryResult(lock, () =>
					this.#options.lifecycle.recover(item.intent, item.state, item.record),
				);
			}
			await this.#assertPreparedIntentFence(lock, item.intent);
			if (
				!outcome.ok ||
				outcome.sessionId !== item.intent.sessionId ||
				!isPositiveGeneration(outcome.endpointGeneration) ||
				!isTimestamp(outcome.acknowledgedAt)
			)
				return blocked("Lifecycle recovery did not return validated durable evidence.");
			const record = await this.#proveRecoveredRecord(lock, item.intent, outcome, item.record);
			if (record.generation !== outcome.endpointGeneration)
				return blocked("Recovered generation evidence conflicts with journal.");
			recovered = replaceItem(recovered, index, { ...item, state: "active_generation_proven", record });
			const identity = managedSessionAuthorityHash(record);
			if (!recovered.staged.includes(identity)) {
				await this.#boundary(lock, () => this.#options.storage.stageRecord(record));
				await this.#boundary(lock, () => this.#options.storage.fsyncStagedRecord(identity));
				recovered = { ...recovered, staged: [...recovered.staged, identity] };
			}
			await this.#save(lock, recovered);
		}
		const committing = { ...recovered, phase: "committing" as const };
		await this.#save(lock, committing);
		await this.#boundary(lock, () => this.#options.storage.fsyncCheckpoint());
		await this.#boundary(lock, () => this.#options.storage.replaceCanonical());
		return await this.#finishMarker(lock, { ...committing, canonicalReplaced: true });
	}
	async #proveRecoveredRecord(
		lock: ManagedAuthorityActivationLock,
		intent: ManagedAuthorityPreparedRebindIntent,
		outcome: Extract<ManagedAuthorityLifecycleOutcome, { ok: true }>,
		existing?: ManagedSessionAuthorityRecord,
	): Promise<ManagedSessionAuthorityRecord> {
		const tenant = toTenant(intent, outcome.endpointGeneration);
		await this.#assertFence(lock, tenant);
		await this.#boundary(lock, async () => {
			this.#options.runtime.registerTenant(tenant);
			await this.#options.runtime.reconcile();
		});
		await this.#assertFence(lock, tenant);
		const attachment = await this.#boundaryResult(lock, () => this.#options.runtime.acquireAttachment(tenant));
		if (attachment.generation !== tenant.generation || !attachment.isCurrent())
			throw new Error("Recovered exact current Router attachment proof is required.");
		await this.#assertFence(lock, tenant);
		return existing ?? toRecord(intent, outcome);
	}
	async #finishMarker(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		const saved = { ...journal, phase: "committing" as const, canonicalReplaced: true };
		await this.#save(lock, saved);
		await this.#boundary(lock, () =>
			this.#options.storage.writeActiveMarker(MANAGED_SESSION_AUTHORITY_EPOCH, this.#options.manifest.digest),
		);
		await this.#boundary(lock, () => this.#options.storage.fsyncActiveMarker());
		return await this.#activateAdmission(lock, { ...saved, phase: "active", activeMarker: true });
	}
	async #activateAdmission(
		lock: ManagedAuthorityActivationLock,
		journal: ManagedAuthorityActivationJournal,
	): Promise<ManagedAuthorityActivationResult> {
		if (this.#options.runtime.state !== "running")
			await this.#boundary(lock, async () => {
				await this.#options.runtime.start();
				this.#routerAvailable = true;
			});
		for (const item of journal.items) {
			if (item.state !== "active_generation_proven" || item.record === undefined)
				return blocked("A lifecycle item is not generation-proven.");
			const tenant = toTenant(item.intent, item.record.generation);
			await this.#assertFence(lock, tenant);
			await this.#boundary(lock, async () => {
				this.#options.runtime.registerTenant(tenant);
				await this.#options.runtime.reconcile();
			});
			await this.#assertFence(lock, tenant);
			const attachment = await this.#boundaryResult(lock, () => this.#options.runtime.acquireAttachment(tenant));
			if (attachment.generation !== tenant.generation || !attachment.isCurrent())
				return blocked("Durable generation record lacks current Router attachment proof.");
		}
		await this.#save(lock, { ...journal, phase: "active", canonicalReplaced: true, activeMarker: true });
		await this.#boundary(lock, () => this.#options.admission.open());
		return { phase: "active", ready: true, routerAvailable: true, epoch: MANAGED_SESSION_AUTHORITY_EPOCH };
	}
	#journal(
		phase: ManagedAuthorityActivationJournal["phase"],
		staged: readonly string[],
		items: readonly ManagedAuthorityActivationItemJournal[],
	): ManagedAuthorityActivationJournal {
		return {
			manifest: this.#options.manifest,
			phase,
			staged: [...staged],
			items: [...items],
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
	async #boundaryResult<T>(lock: ManagedAuthorityActivationLock, effect: () => Promise<T>): Promise<T> {
		await lock.assertHeld();
		const result = await effect();
		await lock.assertHeld();
		return result;
	}
	async #assertFence(lock: ManagedAuthorityActivationLock, key: TenantSessionKey): Promise<void> {
		await lock.assertHeld();
		if (!(await this.#options.tenantFence(key)))
			throw new Error("External tenant lease/epoch fence rejected lifecycle authority.");
		await lock.assertHeld();
	}
	async #assertPreparedIntentFence(
		lock: ManagedAuthorityActivationLock,
		intent: ManagedAuthorityPreparedRebindIntent,
	): Promise<void> {
		await lock.assertHeld();
		if (!(await this.#options.preparedIntentFence(intent)))
			throw new Error("Prepared lifecycle intent fence rejected immutable authority evidence.");
		await lock.assertHeld();
	}
	#failed(error: unknown): ManagedAuthorityActivationResult {
		return { phase: "failed", ready: false, routerAvailable: this.#routerAvailable, reason: message(error) };
	}
}

export function managedAuthorityManifestDigest(manifest: Omit<ManagedAuthorityActivationManifest, "digest">): string {
	return sha256(
		JSON.stringify({
			authorityEpoch: manifest.authorityEpoch,
			checkpoint: manifest.checkpoint,
			records: manifest.records,
		}),
	);
}
function assertManifest(manifest: ManagedAuthorityActivationManifest): void {
	if (
		manifest.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH ||
		!isHash(manifest.digest) ||
		manifest.digest !== managedAuthorityManifestDigest(manifest) ||
		manifest.checkpoint.authorityEpoch !== MANAGED_SESSION_AUTHORITY_EPOCH ||
		manifest.checkpoint.canonicalReplaced ||
		manifest.checkpoint.activeMarkerReady
	)
		throw new TypeError("A canonical inactive v3 authority manifest is required.");
}
function assertBindings(
	manifest: ManagedAuthorityActivationManifest,
	bindings: readonly ManagedAuthorityActivationBinding[],
): void {
	if (manifest.records.some(record => record.status === "migration_blocked" || record.status === "quarantined"))
		return;
	if (bindings.length !== manifest.records.filter(record => record.status === "intent_prepared").length)
		throw new TypeError("Every prepared manifest item requires one generation-free intent.");
	const keys = new Set<string>();
	for (const binding of bindings) {
		const intent = binding.intent;
		if (
			!intent ||
			![
				intent.principalId,
				intent.projectId,
				intent.canonicalWorkspace,
				intent.chatId,
				intent.sessionId,
				intent.actorDigest,
				intent.actorRef,
				intent.stableKey,
				intent.operationHash,
				intent.requestHash,
				intent.payloadHash,
				intent.leaseId,
				intent.epoch,
			].every(value => typeof value === "string" && value.length > 0) ||
			![intent.actorDigest, intent.operationHash, intent.requestHash, intent.payloadHash].every(isHash) ||
			!isTimestamp(intent.preparedAt) ||
			!isTimestamp(intent.observedAt) ||
			!Number.isSafeInteger(intent.rawFrameCursor) ||
			intent.rawFrameCursor < 0 ||
			!Number.isSafeInteger(intent.eventCursor) ||
			intent.eventCursor < 0 ||
			keys.has(intent.stableKey)
		)
			throw new TypeError("Invalid or duplicate generation-free prepared rebind intent.");
		keys.add(intent.stableKey);
	}
}
function assertJournal(journal: ManagedAuthorityActivationJournal): void {
	assertManifest(journal.manifest);
	if (
		!Array.isArray(journal.items) ||
		journal.staged.length > journal.items.length ||
		(journal.activeMarker && !journal.canonicalReplaced)
	)
		throw new Error("Activation journal is invalid.");
}
function assertSameManifest(left: ManagedAuthorityActivationManifest, right: ManagedAuthorityActivationManifest): void {
	if (left.digest !== right.digest)
		throw new Error("Activation manifest digest does not match durable activation state.");
}
function assertRecoveryItems(
	items: readonly ManagedAuthorityActivationItemJournal[],
	bindings: readonly ManagedAuthorityActivationBinding[],
): void {
	if (items.length !== bindings.length)
		throw new Error("Durable lifecycle journal does not match prepared activation input.");
	for (const item of items) {
		const current = bindings.find(binding => binding.intent.stableKey === item.intent.stableKey)?.intent;
		if (
			current === undefined ||
			current.principalId !== item.intent.principalId ||
			current.projectId !== item.intent.projectId ||
			current.canonicalWorkspace !== item.intent.canonicalWorkspace ||
			current.chatId !== item.intent.chatId ||
			current.sessionId !== item.intent.sessionId ||
			current.actorDigest !== item.intent.actorDigest ||
			current.actorRef !== item.intent.actorRef ||
			current.operationHash !== item.intent.operationHash ||
			current.requestHash !== item.intent.requestHash ||
			current.payloadHash !== item.intent.payloadHash ||
			current.leaseId !== item.intent.leaseId ||
			current.epoch !== item.intent.epoch ||
			current.preparedAt !== item.intent.preparedAt ||
			current.observedAt !== item.intent.observedAt ||
			current.rawFrameCursor !== item.intent.rawFrameCursor ||
			current.eventCursor !== item.intent.eventCursor ||
			current.activeLeaf !== item.intent.activeLeaf ||
			(item.record !== undefined && !recordMatchesIntent(item.record, item.intent))
		)
			throw new Error("Durable lifecycle journal actor, key, hash, or lease evidence changed.");
	}
}

function recordMatchesIntent(
	record: ManagedSessionAuthorityRecord,
	intent: ManagedAuthorityPreparedRebindIntent,
): boolean {
	return (
		record.principalId === intent.principalId &&
		record.projectId === intent.projectId &&
		record.canonicalWorkspace === intent.canonicalWorkspace &&
		record.chatId === intent.chatId &&
		record.sessionId === intent.sessionId &&
		record.operationHash === intent.operationHash &&
		record.requestHash === intent.requestHash &&
		record.payloadHash === intent.payloadHash &&
		record.session.sessionId === intent.sessionId &&
		record.session.observedAt === intent.observedAt &&
		record.projection.rawFrameCursor === intent.rawFrameCursor &&
		record.projection.eventCursor === intent.eventCursor &&
		record.projection.activeLeaf === intent.activeLeaf
	);
}
function replaceItem(
	journal: ManagedAuthorityActivationJournal,
	index: number,
	item: ManagedAuthorityActivationItemJournal,
): ManagedAuthorityActivationJournal {
	const items = [...journal.items];
	items[index] = item;
	return { ...journal, items };
}
function toTenant(intent: ManagedAuthorityPreparedRebindIntent, generation: number): TenantSessionKey {
	return {
		principalId: intent.principalId,
		projectId: intent.projectId,
		canonicalWorkspace: intent.canonicalWorkspace,
		chatId: intent.chatId,
		sessionId: intent.sessionId,
		generation,
		leaseId: intent.leaseId,
		epoch: intent.epoch,
	};
}
function toRecord(
	intent: ManagedAuthorityPreparedRebindIntent,
	outcome: Extract<ManagedAuthorityLifecycleOutcome, { ok: true }>,
): ManagedSessionAuthorityRecord {
	return {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		principalId: intent.principalId,
		projectId: intent.projectId,
		canonicalWorkspace: intent.canonicalWorkspace,
		chatId: intent.chatId,
		sessionId: intent.sessionId,
		generation: outcome.endpointGeneration,
		operationHash: intent.operationHash,
		requestHash: intent.requestHash,
		payloadHash: intent.payloadHash,
		operationId: intent.stableKey,
		session: { sessionId: intent.sessionId, observedAt: intent.observedAt },
		projection: {
			rawFrameCursor: intent.rawFrameCursor,
			eventCursor: intent.eventCursor,
			...(intent.activeLeaf === undefined ? {} : { activeLeaf: intent.activeLeaf }),
		},
		lifecycle: { state: "active_generation_proven", recordedAt: outcome.acknowledgedAt },
	};
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isPositiveGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function message(error: unknown): string {
	return error instanceof Error ? error.message : "Managed authority activation failed.";
}

function blocked(reason: string): ManagedAuthorityActivationResult {
	return { phase: "blocked", ready: false, routerAvailable: false, reason };
}
