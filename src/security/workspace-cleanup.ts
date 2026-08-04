import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getUserWorkspaceIdentity, type UserWorkspaceIdentity, type UserWorkspaceRegistry } from "./user-workspace";
import type { WorkspaceLease, WorkspaceLeaseManager } from "./workspace-lease";

const DIRECTORY_MODE = 0o700;
const RECORD_MODE = 0o600;
const SAFE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_CONFIRMATION_TOKEN_LENGTH = 512;

export interface WorkspaceCleanupPreviewRequest {
	readonly userId: string;
}

export interface WorkspaceCleanupRequest {
	readonly userId: string;
	readonly confirmationToken: string;
}

export interface WorkspaceCleanupPreview {
	readonly dryRun: true;
	readonly found: boolean;
	readonly issuedAt: number;
	readonly expiresAt?: number;
	readonly safeKey?: string;
	readonly workspaceRoot?: string;
	readonly workspaceExists?: boolean;
	readonly workspaceIdentity?: UserWorkspaceIdentity;
	readonly confirmationToken?: string;
}

export interface WorkspaceCleanupResult {
	readonly status: "removed";
	readonly outcome: "success";
	readonly safeKey: string;
	readonly workspaceRoot: string;
	readonly completedAt: number;
	readonly auditPath?: string;
}

export type WorkspaceCleanupAuditOutcome = "confirmation-rejected" | "active-lease-refused" | "uncertain" | "success";

export interface WorkspaceCleanupAuditRecord {
	readonly safeKey: string;
	readonly operation: "cleanup";
	readonly outcome: WorkspaceCleanupAuditOutcome;
	readonly timestamp: number;
}
export interface WorkspaceCleanupAuthorityRetirementRequest {
	readonly principalId: string;
	readonly assertFence: () => Promise<void>;
}

export interface WorkspaceCleanupAuthorityCoordinator {
	/**
	 * Closes every session owned by the principal and retires its durable
	 * authority only after each close has been proven.
	 */
	readonly retirePrincipal: (input: WorkspaceCleanupAuthorityRetirementRequest) => Promise<void>;
}

export interface WorkspaceCleanupServiceOptions {
	readonly stateRoot?: string;
	readonly registry?: UserWorkspaceRegistry;
	readonly leaseManager?: WorkspaceLeaseManager;
	readonly now?: () => number;
	readonly leaseMs?: number;
	readonly heartbeatMs?: number;
	readonly confirmationTtlMs?: number;
	readonly tokenFactory?: () => string;
	readonly holderIdFactory?: (safeKey: string) => string;
	readonly authorityCoordinator: WorkspaceCleanupAuthorityCoordinator;
	/** Configured administrator identities never own user workspaces. */
	readonly adminPrincipalId?: string;
}

export class WorkspaceCleanupError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceCleanupError";
		this.code = code;
	}
}

export class WorkspaceCleanupConfirmationError extends WorkspaceCleanupError {
	constructor(message = "Workspace cleanup confirmation is invalid or stale") {
		super("invalid_confirmation", message);
		this.name = "WorkspaceCleanupConfirmationError";
	}
}

export class WorkspaceCleanupUncertainError extends WorkspaceCleanupError {
	constructor(message = "Workspace cleanup is uncertain and remains blocked", options?: ErrorOptions) {
		super("cleanup_uncertain", message, options);
		this.name = "WorkspaceCleanupUncertainError";
	}
}

interface ConfirmationState {
	readonly safeKey: string;
	readonly workspaceRoot: string;
	readonly identity: UserWorkspaceIdentity;
	readonly issuedAt: number;
	readonly expiresAt: number;
}

export class WorkspaceCleanupService {
	readonly stateRoot: string;
	readonly #registry: UserWorkspaceRegistry;
	readonly #leaseManager: WorkspaceLeaseManager;
	readonly #now: () => number;
	readonly #leaseMs: number;
	readonly #heartbeatMs: number;
	readonly #confirmationTtlMs: number;
	readonly #tokenFactory: () => string;
	readonly #holderIdFactory: (safeKey: string) => string;
	readonly #authorityCoordinator: WorkspaceCleanupAuthorityCoordinator;
	readonly #adminPrincipalId: string | undefined;
	readonly #confirmations = new Map<string, ConfirmationState>();

