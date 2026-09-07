import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	ManagedBootstrapAdmission,
	ManagedBootstrapAuthority,
	ManagedBootstrapAuthorityResolver,
	ManagedBootstrapCandidate,
} from "./adapter-managed-bootstrap";
import { isHistoricalSessionBinding, SESSION_AUTHORITY_V3_EPOCH } from "./gjc/session-authority-v3";
import type { ProjectRegistration, SqliteProjectRegistrationStore } from "./projects/registration-store";
import {
	deriveUserWorkspaceKey,
	getUserWorkspaceIdentity,
	type UserWorkspace,
	type UserWorkspaceIdentity,
	type UserWorkspaceRegistry,
} from "./security/user-workspace";
import {
	WorkspaceLease,
	type WorkspaceLeaseAcquireOptions,
	type WorkspaceLeaseManager,
	workspaceLeaseId,
} from "./security/workspace-lease";

type AdmissionRequest = Parameters<ManagedBootstrapAdmission["admit"]>[0];

export interface ManagedBootstrapAdmissionOwnerOptions {
	readonly projectStore: Pick<SqliteProjectRegistrationStore, "getProject">;
	readonly registry: UserWorkspaceRegistry;
	readonly leaseManager: WorkspaceLeaseManager;
	readonly leaseMs: number;
}

interface RegistrySnapshot {
	readonly device: bigint;
	readonly inode: bigint;
	readonly modified: bigint;
	readonly bytes: Buffer;
}

interface ValidatedEntry {
	readonly principalId: string;
	readonly sourceProject: ProjectRegistration;
	readonly workspace: UserWorkspace;
	readonly identity: UserWorkspaceIdentity;
}

interface OwnedLease {
	readonly handle: WorkspaceLease;
	readonly leaseId: string;
	assertFence: WorkspaceLease["assertFence"];
	assertCurrent: WorkspaceLease["assertFenceSync"];
}

interface OwnedCleanup {
	readonly primitiveLeaseId: string;
	readonly release: WorkspaceLease["release"];
}

/** Single-batch, in-process migration ownership; never imports authority from disk. */
export class ManagedBootstrapAdmissionOwner implements ManagedBootstrapAdmission, ManagedBootstrapAuthorityResolver {
	readonly #getProject: SqliteProjectRegistrationStore["getProject"];
	readonly #resolveWorkspace: UserWorkspaceRegistry["resolve"];
	readonly #registryPath: string;
	readonly #assertRegistryDependencies: () => void;
	readonly #acquire: WorkspaceLeaseManager["acquire"];
	readonly #assertLeaseDependencies: () => void;
	readonly #leaseMs: number;
	readonly #holderId = `bootstrap:${randomUUID()}`;
	readonly #releases = new Map<WorkspaceLease, OwnedCleanup>();
	readonly #cleanupFailures: unknown[] = [];
	readonly #owned = new Map<WorkspaceLease, OwnedLease>();
	readonly #acquisitions = new Set<Promise<WorkspaceLease>>();
	readonly #authorities = new Map<string, ManagedBootstrapAuthority>();
	#registrySnapshot: RegistrySnapshot | undefined;
	#request: AdmissionRequest | undefined;
	#admissionWork: Promise<void> | undefined;
	#releaseWork: Promise<void> | undefined;
	#started = false;
	#closed = false;
	readonly #abort = () => this.#close();

