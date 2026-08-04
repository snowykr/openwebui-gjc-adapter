import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DIRECTORY_MODE = 0o700;
const RECORD_MODE = 0o600;
const SAFE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CORRELATION_ID_LENGTH = 256;

export const WORKSPACE_LEASE_SCHEMA_VERSION = 1 as const;

export type WorkspaceLeaseOperation =
	| "turn"
	| "control"
	| "close"
	| "reaper"
	| "cold-resume"
	| "cleanup"
	| "migration"
	| (string & {});

export interface WorkspaceLeaseRecord {
	readonly schemaVersion: typeof WORKSPACE_LEASE_SCHEMA_VERSION;
	readonly generation: number;
	readonly holderId: string;
	readonly operation: WorkspaceLeaseOperation;
	readonly leaseExpiresAt: number;
	/** Highest wall-clock instant durably observed for this lease generation. */
	readonly observedAt: number;
	/** Boot identifier used to bind monotonic lease expiry when available. */
	readonly bootId: string;
	/** Monotonic uptime deadline in milliseconds for the associated boot, or zero when unavailable. */
	readonly monotonicExpiresAt: number;
	readonly cleanupPending: boolean;
}

export interface WorkspaceLeaseManagerOptions {
	readonly stateRoot: string;
	readonly now?: () => number;
	readonly monotonicNow?: () => number;
	readonly bootId?: () => string | undefined;
	/** Alias for callers that use clock terminology. `now` takes precedence. */
	readonly clock?: () => number;
}

export interface WorkspaceLeaseAcquireOptions {
	readonly safeKey: string;
	readonly holderId: string;
	readonly operation: WorkspaceLeaseOperation;
	readonly leaseMs?: number;
	readonly leaseDurationMs?: number;
}

export interface WorkspaceLeaseReference {
	readonly safeKey: string;
	readonly holderId: string;
	readonly generation: number;
	readonly operation: WorkspaceLeaseOperation;
}

export interface WorkspaceLeaseRenewOptions extends WorkspaceLeaseReference {
	readonly leaseMs?: number;
	readonly leaseDurationMs?: number;
}

export class WorkspaceLeaseManager {
	readonly stateRoot: string;
	readonly locksRoot: string;
	readonly workspaceLocksRoot: string;
	readonly #now: () => number;
	readonly #monotonicNow: () => number;
	readonly #bootId: string;
	#maxObservedNow = Number.NEGATIVE_INFINITY;

	constructor(options: WorkspaceLeaseManagerOptions) {
		assertStateRoot(options.stateRoot);
		this.stateRoot = path.resolve(options.stateRoot);
		this.locksRoot = path.join(this.stateRoot, "locks");
		this.workspaceLocksRoot = path.join(this.locksRoot, "workspaces");
		this.#now = options.now ?? options.clock ?? Date.now;
		this.#monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
		this.#bootId = resolveBootId(options.bootId ?? defaultBootId);
	}

	/** Returns the durable lock path without creating any workspace directories. */
	lockPath(safeKey: string): string {
		assertSafeKey(safeKey);
		return path.join(this.workspaceLocksRoot, `${safeKey}.lock`);
	}

	async acquire(options: WorkspaceLeaseAcquireOptions): Promise<WorkspaceLease>;
	async acquire(
		safeKey: string,
		holderId: string,
		operation: WorkspaceLeaseOperation,
		leaseMs: number,
	): Promise<WorkspaceLease>;
	async acquire(
		optionsOrSafeKey: WorkspaceLeaseAcquireOptions | string,
		holderId?: string,
		operation?: WorkspaceLeaseOperation,
		leaseMs?: number,
	): Promise<WorkspaceLease> {
		let options: WorkspaceLeaseAcquireOptions;
		if (typeof optionsOrSafeKey === "string") {
			if (holderId === undefined || operation === undefined || leaseMs === undefined) {
				throw new TypeError("Workspace lease acquisition requires safeKey, holderId, operation, and leaseMs");
			}
			options = { safeKey: optionsOrSafeKey, holderId, operation, leaseMs };
		} else {
			options = optionsOrSafeKey;
		}
		assertSafeKey(options.safeKey);
		assertHolderId(options.holderId);
		assertOperation(options.operation);
		const duration = assertLeaseDuration(options.leaseMs ?? options.leaseDurationMs);
		const lockPath = this.lockPath(options.safeKey);

		return withOperationLock(lockPath, async () => {
			await ensureLayout(this.stateRoot, this.locksRoot, this.workspaceLocksRoot);
			let current = await readRecord(lockPath);
			const clock = this.readClock(current?.observedAt);
			current = await observeRecord(lockPath, current, clock.wallNow, this.workspaceLocksRoot);
			if (current?.cleanupPending && options.operation !== "cleanup") {
				throw new Error(
					`Workspace lease admission is denied while cleanup is pending for safe key ${options.safeKey}`,
				);
			}
			if (current !== undefined && isActive(current, clock)) {
				throw new Error(`Workspace lease is already held for safe key ${options.safeKey}`);
			}
			const generation = current === undefined ? 1 : nextGeneration(current.generation);
			const record: WorkspaceLeaseRecord = {
				schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
				generation,
				holderId: options.holderId,
				operation: options.operation,
				leaseExpiresAt: addLeaseDuration(clock.wallNow, duration),
				monotonicExpiresAt: clock.bootId.length === 0 ? 0 : addLeaseDuration(clock.monotonicNow, duration),
				observedAt: clock.wallNow,
				bootId: clock.bootId,
				cleanupPending: current?.cleanupPending ?? false,
			};
			await writeRecord(lockPath, record, this.workspaceLocksRoot);
			return this.makeLease(options.safeKey, record);
		});
	}