	constructor(options: WorkspaceCleanupServiceOptions) {
		const registry = options.registry;
		const leaseManager = options.leaseManager;
		if (registry === undefined) throw new TypeError("Workspace cleanup requires a user workspace registry");
		if (leaseManager === undefined) throw new TypeError("Workspace cleanup requires a workspace lease manager");
		const authorityCoordinator = options.authorityCoordinator;
		if (authorityCoordinator === undefined || typeof authorityCoordinator.retirePrincipal !== "function")
			throw new TypeError("Workspace cleanup requires a workspace cleanup authority coordinator");
		if (options.adminPrincipalId !== undefined && typeof options.adminPrincipalId !== "string")
			throw new TypeError("Workspace cleanup admin principal ID must be a string when configured");
		const stateRoot = path.resolve(options.stateRoot ?? registry.stateRoot);
		if (path.resolve(registry.stateRoot) !== stateRoot || path.resolve(leaseManager.stateRoot) !== stateRoot) {
			throw new Error("Workspace cleanup registry, lease manager, and stateRoot must match");
		}
		this.stateRoot = stateRoot;
		this.#registry = registry;
		this.#leaseManager = leaseManager;
		this.#authorityCoordinator = authorityCoordinator;
		this.#adminPrincipalId =
			options.adminPrincipalId === undefined || options.adminPrincipalId.length === 0
				? undefined
				: options.adminPrincipalId;
		this.#now = options.now ?? Date.now;
		this.#leaseMs = assertDuration(options.leaseMs ?? DEFAULT_LEASE_MS, "lease");
		this.#heartbeatMs = assertHeartbeat(
			options.heartbeatMs ?? Math.max(1, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(this.#leaseMs / 4))),
			this.#leaseMs,
		);
		this.#confirmationTtlMs = assertDuration(
			options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS,
			"confirmation token",
		);
		this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
		this.#holderIdFactory =
			options.holderIdFactory ?? (safeKey => `gjc-cleanup-${process.pid}-${safeKey.slice(0, 12)}-${randomUUID()}`);
	}

	async preview(input: WorkspaceCleanupPreviewRequest): Promise<WorkspaceCleanupPreview> {
		assertUserId(input?.userId);
		assertCleanupPrincipalAllowed(input.userId, this.#adminPrincipalId);
		const issuedAt = this.readNow();
		const workspace = await this.#registry.resolve(input.userId);
		if (workspace === undefined) {
			return { dryRun: true, found: false, issuedAt };
		}
		await assertPathInsideStateRoot(workspace.root, this.stateRoot, "workspace preview");
		const identity = await getUserWorkspaceIdentity(workspace);
		const token = this.#newToken();
		const expiresAt = addDuration(issuedAt, this.#confirmationTtlMs);
		this.#confirmations.set(token, {
			safeKey: workspace.safeKey,
			workspaceRoot: workspace.root,
			identity,
			issuedAt,
			expiresAt,
		});
		return {
			dryRun: true,
			found: true,
			issuedAt,
			expiresAt,
			safeKey: workspace.safeKey,
			workspaceRoot: workspace.root,
			workspaceExists: identity.status === "present",
			workspaceIdentity: identity,
			confirmationToken: token,
		};
	}

