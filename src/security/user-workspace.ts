import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DIRECTORY_MODE = 0o700;
const REGISTRY_MODE = 0o600;
const SAFE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const PORTABLE_PROCESS_IDENTITY = "portable";

export interface UserWorkspace {
	readonly userId: string;
	readonly safeKey: string;
	readonly root: string;
	readonly sessionRoot: string;
}

export interface UserWorkspaceRegistryRecord {
	readonly userId: string;
	readonly workspaceRoot: string;
}
export interface UserWorkspaceIdentity {
	readonly workspaceRoot: string;
	readonly status: "present" | "missing";
	readonly device?: number;
	readonly inode?: number;
}

export interface UserWorkspaceRegistryOptions {
	readonly stateRoot: string;
}
export type UserWorkspaceRegistrySnapshot = Record<string, UserWorkspaceRegistryRecord>;

export function deriveUserWorkspaceKey(userId: string): string {
	assertUserId(userId);
	return createHash("sha256").update(userId, "utf8").digest("hex");
}

export class UserWorkspaceRegistry {
	readonly stateRoot: string;
	readonly workspacesRoot: string;
	readonly registryPath: string;

	constructor(options: UserWorkspaceRegistryOptions) {
		assertStateRoot(options.stateRoot);
		this.stateRoot = path.resolve(options.stateRoot);
		this.workspacesRoot = path.join(this.stateRoot, "workspaces");
		this.registryPath = path.join(this.workspacesRoot, "registry.json");
	}

	async open(userId: string): Promise<UserWorkspace> {
		assertUserId(userId);
		const safeKey = deriveUserWorkspaceKey(userId);
		return withStateLock(this.stateRoot, () => this.openLocked(userId, safeKey));
	}

	async resolve(userId: string): Promise<UserWorkspace | undefined> {
		assertUserId(userId);
		const safeKey = deriveUserWorkspaceKey(userId);
		return withStateLock(this.stateRoot, () => this.resolveLocked(userId, safeKey));
	}

	/**
	 * Resolves an already registered workspace by its safe key without creating it.
	 * The raw user ID is intentionally not accepted by this method.
	 */
	async resolveBySafeKey(safeKey: string): Promise<UserWorkspace | undefined> {
		assertSafeKey(safeKey);
		return withStateLock(this.stateRoot, () => this.resolveBySafeKeyLocked(safeKey));
	}

	/**
	 * Removes one registry record after the caller has completed workspace cleanup.
	 * The expected root prevents a stale cleanup attempt from unregistering a replacement.
	 */
	async removeBySafeKey(
		safeKey: string,
		expectedWorkspaceRoot?: string,
	): Promise<UserWorkspaceRegistryRecord | undefined> {
		assertSafeKey(safeKey);
		const expectedRoot = expectedWorkspaceRoot === undefined ? undefined : path.resolve(expectedWorkspaceRoot);
		return withStateLock(this.stateRoot, async () => {
			await ensureDirectory(this.stateRoot, "state root", true);
			await ensureDirectory(this.workspacesRoot, "workspaces root", true);
			const resolvedWorkspacesRoot = await fs.realpath(this.workspacesRoot);
			const records = await readRegistry(this.registryPath, resolvedWorkspacesRoot);
			const existing = records[safeKey];
			if (existing === undefined) return undefined;
			if (expectedRoot !== undefined && path.resolve(existing.workspaceRoot) !== expectedRoot) {
				throw new Error(`User workspace registry root changed for safe key ${safeKey}`);
			}
			delete records[safeKey];
			await writeRegistry(this.registryPath, records, resolvedWorkspacesRoot);
			return existing;
		});
	}

	async restoreBySafeKey(record: UserWorkspaceRegistryRecord): Promise<void> {
		const safeKey = deriveUserWorkspaceKey(record.userId);
		await withStateLock(this.stateRoot, async () => {
			await ensureDirectory(this.stateRoot, "state root", true);
			await ensureDirectory(this.workspacesRoot, "workspaces root", true);
			const resolvedWorkspacesRoot = await fs.realpath(this.workspacesRoot);
			const records = await readRegistry(this.registryPath, resolvedWorkspacesRoot);
			const existing = records[safeKey];
			if (existing !== undefined && existing.workspaceRoot !== record.workspaceRoot) {
				throw new Error(`User workspace registry root changed for safe key ${safeKey}`);
			}
			if (path.resolve(record.workspaceRoot) !== path.join(resolvedWorkspacesRoot, safeKey, "workspace")) {
				throw new Error(`User workspace registry workspace root is inconsistent for safe key ${safeKey}`);
			}
			records[safeKey] = { userId: record.userId, workspaceRoot: record.workspaceRoot };
			await writeRegistry(this.registryPath, records, resolvedWorkspacesRoot);
		});
	}