	async renew(lease: WorkspaceLease, leaseMs: number): Promise<WorkspaceLease>;
	async renew(options: WorkspaceLeaseRenewOptions): Promise<WorkspaceLease>;
	async renew(
		safeKey: string,
		holderId: string,
		generation: number,
		operation: WorkspaceLeaseOperation,
		leaseMs: number,
	): Promise<WorkspaceLease>;
	async renew(
		leaseOrOptionsOrSafeKey: WorkspaceLease | WorkspaceLeaseRenewOptions | string,
		holderIdOrLeaseMs?: string | number,
		generation?: number,
		operation?: WorkspaceLeaseOperation,
		leaseMs?: number,
	): Promise<WorkspaceLease> {
		const normalized = normalizeRenewInput(
			leaseOrOptionsOrSafeKey,
			holderIdOrLeaseMs,
			generation,
			operation,
			leaseMs,
		);
		const duration = assertLeaseDuration(normalized.leaseMs);
		const lockPath = this.lockPath(normalized.reference.safeKey);

		return withOperationLock(lockPath, async () => {
			await ensureLayout(this.stateRoot, this.locksRoot, this.workspaceLocksRoot);
			let current = await readRecord(lockPath);
			const clock = this.readClock(current?.observedAt);
			current = await observeRecord(lockPath, current, clock.wallNow, this.workspaceLocksRoot);
			assertCurrentFence(current, normalized.reference, clock, "renew");
			const renewed: WorkspaceLeaseRecord = {
				...current,
				leaseExpiresAt: addLeaseDuration(clock.wallNow, duration),
				observedAt: clock.wallNow,
				monotonicExpiresAt: clock.bootId.length === 0 ? 0 : addLeaseDuration(clock.monotonicNow, duration),
				bootId: clock.bootId,
			};
			await writeRecord(lockPath, renewed, this.workspaceLocksRoot);
			if (normalized.handle !== undefined) normalized.handle.updateFromManager(renewed);
			return normalized.handle ?? this.makeLease(normalized.reference.safeKey, renewed);
		});
	}

	async assertFence(lease: WorkspaceLease | WorkspaceLeaseReference): Promise<WorkspaceLeaseRecord>;
	async assertFence(
		safeKey: string,
		holderId: string,
		generation: number,
		operation: WorkspaceLeaseOperation,
	): Promise<WorkspaceLeaseRecord>;
	async assertFence(
		leaseOrSafeKey: WorkspaceLease | WorkspaceLeaseReference | string,
		holderId?: string,
		generation?: number,
		operation?: WorkspaceLeaseOperation,
	): Promise<WorkspaceLeaseRecord> {
		const reference = normalizeReferenceInput(leaseOrSafeKey, holderId, generation, operation);
		const lockPath = this.lockPath(reference.safeKey);
		return withOperationLock(lockPath, async () => {
			await ensureLayout(this.stateRoot, this.locksRoot, this.workspaceLocksRoot);
			let current = await readRecord(lockPath);
			const clock = this.readClock(current?.observedAt);
			current = await observeRecord(lockPath, current, clock.wallNow, this.workspaceLocksRoot);
			assertCurrentFence(current, reference, clock, "assert fence");
			if (leaseOrSafeKey instanceof WorkspaceLease) leaseOrSafeKey.updateFromManager(current);
			return { ...current };
		});
	}

	async release(lease: WorkspaceLease | WorkspaceLeaseReference): Promise<void>;
	async release(
		safeKey: string,
		holderId: string,
		generation: number,
		operation: WorkspaceLeaseOperation,
	): Promise<void>;
	async release(
		leaseOrSafeKey: WorkspaceLease | WorkspaceLeaseReference | string,
		holderId?: string,
		generation?: number,
		operation?: WorkspaceLeaseOperation,
	): Promise<void> {
		if (leaseOrSafeKey instanceof WorkspaceLease && leaseOrSafeKey.released) return;
		const reference = normalizeReferenceInput(leaseOrSafeKey, holderId, generation, operation);
		const lockPath = this.lockPath(reference.safeKey);
		await withOperationLock(lockPath, async () => {
			await ensureLayout(this.stateRoot, this.locksRoot, this.workspaceLocksRoot);
			let current = await readRecord(lockPath);
			const clock = this.readClock(current?.observedAt);
			current = await observeRecord(lockPath, current, clock.wallNow, this.workspaceLocksRoot);
			assertCurrentFence(current, reference, clock, "release");
			const released: WorkspaceLeaseRecord = {
				...current,
				leaseExpiresAt: 0,
				observedAt: clock.wallNow,
				monotonicExpiresAt: 0,
			};
			await writeRecord(lockPath, released, this.workspaceLocksRoot);
			if (leaseOrSafeKey instanceof WorkspaceLease) leaseOrSafeKey.markReleasedFromManager(released);
		});
	}

	async setCleanupPending(lease: WorkspaceLease | WorkspaceLeaseReference): Promise<WorkspaceLease>;
	async setCleanupPending(
		safeKey: string,
		holderId: string,
		generation: number,
		operation: WorkspaceLeaseOperation,
	): Promise<WorkspaceLease>;
	async setCleanupPending(
		leaseOrSafeKey: WorkspaceLease | WorkspaceLeaseReference | string,
		holderId?: string,
		generation?: number,
		operation?: WorkspaceLeaseOperation,
	): Promise<WorkspaceLease> {
		return this.updateCleanupPending(leaseOrSafeKey, holderId, generation, operation, true);
	}

