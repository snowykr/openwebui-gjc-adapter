import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	type ManagedAuthorityActivationJournal,
	type ManagedAuthorityActivationLock,
	type ManagedAuthorityActivationManifest,
	type ManagedAuthorityActivationOwner,
	type ManagedAuthorityActivationStorage,
	managedAuthorityManifestDigest,
} from "./managed-authority-activation";

import {
	decodeManagedSessionAuthorityRecord,
	encodeManagedSessionAuthorityRecord,
	type ManagedSessionAuthorityRecord,
	managedSessionAuthorityHash,
} from "./managed-session-authority";
import { AuthorityMutationLock } from "./session-authority-file";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_WAL_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ManagedAuthorityFileStorageOptions {
	/** Adapter-owned state root. Source and every durable activation file must be below this root. */
	readonly stateRoot: string;
	/** The existing v2 authority database. Its optional WAL is `${sourcePath}.wal`. */
	readonly sourcePath: string;
}

/**
 * File-backed, deliberately narrow activation persistence. The layout is rooted
 * exclusively under `${stateRoot}/managed-authority-activation/<source hash>`;
 * it never enumerates user workspaces, session transcripts, or artifacts.
 */
export class ManagedAuthorityFileStorage implements ManagedAuthorityActivationStorage {
	readonly #stateRoot: string;
	readonly #sourcePath: string;
	readonly #sourceWalPath: string;
	readonly #root: string;
	readonly #journalPath: string;
	readonly #manifestPath: string;
	readonly #checkpointPath: string;
	readonly #canonicalPath: string;
	readonly #markerPath: string;
	readonly #backupPath: string;
	readonly #backupWalPath: string;
	readonly #stagedRoot: string;
	readonly #stagedWalPath: string;

	constructor(options: ManagedAuthorityFileStorageOptions) {
		this.#stateRoot = canonicalRoot(options.stateRoot);
		this.#sourcePath = checkedDescendant(this.#stateRoot, options.sourcePath, "source authority");
		this.#sourceWalPath = `${this.#sourcePath}.wal`;
		this.#root = join(this.#stateRoot, "managed-authority-activation", digest(this.#sourcePath).slice(0, 32));
		this.#journalPath = join(this.#root, "journal.json");
		this.#manifestPath = join(this.#root, "manifest.v3.json");
		this.#checkpointPath = join(this.#root, "checkpoint.v3.json");
		this.#canonicalPath = join(this.#root, "canonical.v3.json");
		this.#markerPath = join(this.#root, "active.v3.json");
		this.#backupPath = join(this.#root, "source.v2.json");
		this.#backupWalPath = join(this.#root, "source.v2.wal");
		this.#stagedRoot = join(this.#root, "staged.v3");
		this.#stagedWalPath = join(this.#stagedRoot, "authority.v3.wal");
	}