	constructor(options: ManagedBootstrapAdmissionOwnerOptions) {
		if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0)
			throw new RangeError("Bootstrap lease duration must be a positive bounded integer.");
		const registry = options.registry;
		const manager = options.leaseManager;
		if (
			registry.stateRoot !== manager.stateRoot ||
			!isAbsolute(registry.stateRoot) ||
			resolve(registry.stateRoot) !== registry.stateRoot
		)
			throw new Error("Bootstrap registry and lease manager must share the same canonical state root.");
		this.#leaseMs = options.leaseMs;
		this.#getProject = options.projectStore.getProject.bind(options.projectStore);
		this.#resolveWorkspace = registry.resolve.bind(registry);
		this.#registryPath = registry.registryPath;
		const registryRoot = registry.stateRoot;
		const workspacesRoot = registry.workspacesRoot;
		this.#assertRegistryDependencies = () => {
			if (
				registry.stateRoot !== registryRoot ||
				registry.workspacesRoot !== workspacesRoot ||
				registry.registryPath !== this.#registryPath
			)
				throw new Error("Bootstrap registry dependency changed.");
		};
		this.#acquire = manager.acquire.bind(manager);
		// Handle methods delegate to these manager methods. Never follow replacements,
		// including during release: that would falsely report cleanup of a foreign fence.
		const { assertFence, assertFenceSync, release, lockPath, stateRoot, locksRoot, workspaceLocksRoot } = manager;
		this.#assertLeaseDependencies = () => {
			if (
				manager.assertFence !== assertFence ||
				manager.assertFenceSync !== assertFenceSync ||
				manager.release !== release ||
				manager.lockPath !== lockPath ||
				manager.stateRoot !== stateRoot ||
				manager.locksRoot !== locksRoot ||
				manager.workspaceLocksRoot !== workspaceLocksRoot
			)
				throw new Error("Bootstrap lease dependency changed.");
		};
	}

	admit(input: AdmissionRequest): Promise<void> {
		if (this.#started || this.#closed)
			return Promise.reject(new Error("Bootstrap admission is closed or already used."));
		this.#started = true;
		try {
			// Copy nested history and capture callbacks with their original receivers before yielding.
			const request = Object.freeze({
				manifestDigest: input.manifestDigest,
				candidates: structuredClone(input.candidates),
				signal: input.signal,
				remaining: input.remaining.bind(input),
				assertCurrent: input.assertCurrent.bind(input),
			});
			this.#request = request;
			request.signal.addEventListener("abort", this.#abort, { once: true });
			if (request.signal.aborted) this.#close();
			// Retain work before invoking any callback: release can be reentrant.
			this.#admissionWork = Promise.resolve()
				.then(() => this.#admit(request))
				.catch(error => {
					this.#close();
					throw error;
				});
		} catch (error) {
			this.#close();
			this.#admissionWork = Promise.reject(error);
		}
		void this.#admissionWork.catch(() => undefined);
		return this.#admissionWork;
	}

	async resolve(principalId: string, projectId: string): Promise<ManagedBootstrapAuthority | undefined> {
		if (this.#closed || this.#request?.signal.aborted) return undefined;
		const authority = this.#authorities.get(entryKey(principalId, projectId));
		if (authority === undefined) return undefined;
		try {
			this.#assertOpen();
			return authority;
		} catch {
			return undefined;
		}
	}

	release(): Promise<void> {
		this.#close();
		if (this.#releaseWork === undefined) {
			this.#releaseWork = Promise.resolve().then(async () => {
				// Admission owns all validation and the raw acquisitions, not a caller's timeout race.
				await this.#admissionWork?.catch(() => undefined);
				await Promise.allSettled(this.#acquisitions);
				const failures = [...this.#cleanupFailures];
				for (const [handle, cleanup] of this.#releases) {
					try {
						this.#assertLeaseDependencies();
						// Cleanup uses the same primitive getters as the real manager's
						// release path, never a mutable public reference or admission budget.
						if (primitiveLeaseId(handle) !== cleanup.primitiveLeaseId)
							throw new Error("Bootstrap cleanup lease identity changed.");
						await cleanup.release();
						this.#assertLeaseDependencies();
					} catch (error) {
						failures.push(error);
					}
				}
				if (failures.length > 0) throw new AggregateError(failures, "Bootstrap admission release failed.");
			});
			void this.#releaseWork.catch(() => undefined);
		}
		return this.#releaseWork;
	}

	async #admit(request: AdmissionRequest): Promise<void> {
		this.#assertOpen();
		if (!/^[a-f0-9]{64}$/.test(request.manifestDigest)) throw new Error("Invalid bootstrap manifest digest.");
		for (const candidate of request.candidates) {
			assertCandidate(candidate);
			// A single-use owner has no original handles at preflight. Even a still-live
			// persisted lease id cannot prove ownership of a retained lifecycle intent.
			if (candidate.retainedIntent !== undefined)
				throw new Error("Retained bootstrap intent requires its original in-process owned lease.");
		}
		await this.#checkpoint();
		const entries = new Map<string, ValidatedEntry>();
		if (request.candidates.length > 0) this.#registrySnapshot = readRegistrySnapshot(this.#registryPath);
		for (const candidate of request.candidates) {
			this.#assertOpen();
			const sourceProject = structuredClone(this.#linkedProject(candidate.projectId));
			const workspace = await this.#resolveWorkspace(candidate.principalId);
			this.#assertOpen();
			this.#assertRegistry();
			if (
				workspace === undefined ||
				workspace.userId !== candidate.principalId ||
				workspace.safeKey !== deriveUserWorkspaceKey(candidate.principalId) ||
				(candidate.source.canonicalWorkspace !== undefined &&
					candidate.source.canonicalWorkspace !== workspace.root)
			)
				throw new Error("Bootstrap workspace does not match its historical principal or workspace.");
			const retainedWorkspace = Object.freeze({ ...workspace });
			const identity = Object.freeze(await getUserWorkspaceIdentity(retainedWorkspace));
			this.#assertOpen();
			if (identity.status !== "present") throw new Error("Bootstrap workspace must be present.");
			const entry = { principalId: candidate.principalId, sourceProject, workspace: retainedWorkspace, identity };
			this.#assertEntry(entry);
			const key = entryKey(candidate.principalId, candidate.projectId);
			const existing = entries.get(key);
			if (existing !== undefined && !isDeepStrictEqual(existing, entry))
				throw new Error("Bootstrap batch contains conflicting authority bindings.");
			entries.set(key, existing ?? entry);
		}
		await this.#checkpoint();
		// Recheck the entire batch before acquiring even its first lease.
		for (const entry of entries.values()) this.#assertEntry(entry);
		const leases = new Map<string, OwnedLease>();
		for (const entry of entries.values()) {
			if (leases.has(entry.workspace.safeKey)) continue;
			this.#assertOpen();
			// Register a producer before the dependency can abort/release reentrantly.
			const work = Promise.resolve().then(() => {
				this.#assertOpen();
				for (const current of entries.values()) this.#assertEntry(current);
				const remaining = this.#assertOpen();
				const acquisition = Object.freeze({
					safeKey: entry.workspace.safeKey,
					holderId: this.#holderId,
					operation: "migration",
					leaseMs: Math.min(this.#leaseMs, Math.floor(remaining)),
				});
				return this.#acquire(acquisition).then(handle => {
					// A late result may be cleanup-owned but must not gain authority.
					this.#retain(handle, acquisition);
					return handle;
				});
			});
			this.#acquisitions.add(work);
			const handle = await work;
			this.#assertOpen();
			const lease = this.#owned.get(handle)!;
			leases.set(entry.workspace.safeKey, lease);
		}
		for (const entry of entries.values()) {
			await this.#validateEntry(entry);
			await this.#fenceLease(leases.get(entry.workspace.safeKey)!);
		}
		await this.#checkpoint();
		// No yields between final checks and publication of the complete resolver map.
		for (const entry of entries.values()) this.#assertCurrent(entry, leases.get(entry.workspace.safeKey)!);
		const authorities = new Map<string, ManagedBootstrapAuthority>();
		for (const [key, entry] of entries) {
			const lease = leases.get(entry.workspace.safeKey)!;
			authorities.set(
				key,
				Object.freeze({
					project: Object.freeze({
						...structuredClone(entry.sourceProject),
						cwd: entry.workspace.root,
						sessionRoot: entry.workspace.sessionRoot,
					}),
					canonicalWorkspace: entry.workspace.root,
					leaseId: lease.leaseId,
					epoch: SESSION_AUTHORITY_V3_EPOCH,
					assertFence: async () => {
						try {
							await this.#validateEntry(entry);
							await this.#fenceLease(lease);
							this.#assertCurrent(entry, lease);
						} catch (error) {
							this.#close();
							throw error;
						}
					},
					assertCurrent: () => this.#assertCurrent(entry, lease),
				}),
			);
		}
		this.#assertOpen();
		for (const [key, authority] of authorities) this.#authorities.set(key, authority);
	}

	#retain(handle: WorkspaceLease, acquisition: WorkspaceLeaseAcquireOptions): void {
		let primitiveId: string;
		try {
			if (!(handle instanceof WorkspaceLease))
				throw new Error("Bootstrap acquisition returned an unproven lease handle.");
			primitiveId = primitiveLeaseId(handle);
			if (
				handle.safeKey !== acquisition.safeKey ||
				handle.holderId !== acquisition.holderId ||
				handle.operation !== acquisition.operation ||
				handle.released
			)
				throw new Error("Bootstrap acquisition returned an unproven or foreign lease.");
			const original = this.#releases.get(handle);
			if (original !== undefined && original.primitiveLeaseId !== primitiveId)
				throw new Error("Bootstrap returned lease identity changed.");
			if (original === undefined)
				this.#releases.set(handle, { primitiveLeaseId: primitiveId, release: handle.release.bind(handle) });
		} catch (error) {
			// An unproven result is not permission to release it, nor cleanup success.
			this.#cleanupFailures.push(error);
			throw error;
		}
		// The real release path reads primitive getters. A malformed public reference
		// fails admission but does not discard cleanup of a proven original handle.
		if (workspaceLeaseId(handle.reference) !== primitiveId)
			throw new Error("Bootstrap acquired lease reference does not match its primitive identity.");
		if (this.#owned.has(handle)) return;
		this.#owned.set(handle, {
			handle,
			leaseId: primitiveId,
			assertFence: handle.assertFence.bind(handle),
			assertCurrent: handle.assertFenceSync.bind(handle),
		});
	}

	#linkedProject(projectId: string): ProjectRegistration {
		const project = this.#getProject(projectId);
		if (project?.status !== "linked" || project.id !== projectId)
			throw new Error("Bootstrap source project is missing, unlinked or not the exact requested id.");
		return project;
	}

	async #checkpoint(): Promise<void> {
		this.#assertOpen();
		await this.#request!.assertCurrent();
		this.#assertOpen();
	}

	async #validateEntry(entry: ValidatedEntry): Promise<void> {
		this.#assertEntry(entry);
		const workspace = await this.#resolveWorkspace(entry.principalId);
		this.#assertOpen();
		if (!isDeepStrictEqual(workspace, entry.workspace)) throw new Error("Bootstrap workspace binding changed.");
		const identity = await getUserWorkspaceIdentity(entry.workspace);
		this.#assertOpen();
		if (!isDeepStrictEqual(identity, entry.identity)) throw new Error("Bootstrap workspace identity changed.");
		this.#assertEntry(entry);
	}

	async #fenceLease(lease: OwnedLease): Promise<void> {
		this.#assertOpen();
		this.#assertLeaseIdentity(lease);
		await lease.assertFence();
		this.#assertOpen();
		this.#assertLeaseIdentity(lease);
		// The async manager check alone does not reject cleanupPending.
		lease.assertCurrent();
	}

	#assertCurrent(entry: ValidatedEntry, lease: OwnedLease): void {
		try {
			this.#assertEntry(entry);
			this.#assertLeaseIdentity(lease);
			lease.assertCurrent();
			this.#assertEntry(entry);
		} catch (error) {
			this.#close();
			throw error;
		}
	}

	#assertLeaseIdentity(lease: OwnedLease): void {
		if (
			primitiveLeaseId(lease.handle) !== lease.leaseId ||
			workspaceLeaseId(lease.handle.reference) !== lease.leaseId
		)
			throw new Error("Bootstrap owned lease identity changed.");
	}

	#assertEntry(entry: ValidatedEntry): void {
		this.#assertOpen();
		if (!isDeepStrictEqual(this.#linkedProject(entry.sourceProject.id), entry.sourceProject))
			throw new Error("Bootstrap source project registration changed.");
		this.#assertRegistry();
		assertWorkspaceIdentity(entry.workspace, entry.identity);
		this.#assertOpen();
	}

	#assertRegistry(): void {
		const expected = this.#registrySnapshot;
		const actual = readRegistrySnapshot(this.#registryPath);
		if (
			expected === undefined ||
			actual.device !== expected.device ||
			actual.inode !== expected.inode ||
			actual.modified !== expected.modified ||
			!actual.bytes.equals(expected.bytes)
		)
			throw new Error("Bootstrap workspace registry changed.");
	}

	#assertOpen(): number {
		try {
			this.#assertAvailable();
			const remaining = this.#request!.remaining();
			// A caller callback can release/abort reentrantly. Do not call it again
			// while checking that outcome or from cleanup.
			this.#assertAvailable();
			if (!Number.isFinite(remaining) || remaining < 1) throw new Error("Bootstrap admission deadline expired.");
			return remaining;
		} catch (error) {
			this.#close();
			throw error;
		}
	}

	#assertAvailable(): void {
		if (this.#closed || this.#request?.signal.aborted) throw new Error("Bootstrap admission is closed or cancelled.");
		this.#assertRegistryDependencies();
		this.#assertLeaseDependencies();
	}

	#close(): void {
		this.#closed = true;
		this.#authorities.clear();
		this.#request?.signal.removeEventListener("abort", this.#abort);
	}
}