	async clearCleanupPending(lease: WorkspaceLease | WorkspaceLeaseReference): Promise<WorkspaceLease>;
	async clearCleanupPending(
		safeKey: string,
		holderId: string,
		generation: number,
		operation: WorkspaceLeaseOperation,
	): Promise<WorkspaceLease>;
	async clearCleanupPending(
		leaseOrSafeKey: WorkspaceLease | WorkspaceLeaseReference | string,
		holderId?: string,
		generation?: number,
		operation?: WorkspaceLeaseOperation,
	): Promise<WorkspaceLease> {
		return this.updateCleanupPending(leaseOrSafeKey, holderId, generation, operation, false);
	}
	/**
	 * Completes a cleanup while retaining the generation fence: cleanup-pending is
	 * cleared and the lease is expired in one durable record update.
	 */
	async completeCleanup(lease: WorkspaceLease | WorkspaceLeaseReference): Promise<void> {
		if (lease instanceof WorkspaceLease && lease.released) {
			throw new Error("Cannot complete cleanup after releasing a workspace lease");
		}
		const reference = normalizeReferenceInput(lease, undefined, undefined, undefined);
		const lockPath = this.lockPath(reference.safeKey);
		await withOperationLock(lockPath, async () => {
			await ensureLayout(this.stateRoot, this.locksRoot, this.workspaceLocksRoot);
			let current = await readRecord(lockPath);
			const clock = this.readClock(current?.observedAt);
			current = await observeRecord(lockPath, current, clock.wallNow, this.workspaceLocksRoot);
			assertCurrentFence(current, reference, clock, "complete cleanup");
			const completed: WorkspaceLeaseRecord = {
				...current,
				leaseExpiresAt: 0,
				observedAt: clock.wallNow,
				monotonicExpiresAt: 0,
				cleanupPending: false,
			};
			await writeRecord(lockPath, completed, this.workspaceLocksRoot);
			if (lease instanceof WorkspaceLease) lease.markReleasedFromManager(completed);
		});
	}

	private async updateCleanupPending(
		leaseOrSafeKey: WorkspaceLease | WorkspaceLeaseReference | string,
		holderId: string | undefined,
		generation: number | undefined,
		operation: WorkspaceLeaseOperation | undefined,
		cleanupPending: boolean,
	): Promise<WorkspaceLease> {
		if (leaseOrSafeKey instanceof WorkspaceLease && leaseOrSafeKey.released) {
			throw new Error("Cannot update cleanup-pending state after releasing a workspace lease");
		}
		const reference = normalizeReferenceInput(leaseOrSafeKey, holderId, generation, operation);
		const lockPath = this.lockPath(reference.safeKey);
		return withOperationLock(lockPath, async () => {
			await ensureLayout(this.stateRoot, this.locksRoot, this.workspaceLocksRoot);
			let current = await readRecord(lockPath);
			const clock = this.readClock(current?.observedAt);
			current = await observeRecord(lockPath, current, clock.wallNow, this.workspaceLocksRoot);
			assertCurrentFence(
				current,
				reference,
				clock,
				cleanupPending ? "set cleanup-pending" : "clear cleanup-pending",
			);
			if (current.cleanupPending === cleanupPending) {
				return leaseOrSafeKey instanceof WorkspaceLease
					? leaseOrSafeKey
					: this.makeLease(reference.safeKey, current);
			}
			const updated: WorkspaceLeaseRecord = { ...current, observedAt: clock.wallNow, cleanupPending };
			await writeRecord(lockPath, updated, this.workspaceLocksRoot);
			if (leaseOrSafeKey instanceof WorkspaceLease) {
				leaseOrSafeKey.updateFromManager(updated);
				return leaseOrSafeKey;
			}
			return this.makeLease(reference.safeKey, updated);
		});
	}

	private makeLease(safeKey: string, record: WorkspaceLeaseRecord): WorkspaceLease {
		return WorkspaceLease.create(this, safeKey, record);
	}

	private readClock(observedAt = 0): WorkspaceLeaseClock {
		const wallValue = this.#now();
		const monotonicNow = this.#monotonicNow();
		if (!Number.isFinite(wallValue) || !Number.isFinite(monotonicNow) || monotonicNow < 0) {
			throw new Error("Workspace lease clocks must return finite non-negative values");
		}
		if (!Number.isFinite(observedAt) || observedAt < 0) {
			throw new Error("Workspace lease record has an invalid observed clock value");
		}
		this.#maxObservedNow = Math.max(this.#maxObservedNow, wallValue, observedAt);
		return { wallNow: this.#maxObservedNow, monotonicNow, bootId: this.#bootId };
	}
}

export class WorkspaceLease {
	readonly #manager: WorkspaceLeaseManager;
	readonly #safeKey: string;
	#record: WorkspaceLeaseRecord;
	#released = false;

	private constructor(manager: WorkspaceLeaseManager, safeKey: string, record: WorkspaceLeaseRecord) {
		this.#manager = manager;
		this.#safeKey = safeKey;
		this.#record = { ...record };
	}

	static create(manager: WorkspaceLeaseManager, safeKey: string, record: WorkspaceLeaseRecord): WorkspaceLease {
		return new WorkspaceLease(manager, safeKey, record);
	}

	get safeKey(): string {
		return this.#safeKey;
	}

	get schemaVersion(): typeof WORKSPACE_LEASE_SCHEMA_VERSION {
		return this.#record.schemaVersion;
	}

	get generation(): number {
		return this.#record.generation;
	}

	get holderId(): string {
		return this.#record.holderId;
	}

	get holderCorrelationId(): string {
		return this.#record.holderId;
	}

	get operation(): WorkspaceLeaseOperation {
		return this.#record.operation;
	}

	get leaseExpiresAt(): number {
		return this.#record.leaseExpiresAt;
	}

	get expiresAt(): number {
		return this.#record.leaseExpiresAt;
	}

	get cleanupPending(): boolean {
		return this.#record.cleanupPending;
	}

	get released(): boolean {
		return this.#released;
	}

