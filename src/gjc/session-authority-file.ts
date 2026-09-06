import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { AuthorityMutationLockRecord } from "./session-authority-types";
import { isAlreadyExists, parseAuthorityMutationLockRecord } from "./session-authority-validation";

const LEASE_MS = 30_000;
const RECOVERY_ATTEMPTS = 3;

/** An owner-bound lease; stale recovery moves a verified expired record before removal. */
export class AuthorityMutationLock {
	#released = false;
	private constructor(
		private readonly path: string,
		private readonly record: AuthorityMutationLockRecord,
		private readonly identity: { readonly dev: number; readonly ino: number },
	) {}

	static acquire(authorityPath: string): AuthorityMutationLock {
		const path = `${resolve(authorityPath)}.lock`;
		mkdirSync(dirname(path), { recursive: true });

		for (let attempt = 0; attempt <= RECOVERY_ATTEMPTS; attempt += 1) {
			const record = createLockRecord();

			try {
				const identity = writeNewLock(path, record);
				return new AuthorityMutationLock(path, record, identity);
			} catch (error) {
				if (!isAlreadyExists(error)) {
					throw error;
				}

				if (attempt === RECOVERY_ATTEMPTS || !recoverExpiredLease(path)) {
					throw error;
				}
			}
		}

		throw new Error("Unable to acquire session authority mutation lease.");
	}

	assertHeld(authorityPath: string): void {
		if (this.#released || this.path !== `${resolve(authorityPath)}.lock`)
			throw new Error("Session authority mutation lease does not own the requested path.");
		if (!this.ownsLock() || this.record.leaseExpiresAt <= Date.now())
			throw new Error("Session authority mutation lease ownership was lost.");
	}

	release(): void {
		if (this.#released) return;
		if (!this.ownsLock()) {
			throw new Error("Session authority mutation lease ownership changed before release.");
		}

		unlinkSync(this.path);
		syncDirectory(this.path);
		this.#released = true;
	}

	private ownsLock(): boolean {
		const snapshot = readLockSnapshot(this.path);
		return (
			snapshot !== undefined &&
			snapshot.dev === this.identity.dev &&
			snapshot.ino === this.identity.ino &&
			snapshot.record.owner === this.record.owner &&
			snapshot.record.pid === this.record.pid &&
			snapshot.record.leaseExpiresAt === this.record.leaseExpiresAt
		);
	}
}

function createLockRecord(): AuthorityMutationLockRecord {
	return {
		owner: randomUUID(),
		pid: process.pid,
		leaseExpiresAt: Date.now() + LEASE_MS,
	};
}

function writeNewLock(
	path: string,
	record: AuthorityMutationLockRecord,
): { readonly dev: number; readonly ino: number } {
	const descriptor = openSync(path, "wx", 0o600);

	try {
		writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
		fsyncSync(descriptor);
		const { dev, ino } = fstatSync(descriptor);
		return { dev, ino };
	} finally {
		closeSync(descriptor);
	}
}

function recoverExpiredLease(path: string): boolean {
	const current = readLock(path);
	if (current === undefined || current.leaseExpiresAt > Date.now() || processIsLive(current.pid)) {
		return false;
	}

	const recovered = `${path}.recovered-${randomUUID()}`;
	try {
		renameSync(path, recovered);
	} catch (error) {
		if (isAlreadyExists(error)) {
			return false;
		}

		throw error;
	}

	const moved = readLock(recovered);
	if (
		moved === undefined ||
		moved.owner !== current.owner ||
		moved.leaseExpiresAt !== current.leaseExpiresAt ||
		moved.leaseExpiresAt > Date.now()
	) {
		throw new Error("Refusing to recover an unverifiable authority lease.");
	}

	unlinkSync(recovered);
	syncDirectory(path);
	return true;
}

function readLock(path: string): AuthorityMutationLockRecord | undefined {
	return readLockSnapshot(path)?.record;
}

function readLockSnapshot(
	path: string,
): { readonly record: AuthorityMutationLockRecord; readonly dev: number; readonly ino: number } | undefined {
	try {
		const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const before = fstatSync(descriptor);
			if (!before.isFile() || before.size > 16 * 1024) return undefined;
			const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
			const record = parseAuthorityMutationLockRecord(value);
			const after = fstatSync(descriptor),
				named = lstatSync(path);
			if (
				record === undefined ||
				!named.isFile() ||
				named.isSymbolicLink() ||
				named.dev !== before.dev ||
				named.ino !== before.ino ||
				after.mtimeMs !== before.mtimeMs ||
				after.ctimeMs !== before.ctimeMs ||
				after.size !== before.size ||
				named.mtimeMs !== after.mtimeMs ||
				named.ctimeMs !== after.ctimeMs ||
				named.size !== after.size
			)
				return undefined;
			return { record, dev: before.dev, ino: before.ino };
		} finally {
			closeSync(descriptor);
		}
	} catch {
		return undefined;
	}
}

function syncDirectory(path: string): void {
	const descriptor = openSync(dirname(path), "r");

	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasErrorCode(error, "ESRCH");
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
