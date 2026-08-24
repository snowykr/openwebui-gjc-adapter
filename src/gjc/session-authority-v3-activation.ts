import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FileSessionAuthority } from "./session-authority-persistence";
import {
	encodeSessionAuthorityV3Document,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
} from "./session-authority-v3";
import { type ManagedTurnAuthorityBinding, stageSessionAuthorityV3Migration } from "./session-authority-v3-migration";
import { V3FileBackedSessionMappingStore } from "./session-v3-file-backed-mapping-store";

const MAX_AUTHORITY_BYTES = 128 * 1024 * 1024;
const MAX_WAL_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export type SessionAuthorityV3ActivationBoundary = "snapshot" | "backup" | "stage" | "swap" | "marker";

export interface SessionAuthorityV3ActivationOptions {
	/** The V2 canonical authority. Its mutation and runtime locks are held by the caller. */
	readonly canonicalPath: string;
	/** Exact, managed authority identities; no runtime-derived authority is consulted. */
	readonly bindings: readonly ManagedTurnAuthorityBinding[];
	/** Private adapter-owned directory. It must not be the canonical authority directory. */
	readonly stagingRoot: string;
	/** Test-only crash seam, called only after the named boundary is durable. */
	readonly afterBoundary?: (boundary: SessionAuthorityV3ActivationBoundary) => void;
}

export interface SessionAuthorityV3ActiveMarker {
	readonly kind: "openwebui-gjc-session-authority-active";
	readonly version: 1;
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
	readonly canonicalDigest: string;
	readonly source: Readonly<{
		baseDigest: string;
		walDigest: string;
		walPresent: boolean;
	}>;
}

export interface SessionAuthorityV3ActivationResult {
	readonly status: "activated" | "blocked";
	readonly canonicalPath: string;
	readonly markerPath: string;
	readonly markerDigest?: string;
	readonly canonicalDigest?: string;
	readonly reasons?: readonly string[];
}

export function readSessionAuthorityV3ActiveMarker(canonicalPath: string): SessionAuthorityV3ActiveMarker | undefined {
	return readMarker(`${resolve(canonicalPath)}.v3-active.json`);
}

/**
 * Converts the canonical V2 authority while its runtime and authority-mutation
 * locks are already held. The only files it opens are the authority, its WAL,
 * and private activation files; it never inspects user workspaces, transcripts,
 * or artifacts.
 */
export function activateSessionAuthorityV3(
	options: SessionAuthorityV3ActivationOptions,
): SessionAuthorityV3ActivationResult {
	const canonicalPath = resolve(options.canonicalPath);
	const root = privateRoot(options.stagingRoot, canonicalPath);
	const markerPath = `${canonicalPath}.v3-active.json`;
	const journalPath = join(root, "activation.json");

	const recovered = recover(canonicalPath, markerPath, root, journalPath);
	if (recovered !== undefined) return recovered;

	const snapshot = snapshotV2(canonicalPath);
	options.afterBoundary?.("snapshot");
	writePrivate(root, "source.v2.json", snapshot.base);
	if (snapshot.walPresent) writePrivate(root, "source.v2.wal", snapshot.wal);
	writePrivate(
		root,
		"source.v2.absence.json",
		Buffer.from(`${JSON.stringify({ walPresent: snapshot.walPresent })}\n`),
	);
	fsyncDirectory(root);
	options.afterBoundary?.("backup");

	const privateV2 = join(root, "replay.v2.json");
	writePrivate(root, "replay.v2.json", snapshot.base);
	if (snapshot.walPresent) writePrivate(root, "replay.v2.json.wal", snapshot.wal);
	const replayed = new FileSessionAuthority(privateV2);
	const staged = stageSessionAuthorityV3Migration({
		snapshot: {
			originalBaseBytes: snapshot.base,
			originalBaseDigest: snapshot.baseDigest,
			originalWalBytes: snapshot.wal,
			originalWalDigest: snapshot.walDigest,
		},
		decodedDocument: {
			mappings: replayed.entries(),
			provisionalOperations: replayed.provisionalEntries(),
		},
		bindings: options.bindings,
	});
	if (staged.status === "blocked") {
		return { status: "blocked", canonicalPath, markerPath, reasons: staged.reasons };
	}
	const parsed = parseSessionAuthorityV3Document(staged.v3Bytes);
	if (parsed === undefined) throw new Error("V3 transformer produced an invalid authority document.");
	const canonicalBytes = Buffer.from(staged.v3Bytes);
	if (!Buffer.from(encodeSessionAuthorityV3Document(parsed)).equals(canonicalBytes))
		throw new Error("V3 transformer did not produce deterministic canonical bytes.");
	const stagePath = join(root, "canonical.v3.json");
	writePrivate(root, "canonical.v3.json", canonicalBytes);
	// Reopening is deliberately against the private copy. It proves the strict V3
	// mapping store accepts the deterministic bytes before the canonical swap.
	const store = new V3FileBackedSessionMappingStore(stagePath);
	store.close();
	const reopened = readRegular(stagePath, MAX_AUTHORITY_BYTES, "staged V3 authority");
	if (!reopened.equals(canonicalBytes)) throw new Error("Reopening the V3 authority changed its deterministic bytes.");

	const journal: ActivationJournal = {
		kind: "openwebui-gjc-session-authority-v3-activation",
		version: 1,
		phase: "prepared",
		canonicalDigest: staged.v3Digest,
		source: { baseDigest: snapshot.baseDigest, walDigest: snapshot.walDigest, walPresent: snapshot.walPresent },
	};
	writePrivate(root, "activation.json", encode(journal));
	fsyncDirectory(root);
	options.afterBoundary?.("stage");

	writePrivate(root, "activation.json", encode({ ...journal, phase: "committing" }));
	fsyncDirectory(root);
	renameSync(stagePath, canonicalPath);
	const canonicalWalPath = `${canonicalPath}.wal`;
	const canonicalWal = lstatSync(canonicalWalPath, { throwIfNoEntry: false });
	if (canonicalWal?.isFile()) unlinkSync(canonicalWalPath);
	fsyncDirectory(dirname(canonicalPath));
	writePrivate(root, "activation.json", encode({ ...journal, phase: "swapped" }));
	fsyncDirectory(root);
	options.afterBoundary?.("swap");

	const marker: SessionAuthorityV3ActiveMarker = {
		kind: "openwebui-gjc-session-authority-active",
		version: 1,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		canonicalDigest: staged.v3Digest,
		source: journal.source,
	};
	writeAtomic(markerPath, encode(marker));
	fsyncDirectory(dirname(markerPath));
	writePrivate(root, "activation.json", encode({ ...journal, phase: "marked" }));
	fsyncDirectory(root);
	options.afterBoundary?.("marker");
	return activated(canonicalPath, markerPath, marker);
}