	async cleanup(input: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult> {
		assertUserId(input?.userId);
		assertCleanupPrincipalAllowed(input.userId, this.#adminPrincipalId);
		assertConfirmationToken(input?.confirmationToken);
		const token = input.confirmationToken;
		const state = this.#confirmations.get(token);
		const workspace = await this.#registry.resolve(input.userId);
		const safeKey = workspace?.safeKey ?? state?.safeKey;
		if (state === undefined || workspace === undefined || safeKey !== state.safeKey) {
			await this.#writeRejectedAudit(safeKey);
			throw new WorkspaceCleanupConfirmationError();
		}
		const now = this.readNow();
		if (state.expiresAt <= now) {
			await this.#writeRejectedAudit(safeKey);
			throw new WorkspaceCleanupConfirmationError("Workspace cleanup confirmation has expired");
		}
		if (workspace.root !== state.workspaceRoot) {
			await this.#writeRejectedAudit(safeKey);
			throw new WorkspaceCleanupConfirmationError("Workspace cleanup confirmation is bound to another workspace");
		}
		await assertPathInsideStateRoot(workspace.root, this.stateRoot, "workspace cleanup");
		const currentIdentity = await getUserWorkspaceIdentity(workspace);
		if (!sameIdentity(currentIdentity, state.identity)) {
			await this.#writeRejectedAudit(safeKey);
			throw new WorkspaceCleanupConfirmationError("Workspace cleanup confirmation is stale");
		}

		let lease: WorkspaceLease;
		try {
			lease = await this.#leaseManager.acquire({
				safeKey,
				holderId: this.#holderIdFactory(safeKey),
				operation: "cleanup",
				leaseMs: this.#leaseMs,
			});
		} catch (error) {
			await this.#writeAudit({
				safeKey,
				operation: "cleanup",
				outcome: "active-lease-refused",
				timestamp: this.readNow(),
			});
			throw error;
		}

		const guard = new CleanupLeaseGuard(lease, this.#leaseMs, this.#heartbeatMs);
		let removedRecord: { readonly userId: string; readonly workspaceRoot: string } | undefined;
		let registryRemoved = false;
		let cleanupCompleted = false;
		try {
			await guard.assertFence();
			lease = await guard.lease.setCleanupPending();
			guard.updateLease(lease);
			guard.start();
			await guard.assertFence();
			await retirePrincipalAuthority(this.#authorityCoordinator, workspace.userId, () => guard.assertFence());
			await guard.assertFence();
			await removeWorkspaceTree(workspace.root, this.stateRoot, () => guard.assertFence());
			await guard.assertFence();
			removedRecord = await this.#registry.removeBySafeKey(safeKey, workspace.root);
			if (removedRecord === undefined) throw new Error("Workspace registry record disappeared during cleanup");
			registryRemoved = true;
			await guard.assertFence();
			await guard.stop();
			await guard.lease.completeCleanup();
			cleanupCompleted = true;
			const completedAt = this.readNow();
			const auditPath = await this.#writeAudit({
				safeKey,
				operation: "cleanup",
				outcome: "success",
				timestamp: completedAt,
			});
			this.#confirmations.delete(token);
			return {
				status: "removed",
				outcome: "success",
				safeKey,
				workspaceRoot: workspace.root,
				completedAt,
				...(auditPath === undefined ? {} : { auditPath }),
			};
		} catch (error) {
			await guard.stop();
			if (registryRemoved && !cleanupCompleted && removedRecord !== undefined) {
				try {
					await this.#registry.restoreBySafeKey(removedRecord);
				} catch (restoreError) {
					attachCause(error, restoreError);
				}
			}
			try {
				if (!guard.lease.released) await guard.lease.release();
			} catch (releaseError) {
				attachCause(error, releaseError);
			}
			await this.#writeAudit({ safeKey, operation: "cleanup", outcome: "uncertain", timestamp: this.readNow() });
			throw error;
		}
	}

	#newToken(): string {
		const token = this.#tokenFactory();
		assertConfirmationToken(token);
		if (this.#confirmations.has(token)) throw new Error("Workspace cleanup confirmation token collision");
		return token;
	}

	async #writeRejectedAudit(safeKey: string | undefined): Promise<void> {
		if (safeKey === undefined || !SAFE_KEY_PATTERN.test(safeKey)) return;
		await this.#writeAudit({
			safeKey,
			operation: "cleanup",
			outcome: "confirmation-rejected",
			timestamp: this.readNow(),
		});
	}

	async #writeAudit(record: WorkspaceCleanupAuditRecord): Promise<string | undefined> {
		if (!SAFE_KEY_PATTERN.test(record.safeKey)) return undefined;
		let temporary: string | undefined;
		try {
			const auditRoot = path.join(this.stateRoot, "workspace-cleanup", "audit");
			await ensurePrivateDirectory(this.stateRoot, "adapter state root");
			await ensurePrivateDirectory(path.join(this.stateRoot, "workspace-cleanup"), "workspace cleanup state");
			await ensurePrivateDirectory(auditRoot, "workspace cleanup audit");
			const filename = `${record.safeKey}-${record.timestamp}-${randomUUID()}.json`;
			const target = path.join(auditRoot, filename);
			temporary = path.join(auditRoot, `.${filename}.${randomUUID()}.tmp`);
			const handle = await fs.open(temporary, "wx", RECORD_MODE);
			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, target);
			temporary = undefined;
			await fs.chmod(target, RECORD_MODE);
			await syncDirectory(auditRoot);
			return target;
		} catch {
			if (temporary !== undefined) await fs.rm(temporary, { force: true }).catch(() => {});
			return undefined;
		}
	}

	readNow(): number {
		const value = this.#now();
		if (!Number.isFinite(value)) throw new Error("Workspace cleanup clock must return a finite number");
		return value;
	}
}