	private async openLocked(userId: string, safeKey: string): Promise<UserWorkspace> {
		await ensureDirectory(this.stateRoot, "state root", true);
		await ensureDirectory(this.workspacesRoot, "workspaces root", true);
		const resolvedWorkspacesRoot = await fs.realpath(this.workspacesRoot);
		const workspaceRoot = path.join(resolvedWorkspacesRoot, safeKey, "workspace");
		const sessionRoot = path.join(workspaceRoot, ".gjc", "sessions");

		await assertResolvedPathInside(workspaceRoot, resolvedWorkspacesRoot, "before workspace creation");
		await assertNoUnsafeExistingPath(workspaceRoot, resolvedWorkspacesRoot, "workspace");
		const records = await readRegistry(this.registryPath, resolvedWorkspacesRoot);
		const existingRecord = records[safeKey];
		if (existingRecord !== undefined && existingRecord.userId !== userId) {
			throw new Error(`User workspace registry collision for safe key ${safeKey}`);
		}
		if (existingRecord !== undefined && existingRecord.workspaceRoot !== workspaceRoot) {
			throw new Error(`User workspace registry record is inconsistent for safe key ${safeKey}`);
		}

		await ensureDirectory(path.join(resolvedWorkspacesRoot, safeKey), `workspace key ${safeKey}`, true);
		await ensureDirectory(workspaceRoot, "workspace root", true);
		await ensureDirectory(path.join(workspaceRoot, ".gjc"), "workspace configuration directory", true);
		await ensureDirectory(sessionRoot, "workspace session root", true);
		await assertNoUnsafeExistingPath(sessionRoot, resolvedWorkspacesRoot, "workspace session root");
		await assertResolvedPathInside(sessionRoot, resolvedWorkspacesRoot, "after workspace creation");

		if (existingRecord === undefined) {
			records[safeKey] = { userId, workspaceRoot };
			await writeRegistry(this.registryPath, records, resolvedWorkspacesRoot);
			const persistedRecords = await readRegistry(this.registryPath, resolvedWorkspacesRoot);
			const persistedRecord = persistedRecords[safeKey];
			if (
				persistedRecord === undefined ||
				persistedRecord.userId !== userId ||
				persistedRecord.workspaceRoot !== workspaceRoot
			) {
				throw new Error(`User workspace registry did not persist safe key ${safeKey}`);
			}
		}

		return { userId, safeKey, root: workspaceRoot, sessionRoot };
	}

	private async resolveLocked(userId: string, safeKey: string): Promise<UserWorkspace | undefined> {
		const workspace = await this.resolveBySafeKeyLocked(safeKey);
		if (workspace === undefined || workspace.userId === userId) return workspace;
		throw new Error(`User workspace registry collision for safe key ${safeKey}`);
	}

	private async resolveBySafeKeyLocked(safeKey: string): Promise<UserWorkspace | undefined> {
		let resolvedWorkspacesRoot: string;
		try {
			resolvedWorkspacesRoot = await fs.realpath(this.workspacesRoot);
		} catch (error) {
			if (isNodeFsError(error, "ENOENT")) return undefined;
			throw error;
		}
		const workspacesStat = await fs.lstat(this.workspacesRoot);
		assertDirectoryStat(workspacesStat, this.workspacesRoot, "workspaces root");
		const records = await readRegistry(this.registryPath, resolvedWorkspacesRoot);
		const record = records[safeKey];
		if (record === undefined) return undefined;
		const workspaceRoot = path.resolve(record.workspaceRoot);
		const sessionRoot = path.join(workspaceRoot, ".gjc", "sessions");
		await assertResolvedPathInside(workspaceRoot, resolvedWorkspacesRoot, "while resolving workspace");
		await assertNoUnsafeExistingPath(workspaceRoot, resolvedWorkspacesRoot, "workspace");
		await assertNoUnsafeExistingPath(sessionRoot, resolvedWorkspacesRoot, "workspace session root");
		await assertResolvedPathInside(sessionRoot, resolvedWorkspacesRoot, "while resolving workspace session root");
		return {
			userId: record.userId,
			safeKey,
			root: workspaceRoot,
			sessionRoot,
		};
	}
}