	get record(): WorkspaceLeaseRecord {
		return { ...this.#record };
	}

	get lockPath(): string {
		return this.#manager.lockPath(this.#safeKey);
	}

	toRecord(): WorkspaceLeaseRecord {
		return this.record;
	}

	async renew(leaseMs: number): Promise<WorkspaceLease> {
		if (this.#released) throw new Error("Cannot renew a released workspace lease");
		return this.#manager.renew(this, leaseMs);
	}

	async assertFence(): Promise<WorkspaceLeaseRecord> {
		if (this.#released) throw new Error("Workspace lease has been released");
		return this.#manager.assertFence(this);
	}

	async release(): Promise<void> {
		if (this.#released) return;
		await this.#manager.release(this);
	}

	async setCleanupPending(): Promise<WorkspaceLease> {
		if (this.#released) throw new Error("Cannot update cleanup-pending state after releasing a workspace lease");
		return this.#manager.setCleanupPending(this);
	}

	async clearCleanupPending(): Promise<WorkspaceLease> {
		if (this.#released) throw new Error("Cannot update cleanup-pending state after releasing a workspace lease");
		return this.#manager.clearCleanupPending(this);
	}
	async completeCleanup(): Promise<void> {
		if (this.#released) throw new Error("Cannot complete cleanup after releasing a workspace lease");
		await this.#manager.completeCleanup(this);
	}

	/** @internal */
	updateFromManager(record: WorkspaceLeaseRecord): void {
		this.#record = { ...record };
	}

	/** @internal */
	markReleasedFromManager(record: WorkspaceLeaseRecord): void {
		this.#record = { ...record };
		this.#released = true;
	}
}

export function createWorkspaceLeaseManager(options: WorkspaceLeaseManagerOptions): WorkspaceLeaseManager {
	return new WorkspaceLeaseManager(options);
}

interface WorkspaceLeaseClock {
	readonly wallNow: number;
	readonly monotonicNow: number;
	readonly bootId: string;
}

interface NormalizedRenewInput {
	readonly reference: WorkspaceLeaseReference;
	readonly leaseMs: number | undefined;
	readonly handle?: WorkspaceLease;
}

function normalizeRenewInput(
	leaseOrOptionsOrSafeKey: WorkspaceLease | WorkspaceLeaseRenewOptions | string,
	holderIdOrLeaseMs: string | number | undefined,
	generation: number | undefined,
	operation: WorkspaceLeaseOperation | undefined,
	leaseMs: number | undefined,
): NormalizedRenewInput {
	if (leaseOrOptionsOrSafeKey instanceof WorkspaceLease) {
		if (typeof holderIdOrLeaseMs !== "number")
			throw new TypeError("Workspace lease renewal duration must be explicit");
		return {
			reference: leaseReference(leaseOrOptionsOrSafeKey),
			leaseMs: holderIdOrLeaseMs,
			handle: leaseOrOptionsOrSafeKey,
		};
	}
	if (typeof leaseOrOptionsOrSafeKey === "string") {
		if (
			typeof holderIdOrLeaseMs !== "string" ||
			generation === undefined ||
			operation === undefined ||
			leaseMs === undefined
		) {
			throw new TypeError("Workspace lease renewal requires safeKey, holderId, generation, operation, and leaseMs");
		}
		return {
			reference: { safeKey: leaseOrOptionsOrSafeKey, holderId: holderIdOrLeaseMs, generation, operation },
			leaseMs,
		};
	}
	return {
		reference: leaseReference(leaseOrOptionsOrSafeKey),
		leaseMs: leaseOrOptionsOrSafeKey.leaseMs ?? leaseOrOptionsOrSafeKey.leaseDurationMs,
	};
}

function normalizeReferenceInput(
	leaseOrSafeKey: WorkspaceLease | WorkspaceLeaseReference | string,
	holderId: string | undefined,
	generation: number | undefined,
	operation: WorkspaceLeaseOperation | undefined,
): WorkspaceLeaseReference {
	if (leaseOrSafeKey instanceof WorkspaceLease) return leaseReference(leaseOrSafeKey);
	if (typeof leaseOrSafeKey === "string") {
		if (holderId === undefined || generation === undefined || operation === undefined) {
			throw new TypeError("Workspace lease fencing requires safeKey, holderId, generation, and operation");
		}
		return { safeKey: leaseOrSafeKey, holderId, generation, operation };
	}
	return leaseReference(leaseOrSafeKey);
}

function leaseReference(lease: WorkspaceLease | WorkspaceLeaseReference): WorkspaceLeaseReference {
	const reference = {
		safeKey: lease.safeKey,
		holderId: lease.holderId,
		generation: lease.generation,
		operation: lease.operation,
	};
	assertSafeKey(reference.safeKey);
	assertHolderId(reference.holderId);
	assertGeneration(reference.generation);
	assertOperation(reference.operation);
	return reference;
}

function assertCurrentFence(
	current: WorkspaceLeaseRecord | undefined,
	reference: WorkspaceLeaseReference,
	clock: WorkspaceLeaseClock,
	action: string,
): asserts current is WorkspaceLeaseRecord {
	assertSafeKey(reference.safeKey);
	assertHolderId(reference.holderId);
	assertGeneration(reference.generation);
	assertOperation(reference.operation);
	if (current === undefined)
		throw new Error(`Workspace lease fence failed during ${action}: no durable record exists`);
	if (
		current.generation !== reference.generation ||
		current.holderId !== reference.holderId ||
		current.operation !== reference.operation
	) {
		throw new Error(`Workspace lease fence failed during ${action}: holder generation is stale`);
	}
	if (!isActive(current, clock)) {
		throw new Error(`Workspace lease fence failed during ${action}: lease has expired`);
	}
}

function isActive(record: WorkspaceLeaseRecord, clock: WorkspaceLeaseClock): boolean {
	if (clock.bootId.length === 0) return record.leaseExpiresAt > clock.wallNow;
	return record.bootId === clock.bootId && record.monotonicExpiresAt > clock.monotonicNow;
}

function nextGeneration(current: number): number {
	if (current >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace lease generation exhausted");
	return current + 1;
}

function addLeaseDuration(now: number, leaseMs: number): number {
	const expiration = now + leaseMs;
	if (!Number.isSafeInteger(expiration) || expiration <= now)
		throw new RangeError("Workspace lease expiration is outside the safe integer range");
	return expiration;
}

function assertSafeKey(safeKey: string): void {
	if (typeof safeKey !== "string" || !SAFE_KEY_PATTERN.test(safeKey)) {
		throw new TypeError("Workspace lease safeKey must be a lowercase 64-hex string");
	}
}

function assertHolderId(holderId: string): void {
	if (
		typeof holderId !== "string" ||
		holderId.length === 0 ||
		holderId.length > MAX_CORRELATION_ID_LENGTH ||
		/[\u0000-\u001f\u007f]/u.test(holderId)
	) {
		throw new TypeError("Workspace lease holderId must be a non-empty printable correlation ID");
	}
}

function assertOperation(operation: WorkspaceLeaseOperation): void {
	if (typeof operation !== "string" || !OPERATION_PATTERN.test(operation)) {
		throw new TypeError("Workspace lease operation must be a lowercase operation kind");
	}
}

function assertLeaseDuration(leaseMs: number | undefined): number {
	if (typeof leaseMs !== "number" || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
		throw new TypeError("Workspace lease duration must be a positive safe integer in milliseconds");
	}
	return leaseMs;
}

function assertGeneration(generation: number): void {
	if (!Number.isSafeInteger(generation) || generation < 1)
		throw new TypeError("Workspace lease generation must be a positive safe integer");
}

function assertStateRoot(stateRoot: string): void {
	if (typeof stateRoot !== "string" || stateRoot.trim().length === 0)
		throw new TypeError("Workspace lease stateRoot must be a non-empty path");
}

interface ExternalOperationLockOwner {
	readonly pid: number;
	readonly startTicks: string;
}

interface ExternalOperationLockSnapshot {
	readonly owner: ExternalOperationLockOwner;
	readonly device: number;
	readonly inode: number;
}

const operationLocks = new Map<string, Promise<void>>();
async function withOperationLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
	const previous = operationLocks.get(lockPath) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => {
		release = resolve;
	});
	operationLocks.set(lockPath, current);
	await previous;
	let releaseExternal: (() => Promise<void>) | undefined;
	try {
		await ensurePrivateDirectory(path.dirname(lockPath), "workspace lock directory");
		releaseExternal = await acquireExternalOperationLock(lockPath);
		return await operation();
	} finally {
		try {
			await releaseExternal?.();
		} finally {
			release();
			if (operationLocks.get(lockPath) === current) operationLocks.delete(lockPath);
		}
	}
}

const EXTERNAL_OPERATION_LOCK_ATTEMPTS = 200;
const EXTERNAL_OPERATION_LOCK_DELAY_MS = 10;

async function acquireExternalOperationLock(lockPath: string): Promise<() => Promise<void>> {
	const guardPath = `${lockPath}.guard`;
	const owner = await currentExternalOperationLockOwner();
	for (let attempt = 0; attempt < EXTERNAL_OPERATION_LOCK_ATTEMPTS; attempt += 1) {
		let freshSnapshot: ExternalOperationLockSnapshot | undefined;
		try {
			const snapshot = await writeExternalOperationLockFile(guardPath, owner);
			freshSnapshot = snapshot;
			await syncDirectory(path.dirname(guardPath));
			const markerPath = externalOperationLockRecoveryMarkerPath(guardPath);
			const marker = await readExternalOperationLockSnapshot(markerPath);
			if (marker !== undefined) {
				if (await isExternalOperationLockOwnerLive(marker.owner)) {
					await removeExternalOperationLock(guardPath, snapshot);
					freshSnapshot = undefined;
					await delayExternalOperationLock();
					continue;
				}
				await removeStaleExternalOperationLockMarker(markerPath, marker);
			}
			return async () => {
				await removeExternalOperationLock(guardPath, snapshot);
			};
		} catch (error) {
			if (freshSnapshot !== undefined) {
				await removeExternalOperationLock(guardPath, freshSnapshot);
				throw error;
			}
			if (!isNodeFsError(error, "EEXIST")) throw error;
			const snapshot = await readExternalOperationLockSnapshot(guardPath);
			if (snapshot === undefined) continue;
			if (await isExternalOperationLockOwnerLive(snapshot.owner)) {
				await delayExternalOperationLock();
				continue;
			}
			const reclaimed = await reclaimExternalOperationLock(guardPath, snapshot, owner);
			if (reclaimed !== undefined) return reclaimed;
		}
	}
	throw new Error(`Workspace lease operation lock is unavailable: ${lockPath}`);
}

async function unlinkIfPresent(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath);
	} catch (error) {
		if (!isNodeFsError(error, "ENOENT")) throw error;
	}
}
async function writeExternalOperationLockFile(
	filePath: string,
	owner: ExternalOperationLockOwner,
): Promise<ExternalOperationLockSnapshot> {
	let handle: fs.FileHandle | undefined;
	let created = false;
	let retained = false;
	try {
		handle = await fs.open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, RECORD_MODE);
		created = true;
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
		await handle.chmod(RECORD_MODE);
		await handle.sync();
		const status = await handle.stat();
		assertPrivateGuardStat(status, filePath);
		retained = true;
		return { owner, device: status.dev, inode: status.ino };
	} finally {
		await handle?.close();
		if (created && !retained) await unlinkIfPresent(filePath);
	}
}

async function currentExternalOperationLockOwner(): Promise<ExternalOperationLockOwner> {
	return {
		pid: process.pid,
		startTicks: await externalOperationLockStartTicks(process.pid),
	};
}

async function isExternalOperationLockOwnerLive(owner: ExternalOperationLockOwner): Promise<boolean> {
	try {
		return (await externalOperationLockStartTicks(owner.pid)) === owner.startTicks;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		throw new Error("Unable to establish operation lock owner liveness", { cause: error });
	}
}

async function externalOperationLockStartTicks(pid: number): Promise<string> {
	if (process.platform !== "linux") {
		throw new Error("Workspace operation lock process identity is unavailable on this platform");
	}
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid workspace operation lock owner PID");
	let stat: string;
	try {
		stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		if (isMissingProcessError(error)) throw error;
		throw new Error(`Unable to read process start identity for PID ${pid}`, { cause: error });
	}
	const closing = stat.lastIndexOf(")");
	const fields =
		closing < 0
			? []
			: stat
					.slice(closing + 2)
					.trim()
					.split(/\s+/);
	const value = fields[19];
	if (value === undefined || !/^\d+$/.test(value)) {
		throw new Error(`Unable to validate process start identity for PID ${pid}`);
	}
	return value;
}

async function readExternalOperationLockSnapshot(
	guardPath: string,
): Promise<ExternalOperationLockSnapshot | undefined> {
	let linkStatus: Stats;
	try {
		linkStatus = await fs.lstat(guardPath);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	assertPrivateGuardStat(linkStatus, guardPath);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(guardPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const status = await handle.stat();
		assertPrivateGuardStat(status, guardPath);
		if (status.dev !== linkStatus.dev || status.ino !== linkStatus.ino) {
			throw new Error(`Workspace operation lock changed while being inspected: ${guardPath}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
		} catch (error) {
			throw new Error(`Workspace operation lock metadata is not valid JSON: ${guardPath}`, { cause: error });
		}
		return {
			owner: parseExternalOperationLockOwner(parsed, guardPath),
			device: status.dev,
			inode: status.ino,
		};
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

function parseExternalOperationLockOwner(value: unknown, guardPath: string): ExternalOperationLockOwner {
	if (!isRecord(value)) throw new Error(`Workspace operation lock metadata is invalid: ${guardPath}`);
	const pid = value.pid;
	const startTicks = value.startTicks;
	if (
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid < 1 ||
		typeof startTicks !== "string" ||
		!/^\d+$/.test(startTicks)
	) {
		throw new Error(`Workspace operation lock metadata is invalid: ${guardPath}`);
	}
	return { pid, startTicks };
}

function assertPrivateGuardStat(stats: Stats, guardPath: string): void {
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Workspace operation lock must be a regular file: ${guardPath}`);
	}
	if ((stats.mode & 0o777) !== RECORD_MODE) {
		throw new Error(`Workspace operation lock must be private: ${guardPath}`);
	}
	const getuid = process.getuid;
	if (typeof getuid === "function" && stats.uid !== getuid()) {
		throw new Error(`Workspace operation lock has foreign ownership: ${guardPath}`);
	}
}

function externalOperationLockRecoveryMarkerPath(guardPath: string): string {
	return `${guardPath}.reclaim`;
}

async function reclaimExternalOperationLock(
	guardPath: string,
	snapshot: ExternalOperationLockSnapshot,
	owner: ExternalOperationLockOwner,
): Promise<(() => Promise<void>) | undefined> {
	const markerPath = externalOperationLockRecoveryMarkerPath(guardPath);
	const marker = await acquireExternalOperationLockRecoveryMarker(markerPath, owner);
	if (marker === undefined) return undefined;
	let replacementPath: string | undefined;
	let replaced = false;
	try {
		const current = await readExternalOperationLockSnapshot(guardPath);
		if (
			current === undefined ||
			current.device !== snapshot.device ||
			current.inode !== snapshot.inode ||
			!sameExternalOperationLockOwner(current.owner, snapshot.owner)
		) {
			await removeExternalOperationLock(markerPath, marker);
			return undefined;
		}
		if (await isExternalOperationLockOwnerLive(current.owner)) {
			await removeExternalOperationLock(markerPath, marker);
			return undefined;
		}
		replacementPath = `${guardPath}.replacement-${process.pid}-${randomUUID()}`;
		const replacement = await writeExternalOperationLockFile(replacementPath, owner);
		await fs.rename(replacementPath, guardPath);
		replaced = true;
		await syncDirectory(path.dirname(guardPath));
		const claimed = await readExternalOperationLockSnapshot(guardPath);
		if (
			claimed === undefined ||
			claimed.device !== replacement.device ||
			claimed.inode !== replacement.inode ||
			!sameExternalOperationLockOwner(claimed.owner, owner)
		) {
			throw new Error(`Workspace operation lock changed during recovery: ${guardPath}`);
		}
		await removeExternalOperationLock(markerPath, marker);
		return async () => {
			await removeExternalOperationLock(guardPath, claimed);
		};
	} catch (error) {
		if (replacementPath !== undefined && !replaced) {
			try {
				await fs.unlink(replacementPath);
			} catch (cleanupError) {
				if (!isNodeFsError(cleanupError, "ENOENT")) throw cleanupError;
			}
		}
		await removeExternalOperationLock(markerPath, marker);
		throw error;
	}
}

async function acquireExternalOperationLockRecoveryMarker(
	markerPath: string,
	owner: ExternalOperationLockOwner,
): Promise<ExternalOperationLockSnapshot | undefined> {
	const candidatePath = `${markerPath}.candidate-${process.pid}-${randomUUID()}`;
	let candidateCreated = false;
	try {
		await writeExternalOperationLockFile(candidatePath, owner);
		candidateCreated = true;
		try {
			await fs.link(candidatePath, markerPath);
		} catch (error) {
			if (!isNodeFsError(error, "EEXIST")) throw error;
			const current = await readExternalOperationLockSnapshot(markerPath);
			if (current === undefined) return undefined;
			if (await isExternalOperationLockOwnerLive(current.owner)) {
				await delayExternalOperationLock();
				return undefined;
			}
			await removeStaleExternalOperationLockMarker(markerPath, current);
			return undefined;
		}
		await syncDirectory(path.dirname(markerPath));
		const marker = await readExternalOperationLockSnapshot(markerPath);
		if (marker === undefined || !sameExternalOperationLockOwner(marker.owner, owner)) {
			throw new Error(`Workspace operation lock recovery marker changed: ${markerPath}`);
		}
		return marker;
	} finally {
		if (candidateCreated) await unlinkIfPresent(candidatePath);
	}
}

async function removeStaleExternalOperationLockMarker(
	markerPath: string,
	snapshot: ExternalOperationLockSnapshot,
): Promise<void> {
	const quarantinePath = `${markerPath}.stale-${process.pid}-${randomUUID()}`;
	try {
		await fs.rename(markerPath, quarantinePath);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return;
		throw new Error(`Workspace operation lock recovery marker could not be claimed: ${markerPath}`, { cause: error });
	}
	try {
		const claimed = await readExternalOperationLockSnapshot(quarantinePath);
		if (
			claimed === undefined ||
			claimed.device !== snapshot.device ||
			claimed.inode !== snapshot.inode ||
			!sameExternalOperationLockOwner(claimed.owner, snapshot.owner)
		) {
			await restoreExternalOperationLockClaim(quarantinePath, markerPath);
			return;
		}
		if (await isExternalOperationLockOwnerLive(claimed.owner)) {
			await restoreExternalOperationLockClaim(quarantinePath, markerPath);
			return;
		}
		const replacement = await readExternalOperationLockSnapshot(markerPath);
		if (replacement !== undefined) {
			await fs.unlink(quarantinePath);
			return;
		}
		await fs.unlink(quarantinePath);
		await syncDirectory(path.dirname(markerPath));
	} catch (error) {
		await restoreExternalOperationLockClaim(quarantinePath, markerPath);
		throw error;
	}
}

async function removeExternalOperationLock(guardPath: string, snapshot: ExternalOperationLockSnapshot): Promise<void> {
	const current = await readExternalOperationLockSnapshot(guardPath);
	if (current === undefined) return;
	if (
		current.device !== snapshot.device ||
		current.inode !== snapshot.inode ||
		!sameExternalOperationLockOwner(current.owner, snapshot.owner)
	) {
		throw new Error(`Workspace operation lock ownership changed before release: ${guardPath}`);
	}
	const releasePath = `${guardPath}.release-${process.pid}-${randomUUID()}`;
	try {
		await fs.rename(guardPath, releasePath);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return;
		throw new Error(`Workspace operation lock could not be claimed for release: ${guardPath}`, { cause: error });
	}
	try {
		const claimed = await readExternalOperationLockSnapshot(releasePath);
		if (
			claimed === undefined ||
			claimed.device !== snapshot.device ||
			claimed.inode !== snapshot.inode ||
			!sameExternalOperationLockOwner(claimed.owner, snapshot.owner)
		) {
			await restoreExternalOperationLockClaim(releasePath, guardPath);
			throw new Error(`Workspace operation lock changed before release: ${guardPath}`);
		}
		await fs.unlink(releasePath);
		await syncDirectory(path.dirname(guardPath));
	} catch (error) {
		await restoreExternalOperationLockClaim(releasePath, guardPath);
		throw error;
	}
}

async function restoreExternalOperationLockClaim(claimPath: string, guardPath: string): Promise<void> {
	try {
		await fs.link(claimPath, guardPath);
	} catch (error) {
		if (isNodeFsError(error, "EEXIST") || isNodeFsError(error, "ENOENT")) return;
		throw error;
	}
	try {
		await fs.unlink(claimPath);
	} catch (error) {
		if (!isNodeFsError(error, "ENOENT")) throw error;
	}
}

function sameExternalOperationLockOwner(left: ExternalOperationLockOwner, right: ExternalOperationLockOwner): boolean {
	return left.pid === right.pid && left.startTicks === right.startTicks;
}

function isMissingProcessError(error: unknown): boolean {
	return isNodeFsError(error, "ENOENT") || isNodeFsError(error, "ESRCH");
}

async function delayExternalOperationLock(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, EXTERNAL_OPERATION_LOCK_DELAY_MS));
}

async function ensureLayout(stateRoot: string, locksRoot: string, workspaceLocksRoot: string): Promise<void> {
	await ensurePrivateDirectory(stateRoot, "adapter state root");
	await ensurePrivateDirectory(locksRoot, "workspace lock root");
	await ensurePrivateDirectory(workspaceLocksRoot, "workspace lock directory");
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
	const absolute = path.resolve(directory);
	const missing: string[] = [];
	let candidate = absolute;
	while (true) {
		try {
			const stats = await fs.lstat(candidate);
			assertPrivateDirectoryStat(stats, candidate, label);
			break;
		} catch (error) {
			if (!isNodeFsError(error, "ENOENT")) throw error;
			const parent = path.dirname(candidate);
			if (parent === candidate) throw new Error(`No existing parent found for ${label}: ${directory}`);
			missing.push(path.basename(candidate));
			candidate = parent;
		}
	}

	for (const segment of missing.reverse()) {
		candidate = path.join(candidate, segment);
		try {
			await fs.mkdir(candidate, { mode: DIRECTORY_MODE });
		} catch (error) {
			if (!isNodeFsError(error, "EEXIST")) throw error;
		}
		const stats = await fs.lstat(candidate);
		assertPrivateDirectoryStat(stats, candidate, label);
		await fs.chmod(candidate, DIRECTORY_MODE);
	}

	const finalStats = await fs.lstat(absolute);
	assertPrivateDirectoryStat(finalStats, absolute, label);
	await fs.chmod(absolute, DIRECTORY_MODE);
}

function assertPrivateDirectoryStat(stats: Stats, directory: string, label: string): void {
	if (stats.isSymbolicLink() || !stats.isDirectory())
		throw new Error(`Workspace ${label} must be a private directory: ${directory}`);
}

async function readRecord(lockPath: string): Promise<WorkspaceLeaseRecord | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		const stats = await handle.stat();
		if (stats.isSymbolicLink() || !stats.isFile())
			throw new Error(`Workspace lease record must be a regular file: ${lockPath}`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
		} catch (error) {
			throw new Error(`Workspace lease record is not valid JSON: ${lockPath}`, { cause: error });
		}
		const record = parseRecord(parsed, lockPath);
		await handle.chmod(RECORD_MODE);
		return record;
	} finally {
		await handle.close();
	}
}

function parseRecord(value: unknown, lockPath: string): WorkspaceLeaseRecord {
	if (!isRecord(value)) throw new Error(`Workspace lease record must be a JSON object: ${lockPath}`);
	if (value.schemaVersion !== WORKSPACE_LEASE_SCHEMA_VERSION)
		throw new Error(`Unsupported workspace lease schema version: ${lockPath}`);
	const generation = value.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
		throw new Error(`Invalid workspace lease generation: ${lockPath}`);
	}
	if (typeof value.holderId !== "string") throw new Error(`Invalid workspace lease holderId: ${lockPath}`);
	assertHolderId(value.holderId);
	if (typeof value.operation !== "string") throw new Error(`Invalid workspace lease operation: ${lockPath}`);
	assertOperation(value.operation);
	const leaseExpiresAt = value.leaseExpiresAt;
	if (typeof leaseExpiresAt !== "number" || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt < 0) {
		throw new Error(`Invalid workspace lease expiration: ${lockPath}`);
	}
	const observedAt =
		value.observedAt === undefined
			? leaseExpiresAt
			: typeof value.observedAt === "number" && Number.isFinite(value.observedAt) && value.observedAt >= 0
				? value.observedAt
				: (() => {
						throw new Error(`Invalid workspace lease observed clock value: ${lockPath}`);
					})();
	const bootId = value.bootId === undefined || value.bootId === "" ? "" : normalizeBootId(value.bootId);
	const monotonicExpiresAt =
		value.monotonicExpiresAt === undefined
			? 0
			: typeof value.monotonicExpiresAt === "number" &&
					Number.isFinite(value.monotonicExpiresAt) &&
					value.monotonicExpiresAt >= 0
				? value.monotonicExpiresAt
				: (() => {
						throw new Error(`Invalid workspace lease monotonic expiration: ${lockPath}`);
					})();
	if (typeof value.cleanupPending !== "boolean")
		throw new Error(`Invalid workspace lease cleanup-pending state: ${lockPath}`);
	return {
		schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
		generation,
		holderId: value.holderId,
		operation: value.operation,
		leaseExpiresAt,
		observedAt,
		bootId,
		monotonicExpiresAt,
		cleanupPending: value.cleanupPending,
	};
}

async function observeRecord(
	lockPath: string,
	record: WorkspaceLeaseRecord | undefined,
	now: number,
	workspaceLocksRoot: string,
): Promise<WorkspaceLeaseRecord | undefined> {
	if (record === undefined || record.observedAt >= now) return record;
	const observed = { ...record, observedAt: now };
	await writeRecord(lockPath, observed, workspaceLocksRoot);
	return observed;
}
async function writeRecord(lockPath: string, record: WorkspaceLeaseRecord, workspaceLocksRoot: string): Promise<void> {
	const directory = path.dirname(lockPath);
	if (directory !== workspaceLocksRoot)
		throw new Error(`Workspace lease record path escaped lock directory: ${lockPath}`);
	const temporaryPath = path.join(directory, `.workspace-lease-${process.pid}-${randomUUID()}.tmp`);
	const serialized = `${JSON.stringify(record)}\n`;
	let handle: fs.FileHandle | undefined;
	let renamed = false;
	try {
		handle = await fs.open(temporaryPath, "wx", RECORD_MODE);
		await handle.writeFile(serialized, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporaryPath, lockPath);
		renamed = true;
		await syncDirectory(directory);
	} finally {
		if (handle !== undefined) await handle.close();
		if (!renamed) await fs.rm(temporaryPath, { force: true });
	}
	const written = await fs.lstat(lockPath);
	if (written.isSymbolicLink() || !written.isFile())
		throw new Error(`Workspace lease record must be a regular file: ${lockPath}`);
	await fs.chmod(lockPath, RECORD_MODE);
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function defaultMonotonicNow(): number {
	return Math.floor(os.uptime() * 1_000);
}

function defaultBootId(): string | undefined {
	if (process.platform === "linux") {
		try {
			const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			if (bootId.length > 0) return bootId;
		} catch {
			// Fall through to the wall-clock expiry fallback.
		}
	}
	return undefined;
}

function resolveBootId(factory: () => string | undefined): string {
	const value = factory();
	return value === undefined ? "" : normalizeBootId(value);
}

function normalizeBootId(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_CORRELATION_ID_LENGTH ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
		throw new Error("Workspace lease boot ID must be a non-empty printable value");
	}
	return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeFsError(error: unknown, code: string): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code
	);
}