	async load(): Promise<ManagedAuthorityActivationJournal | undefined> {
		const journal = readJsonIfPresent(this.#journalPath, "activation journal");
		if (journal === undefined) {
			if (pathExists(this.#markerPath)) throw new Error("Active epoch marker exists without an activation journal.");
			return undefined;
		}
		assertJournal(journal);
		if (journal.activeMarker) {
			const marker = readJson(this.#markerPath, "active epoch marker");
			if (
				!isRecord(marker) ||
				marker.authorityEpoch !== journal.manifest.authorityEpoch ||
				marker.manifestDigest !== journal.manifest.digest
			)
				throw new Error("Active epoch marker does not match the activation journal.");
		}
		return journal;
	}

	async save(journal: ManagedAuthorityActivationJournal): Promise<void> {
		assertJournal(journal);
		this.#ensureLayout();
		writeAtomicJson(this.#journalPath, journal);
	}

	async backupSource(): Promise<void> {
		this.#ensureLayout();
		this.#assertSourcePath();
		const source = readRegular(this.#sourcePath, MAX_SOURCE_BYTES, "v2 source authority");
		assertV2Source(source, this.#sourcePath);
		const wal = readRegularIfPresent(this.#sourceWalPath, MAX_WAL_BYTES, "v2 source WAL") ?? Buffer.alloc(0);
		const journal = await this.load();
		if (journal !== undefined) {
			const expected = journal.manifest.checkpoint.digests;
			if (
				digest(source) !== expected.sourceDigest ||
				digest(source) !== expected.backupDigest ||
				digest(wal) !== expected.walDigest
			)
				throw new Error("The v2 source or WAL digest does not match the activation manifest.");
		}
		writeAtomic(this.#backupPath, source);
		writeAtomic(this.#backupWalPath, wal);
	}

	async fsyncBackup(): Promise<void> {
		fsyncRegular(this.#backupPath, "v2 source backup");
		fsyncRegular(this.#backupWalPath, "v2 WAL backup");
		fsyncDirectory(this.#root);
	}
	async fsyncSource(): Promise<void> {
		this.#assertSourcePath();
		fsyncRegular(this.#sourcePath, "v2 source authority");
		fsyncDirectory(dirname(this.#sourcePath));
		this.#assertCurrentSourceDigests();
	}
	async fsyncWal(): Promise<void> {
		this.#assertSourcePath();
		if (pathExists(this.#sourceWalPath)) fsyncRegular(this.#sourceWalPath, "v2 source WAL");
		fsyncDirectory(dirname(this.#sourceWalPath));
		this.#assertCurrentSourceDigests();
	}

	async writeManifest(manifest: ManagedAuthorityActivationManifest): Promise<void> {
		assertManifest(manifest);
		this.#ensureLayout();
		writeAtomicJson(this.#manifestPath, manifest);
		writeAtomicJson(this.#checkpointPath, manifest.checkpoint);
	}
	async fsyncManifest(): Promise<void> {
		fsyncRegular(this.#manifestPath, "activation manifest");
		fsyncRegular(this.#checkpointPath, "activation checkpoint");
		fsyncDirectory(this.#root);
	}

	async stageRecord(record: ManagedSessionAuthorityRecord): Promise<void> {
		const encoded = encodeManagedSessionAuthorityRecord(record);
		const identity = managedSessionAuthorityHash(record);
		this.#ensureLayout();
		writeAtomic(join(this.#stagedRoot, `${identity}.json`), Buffer.from(`${encoded}\n`));
		const existing = readRegularIfPresent(this.#stagedWalPath, MAX_JSON_BYTES, "staged v3 WAL") ?? Buffer.alloc(0);
		writeAtomic(this.#stagedWalPath, Buffer.concat([existing, Buffer.from(`${identity} ${encoded}\n`)]));
	}
	async fsyncStagedRecord(identity: string): Promise<void> {
		if (!SHA256.test(identity)) throw new TypeError("A SHA-256 staged authority identity is required.");
		fsyncRegular(join(this.#stagedRoot, `${identity}.json`), "staged v3 authority");
		fsyncRegular(this.#stagedWalPath, "staged v3 WAL");
		fsyncDirectory(this.#stagedRoot);
	}
	async fsyncCheckpoint(): Promise<void> {
		fsyncRegular(this.#checkpointPath, "activation checkpoint");
		fsyncDirectory(this.#root);
	}

	async replaceCanonical(): Promise<void> {
		const journal = await this.load();
		if (journal?.phase !== "committing") throw new Error("Canonical replacement requires a committing journal.");
		const manifest = readJson(this.#manifestPath, "activation manifest");
		assertManifest(manifest);
		if (manifest.digest !== journal.manifest.digest)
			throw new Error("Activation manifest changed before canonical replacement.");
		const records = journal.staged.map(identity => {
			if (!SHA256.test(identity)) throw new Error("Activation journal contains an invalid staged identity.");
			const record = decodeManagedSessionAuthorityRecord(
				readRegular(join(this.#stagedRoot, `${identity}.json`), MAX_JSON_BYTES, "staged v3 authority").toString(
					"utf8",
				),
			);
			if (managedSessionAuthorityHash(record) !== identity)
				throw new Error("Staged authority record digest mismatch.");
			return record;
		});
		if (new Set(journal.staged).size !== records.length)
			throw new Error("Activation journal contains duplicate staged records.");
		const canonical = {
			kind: "openwebui-gjc-session-authority",
			version: 3,
			authorityEpoch: manifest.authorityEpoch,
			digest: manifest.digest,
			records,
		};
		// This is the authoritative replacement, not a sidecar: writeAtomic fsyncs
		// the complete document, renames it over sourcePath, then fsyncs its parent.
		writeAtomicJson(this.#sourcePath, canonical);
		writeAtomicJson(this.#canonicalPath, canonical);
	}

	async canonicalReplacementState(): Promise<"replaced" | "not_replaced" | "uncertain"> {
		const journal = await this.load();
		if (journal === undefined) return "not_replaced";
		try {
			const canonical = readJsonIfPresent(this.#sourcePath, "canonical v3 authority");
			if (canonical === undefined) return "not_replaced";
			if (isRecord(canonical) && canonical.kind === "openwebui-gjc-session-authority" && canonical.version === 2)
				return "not_replaced";
			if (
				!isRecord(canonical) ||
				canonical.kind !== "openwebui-gjc-session-authority" ||
				canonical.version !== 3 ||
				canonical.digest !== journal.manifest.digest ||
				!Array.isArray(canonical.records)
			)
				return "uncertain";
			const records = canonical.records.map(record => decodeManagedSessionAuthorityRecord(record));
			const identities = records.map(managedSessionAuthorityHash);
			return sameSet(identities, journal.staged) ? "replaced" : "uncertain";
		} catch {
			return "uncertain";
		}
	}

	async writeActiveMarker(epoch: string, manifestDigest: string): Promise<void> {
		const journal = await this.load();
		if (
			journal === undefined ||
			!journal.canonicalReplaced ||
			epoch !== journal.manifest.authorityEpoch ||
			manifestDigest !== journal.manifest.digest
		)
			throw new Error("Active marker requires the exact replaced manifest.");
		const replacement = await this.canonicalReplacementState();
		if (replacement !== "replaced") throw new Error("Active marker requires a verified canonical v3 authority.");
		writeAtomicJson(this.#markerPath, { authorityEpoch: epoch, manifestDigest });
	}
	async fsyncActiveMarker(): Promise<void> {
		fsyncRegular(this.#markerPath, "active epoch marker");
		fsyncDirectory(this.#root);
	}

	async rollbackPreReplacement(): Promise<void> {
		// Never touch source v2/WAL or anything outside this adapter-owned root.
		for (const path of [
			this.#journalPath,
			this.#manifestPath,
			this.#checkpointPath,
			this.#canonicalPath,
			this.#markerPath,
		])
			removeOwnedRegular(path);
		removeOwnedDirectory(this.#stagedRoot);
		if (pathExists(this.#root)) fsyncDirectory(this.#root);
	}

	#ensureLayout(): void {
		ensurePrivateDirectory(this.#stateRoot, "adapter state root");
		ensurePrivateDirectory(dirname(this.#root), "managed authority activation root");
		ensurePrivateDirectory(this.#root, "managed authority activation state");
		ensurePrivateDirectory(this.#stagedRoot, "staged v3 authority root");
	}
	#assertCurrentSourceDigests(): void {
		this.#assertSourcePath();
		const journal = readJsonIfPresent(this.#journalPath, "activation journal");
		if (journal === undefined) return;
		assertJournal(journal);
		const source = readRegular(this.#sourcePath, MAX_SOURCE_BYTES, "v2 source authority");
		const wal = readRegularIfPresent(this.#sourceWalPath, MAX_WAL_BYTES, "v2 source WAL") ?? Buffer.alloc(0);
		const expected = journal.manifest.checkpoint.digests;
		if (
			digest(source) !== expected.sourceDigest ||
			digest(source) !== expected.backupDigest ||
			digest(wal) !== expected.walDigest
		)
			throw new Error("The v2 source or WAL changed after activation backup.");
	}
	#assertSourcePath(): void {
		assertNoSymlinkAncestors(this.#stateRoot, this.#sourcePath);
	}
}

/** Uses the existing authority-mutation lease, with inode revalidation at each coordinator seam. */
export class ManagedAuthorityFileOwner implements ManagedAuthorityActivationOwner {
	readonly #stateRoot: string;
	readonly #sourcePath: string;
	constructor(options: ManagedAuthorityFileStorageOptions) {
		const root = canonicalRoot(options.stateRoot);
		this.#stateRoot = root;
		this.#sourcePath = checkedDescendant(root, options.sourcePath, "source authority");
	}
	async acquire(): Promise<ManagedAuthorityActivationLock> {
		assertNoSymlinkAncestors(this.#stateRoot, this.#sourcePath);
		const held = AuthorityMutationLock.acquire(this.#sourcePath);
		const lockPath = `${this.#sourcePath}.lock`;
		const identity = regularIdentity(lockPath, "authority mutation lock");
		return {
			assertHeld: async () => {
				const current = regularIdentity(lockPath, "authority mutation lock");
				if (current.dev !== identity.dev || current.ino !== identity.ino)
					throw new Error("Managed authority activation lock ownership was lost.");
			},
			release: async () => held.release(),
		};
	}
}

function canonicalRoot(value: string): string {
	if (typeof value !== "string" || value.length === 0 || !isAbsolute(value))
		throw new TypeError("A canonical adapter state root is required.");
	const root = resolve(value);
	ensurePrivateDirectory(root, "adapter state root");
	if (realpathSync(root) !== root) throw new Error("Adapter state root must be canonical.");
	return root;
}
function checkedDescendant(root: string, value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0 || !isAbsolute(value))
		throw new TypeError(`An absolute ${label} path is required.`);
	const path = resolve(value);
	if (path === root || relative(root, path).startsWith("..") || isAbsolute(relative(root, path)))
		throw new Error(`${label} must be within the adapter state root.`);
	assertNoSymlinkAncestors(root, path);
	return path;
}
function assertNoSymlinkAncestors(root: string, path: string): void {
	let current = root;
	for (const part of relative(root, path).split("/")) {
		current = join(current, part);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (stat?.isSymbolicLink())
			throw new Error(`Managed authority path must not traverse a symbolic link: ${current}`);
	}
}
function ensurePrivateDirectory(path: string, label: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular directory.`);
}
function readRegular(path: string, maximum: number, label: string): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const held = fstatSync(fd);
		const named = lstatSync(path);
		if (!held.isFile() || named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino)
			throw new Error(`${label} must be an unchanged regular file.`);
		if (held.size > maximum) throw new Error(`${label} exceeds its bounded size.`);
		const bytes = readFileSync(fd);
		if (bytes.length !== held.size) throw new Error(`${label} changed while being read.`);
		return bytes;
	} finally {
		closeSync(fd);
	}
}
function readRegularIfPresent(path: string, maximum: number, label: string): Buffer | undefined {
	try {
		return readRegular(path, maximum, label);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
}
function fsyncRegular(path: string, label: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const held = fstatSync(fd);
		const named = lstatSync(path);
		if (!held.isFile() || named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino)
			throw new Error(`${label} must be an unchanged regular file.`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function fsyncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function writeAtomic(path: string, bytes: Buffer): void {
	ensurePrivateDirectory(dirname(path), "managed authority parent");
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	fsyncDirectory(dirname(path));
}
function writeAtomicJson(path: string, value: unknown): void {
	writeAtomic(path, Buffer.from(`${JSON.stringify(value)}\n`));
}
function readJson(path: string, label: string): unknown {
	const value = readJsonIfPresent(path, label);
	if (value === undefined) throw new Error(`${label} is missing.`);
	return value;
}
function readJsonIfPresent(path: string, label: string): unknown | undefined {
	const bytes = readRegularIfPresent(path, MAX_JSON_BYTES, label);
	if (bytes === undefined) return undefined;
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${label} is malformed.`);
	}
}
function removeOwnedRegular(path: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return;
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new Error(`Refusing to remove non-regular adapter-owned file: ${path}`);
	unlinkSync(path);
}
function removeOwnedDirectory(path: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) return;
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new Error(`Refusing to remove non-directory staged root: ${path}`);
	rmSync(path, { recursive: true, force: false });
}
function pathExists(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
function regularIdentity(path: string, label: string): { readonly dev: number; readonly ino: number } {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file.`);
	return { dev: stat.dev, ino: stat.ino };
}
function digest(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length && left.every(value => right.includes(value)) && new Set(left).size === left.length
	);
}
function assertV2Source(bytes: Buffer, path: string): void {
	try {
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (!isRecord(value) || value.kind !== "openwebui-gjc-session-authority" || value.version !== 2)
			throw new Error();
	} catch {
		throw new Error(`v2 source authority is not a valid v2 authority document: ${path}`);
	}
}
function assertManifest(value: unknown): asserts value is ManagedAuthorityActivationManifest {
	if (
		!isRecord(value) ||
		typeof value.digest !== "string" ||
		!SHA256.test(value.digest) ||
		!isRecord(value.checkpoint) ||
		!isRecord(value.checkpoint.digests)
	)
		throw new Error("Activation manifest is invalid.");
	if (
		value.digest !==
		managedAuthorityManifestDigest({
			authorityEpoch: value.authorityEpoch as ManagedAuthorityActivationManifest["authorityEpoch"],
			checkpoint: value.checkpoint as unknown as ManagedAuthorityActivationManifest["checkpoint"],
			records: value.records as ManagedAuthorityActivationManifest["records"],
		})
	)
		throw new Error("Activation manifest digest is invalid.");
}
function assertJournal(value: unknown): asserts value is ManagedAuthorityActivationJournal {
	if (
		!isRecord(value) ||
		!isRecord(value.manifest) ||
		typeof value.phase !== "string" ||
		!Array.isArray(value.staged) ||
		!value.staged.every(value => typeof value === "string" && SHA256.test(value)) ||
		!Array.isArray(value.items) ||
		!value.items.every(item => isRecord(item) && isRecord(item.intent) && typeof item.state === "string") ||
		typeof value.canonicalReplaced !== "boolean" ||
		typeof value.activeMarker !== "boolean"
	)
		throw new Error("Activation journal is invalid.");
	assertManifest(value.manifest);
}