export function createUserWorkspaceRegistry(options: UserWorkspaceRegistryOptions): UserWorkspaceRegistry {
	return new UserWorkspaceRegistry(options);
}

export async function getUserWorkspaceIdentity(workspace: UserWorkspace): Promise<UserWorkspaceIdentity> {
	try {
		const stats = await fs.lstat(workspace.root);
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new Error(`User workspace root must be a directory: ${workspace.root}`);
		}
		return {
			workspaceRoot: workspace.root,
			status: "present",
			device: stats.dev,
			inode: stats.ino,
		};
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) {
			return { workspaceRoot: workspace.root, status: "missing" };
		}
		throw error;
	}
}

const stateLocks = new Map<string, Promise<void>>();

async function withStateLock<T>(stateRoot: string, operation: () => Promise<T>): Promise<T> {
	const previous = stateLocks.get(stateRoot) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>(resolve => {
		release = resolve;
	});
	stateLocks.set(stateRoot, current);
	await previous;
	let releaseExternal: (() => Promise<void>) | undefined;
	try {
		await ensureDirectory(stateRoot, "state root", true);
		releaseExternal = await acquireRegistryLock(stateRoot);
		return await operation();
	} finally {
		try {
			await releaseExternal?.();
		} finally {
			release();
			if (stateLocks.get(stateRoot) === current) stateLocks.delete(stateRoot);
		}
	}
}

const REGISTRY_LOCK_ATTEMPTS = 200;
const REGISTRY_LOCK_DELAY_MS = 10;

interface RegistryLockOwner {
	readonly pid: number;
	readonly startTicks: string;
}

interface RegistryLockSnapshot {
	readonly owner: RegistryLockOwner;
	readonly device: number;
	readonly inode: number;
}
class RegistryLockMetadataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegistryLockMetadataError";
	}
}

async function acquireRegistryLock(stateRoot: string): Promise<() => Promise<void>> {
	const lockPath = path.join(stateRoot, ".workspace-registry.lock");
	const owner = await currentRegistryLockOwner();
	for (let attempt = 0; attempt < REGISTRY_LOCK_ATTEMPTS; attempt += 1) {
		let handle: fs.FileHandle | undefined;
		let created = false;
		let retained = false;
		try {
			handle = await fs.open(
				lockPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				REGISTRY_MODE,
			);
			created = true;
			await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			await handle.chmod(REGISTRY_MODE);
			await handle.sync();
			const stats = await handle.stat();
			assertPrivateRegistryLockStat(stats, lockPath);
			await handle.close();
			handle = undefined;
			await syncDirectory(path.dirname(lockPath));
			const snapshot: RegistryLockSnapshot = {
				owner,
				device: stats.dev,
				inode: stats.ino,
			};
			retained = true;
			return async () => {
				await removeRegistryLock(lockPath, snapshot);
			};
		} catch (error) {
			if (created) throw error;
			if (!isNodeFsError(error, "EEXIST")) throw error;
			let snapshot: RegistryLockSnapshot | undefined;
			try {
				snapshot = await readRegistryLockSnapshot(lockPath);
			} catch (metadataError) {
				if (!(metadataError instanceof RegistryLockMetadataError)) throw metadataError;
				await delayRegistryLock();
				continue;
			}
			if (snapshot !== undefined) {
				if (await isRegistryLockOwnerLive(snapshot.owner)) {
					await delayRegistryLock();
				} else if (await reclaimRegistryLock(lockPath, snapshot)) {
				}
			}
		} finally {
			await handle?.close();
			if (created && !retained) await unlinkRegistryLockIfPresent(lockPath);
		}
	}
	throw new Error(`User workspace registry lock is unavailable: ${stateRoot}`);
}

async function currentRegistryLockOwner(): Promise<RegistryLockOwner> {
	if (process.platform !== "linux") {
		return { pid: process.pid, startTicks: PORTABLE_PROCESS_IDENTITY };
	}
	return {
		pid: process.pid,
		startTicks: await registryLockStartTicks(process.pid),
	};
}
/**
 * Portable liveness only establishes whether a PID currently exists. A present
 * PID is therefore always treated as live because portable platforms provide no
 * safe PID-reuse identity.
 */
function portableProcessIsLive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid user workspace registry lock owner PID");
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		if (isNodeFsError(error, "EPERM")) return true;
		throw error;
	}
}