function primitiveLeaseId(handle: WorkspaceLease): string {
	return workspaceLeaseId({
		safeKey: handle.safeKey,
		holderId: handle.holderId,
		operation: handle.operation,
		generation: handle.generation,
	});
}

function entryKey(principalId: string, projectId: string): string {
	return JSON.stringify([principalId, projectId]);
}

function assertCandidate(candidate: ManagedBootstrapCandidate): void {
	const { source, principalId, projectId, chatId } = candidate;
	if (
		![principalId, projectId, chatId].every(exactString) ||
		!isHistoricalSessionBinding(source) ||
		!exactString(source.sessionId) ||
		source.projectId !== projectId ||
		(source.principalId !== undefined && source.principalId !== principalId)
	)
		throw new Error("Bootstrap candidate does not match its exact historical identity.");
	let scope: unknown;
	try {
		scope = JSON.parse(source.chatId);
	} catch {
		// Plain legacy history uses the coordinator's already-resolved principal.
	}
	if (Array.isArray(scope)) {
		if (
			scope.length !== 2 ||
			!scope.every(exactString) ||
			JSON.stringify(scope) !== source.chatId ||
			scope[0] !== principalId ||
			scope[1] !== chatId ||
			source.principalId !== principalId
		)
			throw new Error("Bootstrap candidate does not match its historical chat scope.");
	} else if (source.chatId !== chatId) {
		throw new Error("Bootstrap candidate does not match its historical chat.");
	}
}