export function createWorkspaceCleanupService(options: WorkspaceCleanupServiceOptions): WorkspaceCleanupService {
	return new WorkspaceCleanupService(options);
}

class CleanupLeaseGuard {
	#lease: WorkspaceLease;
	readonly #durationMs: number;
	readonly #heartbeatMs: number;
	#timer: ReturnType<typeof setInterval> | undefined;
	#renewal: Promise<void> | undefined;
	#failure: unknown;
	#stopping = false;

	constructor(lease: WorkspaceLease, durationMs: number, heartbeatMs: number) {
		this.#lease = lease;
		this.#durationMs = durationMs;
		this.#heartbeatMs = heartbeatMs;
	}

	get lease(): WorkspaceLease {
		return this.#lease;
	}

	updateLease(lease: WorkspaceLease): void {
		this.#lease = lease;
	}

	start(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => this.scheduleRenewal(), this.#heartbeatMs);
		(this.#timer as unknown as { unref?: () => void }).unref?.();
	}

	async assertFence(): Promise<void> {
		if (this.#failure !== undefined) {
			throw new WorkspaceCleanupUncertainError("Workspace cleanup lease renewal is uncertain", {
				cause: this.#failure,
			});
		}
		try {
			await this.#lease.assertFence();
		} catch (error) {
			this.#failure = error;
			throw new WorkspaceCleanupUncertainError("Workspace cleanup lease fence was lost", { cause: error });
		}
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		if (this.#renewal !== undefined) await this.#renewal;
	}

	scheduleRenewal(): void {
		if (this.#stopping || this.#failure !== undefined || this.#renewal !== undefined) return;
		const renewal = this.renew();
		this.#renewal = renewal;
		void renewal.then(
			() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			},
			() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			},
		);
	}

	async renew(): Promise<void> {
		try {
			this.#lease = await this.#lease.renew(this.#durationMs);
		} catch (error) {
			this.#failure = error;
			if (this.#timer !== undefined) clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}
}

async function removeWorkspaceTree(
	workspaceRoot: string,
	stateRoot: string,
	assertFence: () => Promise<void>,
): Promise<void> {
	await assertFence();
	await assertPathInsideStateRoot(workspaceRoot, stateRoot, "workspace deletion");
	let stats: import("node:fs").Stats;
	try {
		stats = await fs.lstat(workspaceRoot);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return;
		throw error;
	}
	if (stats.isSymbolicLink()) throw new Error(`Workspace cleanup rejected a symlink: ${workspaceRoot}`);
	if (!stats.isDirectory()) throw new Error(`Workspace cleanup target is not a directory: ${workspaceRoot}`);
	await removeDirectory(workspaceRoot, stateRoot, assertFence);
}

async function removeDirectory(directory: string, stateRoot: string, assertFence: () => Promise<void>): Promise<void> {
	await assertFence();
	await assertPathInsideStateRoot(directory, stateRoot, "recursive workspace deletion");
	const resolvedDirectory = await fs.realpath(directory);
	const resolvedStateRoot = await fs.realpath(stateRoot);
	if (!isPathInsideRoot(resolvedDirectory, resolvedStateRoot)) {
		throw new Error("Workspace cleanup directory escaped stateRoot");
	}
	const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const descriptor = await fs.open(directory, flags);
	try {
		const directoryStats = await descriptor.stat();
		if (!directoryStats.isDirectory()) throw new Error(`Workspace cleanup target is not a directory: ${directory}`);
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			await assertFence();
			const child = path.join(directory, entry.name);
			await assertPathInsideStateRoot(child, stateRoot, "recursive workspace deletion");
			let stats: import("node:fs").Stats;
			try {
				stats = await fs.lstat(child);
			} catch (error) {
				if (isNodeFsError(error, "ENOENT")) throw new Error(`Workspace cleanup entry disappeared: ${child}`);
				throw error;
			}
			if (stats.isSymbolicLink()) throw new Error(`Workspace cleanup rejected a symlink: ${child}`);
			if (stats.isDirectory()) {
				await removeDirectory(child, stateRoot, assertFence);
			} else {
				await fs.unlink(child);
			}
		}
	} finally {
		await descriptor.close();
	}
	await assertFence();
	await fs.rmdir(directory);
}

async function assertPathInsideStateRoot(targetPath: string, stateRoot: string, phase: string): Promise<void> {
	const resolvedRoot = await fs.realpath(stateRoot);
	const absoluteTarget = path.resolve(targetPath);
	const relative = path.relative(resolvedRoot, absoluteTarget);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Workspace cleanup path escaped stateRoot during ${phase}`);
	}
	let current = resolvedRoot;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stats = await fs.lstat(current);
			if (stats.isSymbolicLink()) throw new Error(`Workspace cleanup rejected a symlink: ${current}`);
			if (!stats.isDirectory() && current !== absoluteTarget) {
				throw new Error(`Workspace cleanup path contains a non-directory entry: ${current}`);
			}
		} catch (error) {
			if (isNodeFsError(error, "ENOENT")) return;
			throw error;
		}
	}
}
async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
	const absolute = path.resolve(directory);
	const missing: string[] = [];
	let candidate = absolute;
	while (true) {
		try {
			const stats = await fs.lstat(candidate);
			if (stats.isSymbolicLink() || !stats.isDirectory())
				throw new Error(`${label} must be a directory: ${candidate}`);
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
		if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} must be a directory: ${candidate}`);
		await fs.chmod(candidate, DIRECTORY_MODE);
	}
	await fs.chmod(absolute, DIRECTORY_MODE);
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
function sameIdentity(left: UserWorkspaceIdentity, right: UserWorkspaceIdentity): boolean {
	return (
		left.workspaceRoot === right.workspaceRoot &&
		left.status === right.status &&
		left.device === right.device &&
		left.inode === right.inode
	);
}

function assertUserId(userId: string): void {
	if (typeof userId !== "string" || userId.length === 0)
		throw new TypeError("Workspace cleanup userId must be non-empty");
}
function assertCleanupPrincipalAllowed(userId: string, adminPrincipalId: string | undefined): void {
	if (adminPrincipalId !== undefined && userId === adminPrincipalId) {
		throw new WorkspaceCleanupError(
			"admin_workspace_forbidden",
			"Configured administrator identities cannot be cleaned up as user workspaces",
		);
	}
}

async function retirePrincipalAuthority(
	coordinator: WorkspaceCleanupAuthorityCoordinator,
	principalId: string,
	assertFence: () => Promise<void>,
): Promise<void> {
	try {
		await coordinator.retirePrincipal({ principalId, assertFence });
	} catch (error) {
		if (error instanceof WorkspaceCleanupUncertainError) throw error;
		throw new WorkspaceCleanupUncertainError(
			"Workspace cleanup could not close and retire principal session authority",
			{ cause: error },
		);
	}
}

function assertConfirmationToken(token: string): void {
	if (
		typeof token !== "string" ||
		token.length === 0 ||
		token.length > MAX_CONFIRMATION_TOKEN_LENGTH ||
		/[\u0000-\u001f\u007f]/u.test(token)
	) {
		throw new TypeError("Workspace cleanup confirmationToken must be a printable non-empty string");
	}
}

function assertDuration(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new TypeError(`Workspace cleanup ${label} duration must be positive`);
	return value;
}

function assertHeartbeat(value: number, leaseMs: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value * 3 >= leaseMs) {
		throw new TypeError("Workspace cleanup heartbeat must renew before lease expiration");
	}
	return value;
}

function addDuration(now: number, duration: number): number {
	const value = now + duration;
	if (!Number.isSafeInteger(value) || value <= now)
		throw new RangeError("Workspace cleanup timestamp is outside safe range");
	return value;
}

function attachCause(error: unknown, cause: unknown): void {
	if (error instanceof Error && error.cause === undefined) Reflect.defineProperty(error, "cause", { value: cause });
}

function isNodeFsError(error: unknown, code: string): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code
	);
}