async function isRegistryLockOwnerLive(owner: RegistryLockOwner): Promise<boolean> {
	if (process.platform !== "linux") {
		try {
			return portableProcessIsLive(owner.pid);
		} catch (error) {
			throw new Error("Unable to establish user workspace registry lock owner liveness", { cause: error });
		}
	}
	try {
		return (await registryLockStartTicks(owner.pid)) === owner.startTicks;
	} catch (error) {
		if (isMissingProcessError(error)) return false;
		throw new Error("Unable to establish user workspace registry lock owner liveness", { cause: error });
	}
}

async function registryLockStartTicks(pid: number): Promise<string> {
	if (process.platform !== "linux") {
		throw new Error("User workspace registry lock process identity is unavailable on this platform");
	}
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid user workspace registry lock owner PID");
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
	const startTicks = fields[19];
	if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
		throw new Error(`Unable to validate process start identity for PID ${pid}`);
	}
	return startTicks;
}

async function readRegistryLockSnapshot(lockPath: string): Promise<RegistryLockSnapshot | undefined> {
	let linkStats: Stats;
	try {
		linkStats = await fs.lstat(lockPath);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return undefined;
		throw error;
	}
	assertPrivateRegistryLockStat(linkStats, lockPath);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = await handle.stat();
		assertPrivateRegistryLockStat(stats, lockPath);
		if (stats.dev !== linkStats.dev || stats.ino !== linkStats.ino) {
			throw new Error(`User workspace registry lock changed while being inspected: ${lockPath}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
		} catch {
			throw new RegistryLockMetadataError(`User workspace registry lock metadata is not valid JSON: ${lockPath}`);
		}
		return {
			owner: parseRegistryLockOwner(parsed, lockPath),
			device: stats.dev,
			inode: stats.ino,
		};
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

function parseRegistryLockOwner(value: unknown, lockPath: string): RegistryLockOwner {
	if (!isRecord(value))
		throw new RegistryLockMetadataError(`User workspace registry lock metadata is invalid: ${lockPath}`);
	const pid = value.pid;
	const startTicks = value.startTicks;
	const validStartTicks =
		typeof startTicks === "string" &&
		(process.platform === "linux"
			? /^\d+$/.test(startTicks)
			: /^\d+$/.test(startTicks) || startTicks === PORTABLE_PROCESS_IDENTITY);
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || !validStartTicks) {
		throw new RegistryLockMetadataError(`User workspace registry lock metadata is invalid: ${lockPath}`);
	}
	return { pid, startTicks };
}

function assertPrivateRegistryLockStat(stats: Stats, lockPath: string): void {
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`User workspace registry lock must be a regular file: ${lockPath}`);
	}
	if ((stats.mode & 0o777) !== REGISTRY_MODE) {
		throw new Error(`User workspace registry lock must be private: ${lockPath}`);
	}
	const getuid = process.getuid;
	if (typeof getuid === "function" && stats.uid !== getuid()) {
		throw new Error(`User workspace registry lock has foreign ownership: ${lockPath}`);
	}
}

async function reclaimRegistryLock(lockPath: string, snapshot: RegistryLockSnapshot): Promise<boolean> {
	const reclaimPath = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
	try {
		await fs.rename(lockPath, reclaimPath);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return false;
		throw new Error(`User workspace registry lock could not be claimed for recovery: ${lockPath}`, { cause: error });
	}
	try {
		const claimed = await readRegistryLockSnapshot(reclaimPath);
		if (
			claimed === undefined ||
			claimed.device !== snapshot.device ||
			claimed.inode !== snapshot.inode ||
			!sameRegistryLockOwner(claimed.owner, snapshot.owner)
		) {
			await restoreRegistryLockClaim(reclaimPath, lockPath);
			return false;
		}
		if (await isRegistryLockOwnerLive(claimed.owner)) {
			await restoreRegistryLockClaim(reclaimPath, lockPath);
			return false;
		}
		await fs.unlink(reclaimPath);
		await syncDirectory(path.dirname(lockPath));
		return true;
	} catch (error) {
		await restoreRegistryLockClaim(reclaimPath, lockPath);
		throw error;
	}
}

async function removeRegistryLock(lockPath: string, snapshot: RegistryLockSnapshot): Promise<void> {
	const current = await readRegistryLockSnapshot(lockPath);
	if (current === undefined) return;
	if (
		current.device !== snapshot.device ||
		current.inode !== snapshot.inode ||
		!sameRegistryLockOwner(current.owner, snapshot.owner)
	) {
		throw new Error(`User workspace registry lock ownership changed before release: ${lockPath}`);
	}
	const releasePath = `${lockPath}.release-${process.pid}-${randomUUID()}`;
	try {
		await fs.rename(lockPath, releasePath);
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return;
		throw new Error(`User workspace registry lock could not be claimed for release: ${lockPath}`, { cause: error });
	}
	try {
		const claimed = await readRegistryLockSnapshot(releasePath);
		if (
			claimed === undefined ||
			claimed.device !== snapshot.device ||
			claimed.inode !== snapshot.inode ||
			!sameRegistryLockOwner(claimed.owner, snapshot.owner)
		) {
			await restoreRegistryLockClaim(releasePath, lockPath);
			throw new Error(`User workspace registry lock changed before release: ${lockPath}`);
		}
		await fs.unlink(releasePath);
		await syncDirectory(path.dirname(lockPath));
	} catch (error) {
		await restoreRegistryLockClaim(releasePath, lockPath);
		throw error;
	}
}

async function restoreRegistryLockClaim(claimPath: string, lockPath: string): Promise<void> {
	try {
		await fs.link(claimPath, lockPath);
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

function sameRegistryLockOwner(left: RegistryLockOwner, right: RegistryLockOwner): boolean {
	return left.pid === right.pid && left.startTicks === right.startTicks;
}

function isMissingProcessError(error: unknown): boolean {
	return isNodeFsError(error, "ENOENT") || isNodeFsError(error, "ESRCH");
}

async function delayRegistryLock(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, REGISTRY_LOCK_DELAY_MS));
}

async function unlinkRegistryLockIfPresent(lockPath: string): Promise<void> {
	try {
		await fs.unlink(lockPath);
	} catch (error) {
		if (!isNodeFsError(error, "ENOENT")) throw error;
	}
}

async function ensureDirectory(directory: string, label: string, enforcePrivateMode: boolean): Promise<void> {
	let created = false;
	try {
		const existing = await fs.lstat(directory);
		assertDirectoryStat(existing, directory, label);
	} catch (error) {
		if (!isNodeFsError(error, "ENOENT")) throw error;
		try {
			await fs.mkdir(directory, { mode: DIRECTORY_MODE });
			created = true;
		} catch (mkdirError) {
			if (!isNodeFsError(mkdirError, "EEXIST")) throw mkdirError;
			const existing = await fs.lstat(directory);
			assertDirectoryStat(existing, directory, label);
		}
	}

	if (created || enforcePrivateMode) {
		await fs.chmod(directory, DIRECTORY_MODE);
		const verified = await fs.lstat(directory);
		assertDirectoryStat(verified, directory, label);
	}
}

async function readRegistry(registryPath: string, workspacesRoot: string): Promise<UserWorkspaceRegistrySnapshot> {
	let text: string;
	try {
		const registryStat = await fs.lstat(registryPath);
		if (registryStat.isSymbolicLink() || !registryStat.isFile()) {
			throw new Error(`User workspace registry must be a regular file: ${registryPath}`);
		}
		text = await fs.readFile(registryPath, "utf8");
	} catch (error) {
		if (isNodeFsError(error, "ENOENT")) return Object.create(null) as UserWorkspaceRegistrySnapshot;
		throw error;
	}

	const parsed: unknown = parseJson(text, registryPath);
	if (!isRecord(parsed)) throw new Error(`User workspace registry must be a JSON object: ${registryPath}`);
	const records = Object.create(null) as Record<string, UserWorkspaceRegistryRecord>;
	const seenUserIds = new Map<string, string>();
	for (const [safeKey, value] of Object.entries(parsed)) {
		if (!SAFE_KEY_PATTERN.test(safeKey)) {
			throw new Error(`User workspace registry contains an invalid safe key: ${safeKey}`);
		}
		if (!isRecord(value) || typeof value.userId !== "string" || typeof value.workspaceRoot !== "string") {
			throw new Error(`User workspace registry record is invalid for safe key ${safeKey}`);
		}
		assertUserId(value.userId);
		const expectedKey = deriveUserWorkspaceKey(value.userId);
		if (expectedKey !== safeKey) {
			throw new Error(`User workspace registry safe key does not match user ID: ${safeKey}`);
		}
		const expectedWorkspaceRoot = path.join(workspacesRoot, safeKey, "workspace");
		if (value.workspaceRoot !== expectedWorkspaceRoot) {
			throw new Error(`User workspace registry workspace root is inconsistent for safe key ${safeKey}`);
		}
		const priorSafeKey = seenUserIds.get(value.userId);
		if (priorSafeKey !== undefined && priorSafeKey !== safeKey) {
			throw new Error(`User workspace registry contains duplicate user ID ${value.userId}`);
		}
		seenUserIds.set(value.userId, safeKey);
		records[safeKey] = { userId: value.userId, workspaceRoot: value.workspaceRoot };
	}

	await fs.chmod(registryPath, REGISTRY_MODE);
	return records;
}

async function writeRegistry(
	registryPath: string,
	records: UserWorkspaceRegistrySnapshot,
	workspacesRoot: string,
): Promise<void> {
	await assertResolvedPathInside(registryPath, workspacesRoot, "before registry write");
	await assertNoUnsafeExistingPath(registryPath, workspacesRoot, "registry");
	const directory = path.dirname(registryPath);
	const temporaryPath = path.join(directory, `.registry-${process.pid}-${randomUUID()}.tmp`);
	const serialized = `${JSON.stringify(records, null, 2)}\n`;
	let handle: fs.FileHandle | undefined;
	let renamed = false;
	try {
		handle = await fs.open(temporaryPath, "wx", REGISTRY_MODE);
		await handle.writeFile(serialized, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporaryPath, registryPath);
		renamed = true;
		await syncDirectory(directory);
	} finally {
		if (handle !== undefined) await handle.close();
		if (!renamed) await fs.rm(temporaryPath, { force: true });
	}
	const writtenStat = await fs.lstat(registryPath);
	if (writtenStat.isSymbolicLink() || !writtenStat.isFile()) {
		throw new Error(`User workspace registry must be a regular file: ${registryPath}`);
	}
	await fs.chmod(registryPath, REGISTRY_MODE);
	await assertResolvedPathInside(registryPath, workspacesRoot, "after registry write");
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function assertResolvedPathInside(targetPath: string, rootPath: string, phase: string): Promise<void> {
	const resolvedTarget = await resolveExistingOrProspectivePath(targetPath);
	const resolvedRoot = await fs.realpath(rootPath);
	if (!isPathInsideRoot(resolvedTarget, resolvedRoot)) {
		throw new Error(`User workspace path escaped workspaces root ${phase}: ${targetPath}`);
	}
}

async function assertNoUnsafeExistingPath(targetPath: string, rootPath: string, label: string): Promise<void> {
	const relativePath = path.relative(rootPath, path.resolve(targetPath));
	if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error(`User workspace ${label} path is outside workspaces root: ${targetPath}`);
	}
	let current = rootPath;
	for (const segment of relativePath.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stats = await fs.lstat(current);
			if (stats.isSymbolicLink())
				throw new Error(`User workspace ${label} path must not contain a symlink: ${current}`);
			if (!stats.isDirectory() && current !== targetPath) {
				throw new Error(`User workspace ${label} path contains a non-directory entry: ${current}`);
			}
		} catch (error) {
			if (isNodeFsError(error, "ENOENT")) return;
			throw error;
		}
	}
}

async function resolveExistingOrProspectivePath(targetPath: string): Promise<string> {
	let candidate = path.resolve(targetPath);
	const missingSegments: string[] = [];
	while (true) {
		try {
			const resolvedCandidate = await fs.realpath(candidate);
			return path.resolve(resolvedCandidate, ...missingSegments);
		} catch (error) {
			if (!isNodeFsError(error, "ENOENT")) throw error;
			const parent = path.dirname(candidate);
			if (parent === candidate) throw new Error(`No existing parent found for path: ${targetPath}`);
			missingSegments.unshift(path.basename(candidate));
			candidate = parent;
		}
	}
}

function parseJson(text: string, registryPath: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`User workspace registry is not valid JSON: ${registryPath}`, { cause: error });
	}
}

function assertDirectoryStat(stats: Stats, directory: string, label: string): void {
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`User workspace ${label} must be a directory: ${directory}`);
	}
}

function assertSafeKey(safeKey: string): void {
	if (typeof safeKey !== "string" || !SAFE_KEY_PATTERN.test(safeKey)) {
		throw new TypeError("User workspace safeKey must be a lowercase 64-hex string");
	}
}
function assertStateRoot(stateRoot: string): void {
	if (typeof stateRoot !== "string" || stateRoot.trim().length === 0) {
		throw new TypeError("User workspace stateRoot must be a non-empty path");
	}
}

function assertUserId(userId: string): void {
	if (typeof userId !== "string" || userId.length === 0) {
		throw new TypeError("OpenWebUI user ID must be a non-empty string");
	}
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeFsError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