function recover(
	canonicalPath: string,
	markerPath: string,
	root: string,
	journalPath: string,
): SessionAuthorityV3ActivationResult | undefined {
	const marker = readMarker(markerPath);
	if (marker !== undefined && markerMatchesCanonical(marker, canonicalPath))
		return activated(canonicalPath, markerPath, marker);
	const journal = readJournal(journalPath);
	if (journal === undefined) return undefined;
	if (journal.phase === "marked")
		throw new Error("Activation journal is marked but the active marker does not bind the canonical V3 authority.");
	if (journal.phase === "committing" || journal.phase === "swapped") {
		const base = readRegular(join(root, "source.v2.json"), MAX_AUTHORITY_BYTES, "immutable V2 backup");
		if (digest(base) !== journal.source.baseDigest)
			throw new Error("Immutable V2 backup digest does not match activation journal.");
		renameReplace(join(root, "restore.v2.json"), canonicalPath, base);
		const walPath = `${canonicalPath}.wal`;
		if (journal.source.walPresent) {
			const wal = readRegular(join(root, "source.v2.wal"), MAX_WAL_BYTES, "immutable V2 WAL backup");
			if (digest(wal) !== journal.source.walDigest)
				throw new Error("Immutable V2 WAL backup digest does not match activation journal.");
			renameReplace(join(root, "restore.v2.wal"), walPath, wal);
		} else {
			const named = lstatSync(walPath, { throwIfNoEntry: false });
			if (named?.isFile()) unlinkSync(walPath);
		}
		fsyncDirectory(dirname(canonicalPath));
	}
	return undefined;
}

function snapshotV2(canonicalPath: string): {
	base: Buffer;
	wal: Buffer;
	walPresent: boolean;
	baseDigest: string;
	walDigest: string;
} {
	const base = readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "canonical V2 authority");
	fsyncRegular(canonicalPath, "canonical V2 authority");
	const walPath = `${canonicalPath}.wal`;
	const walNamed = lstatSync(walPath, { throwIfNoEntry: false });
	if (walNamed?.isSymbolicLink() || (walNamed !== undefined && !walNamed.isFile()))
		throw new Error("Canonical V2 WAL is not a regular file.");
	const walPresent = walNamed !== undefined;
	const wal = walPresent ? readRegular(walPath, MAX_WAL_BYTES, "canonical V2 WAL") : Buffer.alloc(0);
	if (walPresent) fsyncRegular(walPath, "canonical V2 WAL");
	fsyncDirectory(dirname(canonicalPath));
	return { base, wal, walPresent, baseDigest: digest(base), walDigest: digest(wal) };
}

