import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isAlreadyExists, parseAuthorityMutationLockRecord } from "./session-authority-validation";
import type { AuthorityMutationLockRecord } from "./session-authority-types";

const LEASE_MS = 30_000;
const RECOVERY_ATTEMPTS = 3;

/** An owner-bound lease; stale recovery moves a verified expired record before removal. */
export class AuthorityMutationLock {
	private constructor(
		private readonly path: string,
		private readonly record: AuthorityMutationLockRecord,
	) {}

	static acquire(authorityPath: string): AuthorityMutationLock {
		const path = `${authorityPath}.lock`;
		mkdirSync(dirname(path), { recursive: true });

		for (let attempt = 0; attempt <= RECOVERY_ATTEMPTS; attempt += 1) {
			const record = createLockRecord();

			try {
				writeNewLock(path, record);
				return new AuthorityMutationLock(path, record);
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

	release(): void {
		const current = readLock(this.path);
		if (
			current === undefined
			|| current.owner !== this.record.owner
			|| current.leaseExpiresAt !== this.record.leaseExpiresAt
		) {
			throw new Error("Session authority mutation lease ownership changed before release.");
		}

		unlinkSync(this.path);
		syncDirectory(this.path);
	}
}

function createLockRecord(): AuthorityMutationLockRecord {
	return {
		owner: randomUUID(),
		pid: process.pid,
		leaseExpiresAt: Date.now() + LEASE_MS,
	};
}

function writeNewLock(path: string, record: AuthorityMutationLockRecord): void {
	const descriptor = openSync(path, "wx", 0o600);

	try {
		writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
		fsyncSync(descriptor);
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
		moved === undefined
		|| moved.owner !== current.owner
		|| moved.leaseExpiresAt !== current.leaseExpiresAt
		|| moved.leaseExpiresAt > Date.now()
	) {
		throw new Error("Refusing to recover an unverifiable authority lease.");
	}

	unlinkSync(recovered);
	syncDirectory(path);
	return true;
}

function readLock(path: string): AuthorityMutationLockRecord | undefined {
	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const contents = readFileSync(path, "utf8");
		const value: unknown = JSON.parse(contents);
		return parseAuthorityMutationLockRecord(value);
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
	return (
		typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as { code?: unknown }).code === code
	);
}