function exactString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\p{Cc}]/u.test(value);
}

/** No second registry parser: any rewrite, even an unrelated registration, revokes this bounded batch. */
function readRegistrySnapshot(path: string): RegistrySnapshot {
	if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
		throw new Error("Bootstrap registry path is not canonical.");
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = fstatSync(descriptor, { bigint: true });
		if (!before.isFile()) throw new Error("Bootstrap registry must be a regular file.");
		const bytes = readFileSync(descriptor);
		const after = fstatSync(descriptor, { bigint: true });
		const named = lstatSync(path, { bigint: true });
		if (
			!named.isFile() ||
			named.isSymbolicLink() ||
			named.dev !== before.dev ||
			named.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs ||
			named.size !== after.size ||
			named.mtimeNs !== after.mtimeNs ||
			named.ctimeNs !== after.ctimeNs ||
			realpathSync(path) !== path
		)
			throw new Error("Bootstrap registry changed during validation.");
		// Registry lookup chmods the existing file; ctime is compared within a read,
		// not across lookups. Content, inode and mtime are never refreshed.
		return { device: before.dev, inode: before.ino, modified: before.mtimeNs, bytes };
	} finally {
		closeSync(descriptor);
	}
}

function assertWorkspaceIdentity(workspace: UserWorkspace, identity: UserWorkspaceIdentity): void {
	const stats = lstatSync(workspace.root);
	if (
		identity.status !== "present" ||
		identity.workspaceRoot !== workspace.root ||
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		stats.dev !== identity.device ||
		stats.ino !== identity.inode ||
		realpathSync(workspace.root) !== workspace.root
	)
		throw new Error("Bootstrap workspace identity changed.");
	// Preserve registry's prospective-session-path behavior without following new symlinks.
	for (const path of [dirname(workspace.sessionRoot), workspace.sessionRoot]) {
		try {
			const current = lstatSync(path);
			if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(path) !== path)
				throw new Error("Bootstrap workspace session path changed.");
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
}
