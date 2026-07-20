import { constants } from "node:fs";
import { open, lstat, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

interface LockOwner { readonly pid: number; readonly startTicks: string; }
interface LockSnapshot { readonly owner: LockOwner; readonly device: number; readonly inode: number; }

const LOCK_FILE = ".openwebui-gjc-adapter.lock";
const RECOVERY_ATTEMPTS = 3;

/** A crash-recoverable, process-identity lock for one adapter runtime root. */
export class RuntimeSingletonLock {
	readonly #path: string;
	readonly #owner: LockOwner;
	#released = false;

	private constructor(root: string, owner: LockOwner) {
		this.#path = join(root, LOCK_FILE);
		this.#owner = owner;
	}

	static async acquire(runtimeRoot: string): Promise<RuntimeSingletonLock> {
		const lock = new RuntimeSingletonLock(await realpath(runtimeRoot), await currentOwner());
		for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt++) {
			try {
				await lock.#create();
				return lock;
			} catch (error) {
				if (!isExistsError(error)) throw error;
			}
			let snapshot: LockSnapshot;
			try { snapshot = await readSnapshot(lock.#path); } catch (error) { if (isMissingProcess(error)) continue; throw error; }
			if (await isLive(snapshot.owner)) throw new Error(`Adapter runtime root is already owned by PID ${snapshot.owner.pid}`);
			await removeSnapshot(lock.#path, snapshot);
		}
		throw new Error("Unable to recover a stale adapter runtime lock safely");
	}

	async release(): Promise<void> {
		if (this.#released) return;
		const snapshot = await readSnapshot(this.#path);
		if (!sameOwner(snapshot.owner, this.#owner)) throw new Error("Adapter runtime lock ownership changed before shutdown");
		await removeSnapshot(this.#path, snapshot);
		this.#released = true;
	}

	async #create(): Promise<void> {
		const file = await open(this.#path, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(this.#owner)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
	}
}

async function currentOwner(): Promise<LockOwner> { return { pid: process.pid, startTicks: await startTicks(process.pid) }; }
async function isLive(owner: LockOwner): Promise<boolean> {
	try { return (await startTicks(owner.pid)) === owner.startTicks; } catch (error) { if (isMissingProcess(error)) return false; throw error; }
}
async function startTicks(pid: number): Promise<string> {
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid lock owner PID");
	const stat = await readFile(`/proc/${pid}/stat`, "utf8");
	const closing = stat.lastIndexOf(")");
	const fields = closing < 0 ? [] : stat.slice(closing + 2).trim().split(/\s+/);
	const value = fields[19];
	if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Cannot validate start time for PID ${pid}`);
	return value;
}
async function readSnapshot(file: string): Promise<LockSnapshot> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const status = await handle.stat();
		if (!status.isFile() || status.isSymbolicLink()) throw new Error("Adapter runtime lock must be a regular non-symlink file");
		let parsed: unknown;
		try { parsed = JSON.parse(await handle.readFile("utf8")); } catch { throw new Error("Adapter runtime lock metadata is invalid"); }
		if (!isOwner(parsed)) throw new Error("Adapter runtime lock metadata is invalid");
		return { owner: parsed, device: status.dev, inode: status.ino };
	} finally { await handle.close(); }
}
async function removeSnapshot(file: string, snapshot: LockSnapshot): Promise<void> {
	const status = await lstat(file);
	if (!status.isFile() || status.isSymbolicLink() || status.dev !== snapshot.device || status.ino !== snapshot.inode)
		throw new Error("Adapter runtime lock changed during recovery");
	await unlink(file);
}
function isOwner(value: unknown): value is LockOwner {
	return typeof value === "object" && value !== null && typeof (value as LockOwner).pid === "number" && Number.isSafeInteger((value as LockOwner).pid) && (value as LockOwner).pid > 0 && typeof (value as LockOwner).startTicks === "string" && /^\d+$/.test((value as LockOwner).startTicks);
}
function sameOwner(left: LockOwner, right: LockOwner): boolean { return left.pid === right.pid && left.startTicks === right.startTicks; }
function isExistsError(error: unknown): boolean { return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST"; }
function isMissingProcess(error: unknown): boolean { return typeof error === "object" && error !== null && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH"); }