function privateRoot(stagingRoot: string, canonicalPath: string): string {
	const root = resolve(stagingRoot, `session-authority-v3-${digest(canonicalPath).slice(0, 16)}`);
	if (root === dirname(canonicalPath) || canonicalPath.startsWith(`${root}/`))
		throw new Error("Activation staging root must be private and outside the canonical authority path.");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const named = lstatSync(root);
	if (!named.isDirectory() || named.isSymbolicLink())
		throw new Error("Activation staging root is not a private directory.");
	if (statSync(root).dev !== statSync(dirname(canonicalPath)).dev)
		throw new Error("Activation staging root must share a filesystem with the canonical authority.");
	return root;
}

function readRegular(path: string, maximum: number, label: string): Buffer {
	const named = lstatSync(path, { throwIfNoEntry: false });
	if (named === undefined || named.isSymbolicLink() || !named.isFile())
		throw new Error(`${label} is not a regular file.`);
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = statHeld(descriptor, label, maximum);
		const bytes = Buffer.alloc(before.size);
		for (let offset = 0; offset < bytes.length; ) {
			const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
			if (count === 0) throw new Error(`${label} changed while it was read.`);
			offset += count;
		}
		const after = statHeld(descriptor, label, maximum);
		const current = lstatSync(path, { throwIfNoEntry: false });
		if (
			after.size !== before.size ||
			current === undefined ||
			current.dev !== before.dev ||
			current.ino !== before.ino
		)
			throw new Error(`${label} changed while it was read.`);
		return bytes;
	} finally {
		closeSync(descriptor);
	}
}

function statHeld(descriptor: number, label: string, maximum: number) {
	const stat = fstatSync(descriptor);
	if (!stat.isFile() || stat.size > maximum) throw new Error(`${label} is not a bounded regular file.`);
	return stat;
}

function writePrivate(root: string, name: string, bytes: Buffer): void {
	const path = join(root, name);
	if (dirname(path) !== root) throw new Error("Activation attempted to write outside its private staging root.");
	writeAtomic(path, bytes);
}

function writeAtomic(path: string, bytes: Buffer): void {
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary was renamed or was never created.
		}
	}
}

function renameReplace(temporary: string, destination: string, bytes: Buffer): void {
	writeAtomic(temporary, bytes);
	renameSync(temporary, destination);
}
function fsyncRegular(path: string, label: string): void {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!statHeld(descriptor, label, MAX_AUTHORITY_BYTES).isFile()) throw new Error(`${label} is not regular.`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function encode(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`);
}
function digest(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}
function readMarker(path: string): SessionAuthorityV3ActiveMarker | undefined {
	try {
		const value: unknown = JSON.parse(readRegular(path, 16 * 1024, "active V3 marker").toString("utf8"));
		return isMarker(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
function markerMatchesCanonical(marker: SessionAuthorityV3ActiveMarker, canonicalPath: string): boolean {
	try {
		return (
			digest(readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "canonical V3 authority")) === marker.canonicalDigest
		);
	} catch {
		return false;
	}
}
function activated(
	canonicalPath: string,
	markerPath: string,
	marker: SessionAuthorityV3ActiveMarker,
): SessionAuthorityV3ActivationResult {
	return {
		status: "activated",
		canonicalPath,
		markerPath,
		canonicalDigest: marker.canonicalDigest,
		markerDigest: digest(encode(marker)),
	};
}

type ActivationJournal = Readonly<{
	kind: "openwebui-gjc-session-authority-v3-activation";
	version: 1;
	phase: "prepared" | "committing" | "swapped" | "marked";
	canonicalDigest: string;
	source: SessionAuthorityV3ActiveMarker["source"];
}>;
function readJournal(path: string): ActivationJournal | undefined {
	try {
		const value: unknown = JSON.parse(readRegular(path, 16 * 1024, "activation journal").toString("utf8"));
		if (!isJournal(value)) throw new Error("Invalid activation journal.");
		return value;
	} catch {
		return undefined;
	}
}
function isMarker(value: unknown): value is SessionAuthorityV3ActiveMarker {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const marker = value as Partial<SessionAuthorityV3ActiveMarker>;
	return (
		marker.kind === "openwebui-gjc-session-authority-active" &&
		marker.version === 1 &&
		marker.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		SHA256.test(marker.canonicalDigest ?? "") &&
		typeof marker.source === "object" &&
		marker.source !== null &&
		SHA256.test(marker.source.baseDigest ?? "") &&
		SHA256.test(marker.source.walDigest ?? "") &&
		typeof marker.source.walPresent === "boolean"
	);
}
function isJournal(value: unknown): value is ActivationJournal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const journal = value as Partial<ActivationJournal>;
	return (
		journal.kind === "openwebui-gjc-session-authority-v3-activation" &&
		journal.version === 1 &&
		(journal.phase === "prepared" ||
			journal.phase === "committing" ||
			journal.phase === "swapped" ||
			journal.phase === "marked") &&
		SHA256.test(journal.canonicalDigest ?? "") &&
		isMarker({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			canonicalDigest: journal.canonicalDigest,
			source: journal.source,
		})
	);
}
