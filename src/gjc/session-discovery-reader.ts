import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import type { SessionEntry, SessionHeader } from "@gajae-code/coding-agent";
import { GjcSessionLoadError, type LoadedGjcSessionFile } from "./session-loader-contract";
import { decodeSessionEntry, decodeSessionHeader } from "./session-transcript-decoder";

const MAX_DISCOVERY_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_DISCOVERY_SESSION_LINE_BYTES = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function loadHeldGjcSessionFile(sessionRoot: string, filePath: string): Promise<LoadedGjcSessionFile> {
	let handle: FileHandle | undefined;
	try {
		const root = await canonicalSessionRoot(sessionRoot);
		// Reject any symlink in the path BEFORE opening: a non-Linux host has no
		// /proc/self/fd descriptor proof, so an intermediate symlink swapped in
		// before open() would let the held descriptor escape the root while the
		// post-open pathname checks still pass (TOCTOU). Every component must be
		// a real directory (or the terminal file) with no symlink.
		await assertNoSymlinkComponents(root, filePath);
		await assertRealpathContained(root, filePath);
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		await assertHeldDescriptorContained(root, filePath, handle);
		const held = await handle.stat();
		if (!held.isFile()) throw corruptFile(filePath, `GJC session candidate is not a regular file: ${filePath}`);
		if (held.size > MAX_DISCOVERY_SESSION_BYTES)
			throw corruptFile(filePath, `GJC session candidate exceeds the discovery size limit: ${filePath}`);
		const loaded = parseHeldGjcSessionFile(filePath, await handle.readFile());
		await assertRealpathContained(root, filePath);
		const current = await readCurrentStat(filePath);
		if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino)
			throw corruptFile(filePath, `GJC session candidate changed while loading: ${filePath}`);
		return loaded;
	} catch (error) {
		if (error instanceof GjcSessionLoadError) throw error;
		throw new GjcSessionLoadError(
			filePath,
			[
				{
					code: "corrupt_session_file",
					message: `Cannot safely load GJC session file ${filePath}: ${loadFailureMessage(error)}`,
					filePath,
				},
			],
			error,
		);
	} finally {
		await handle?.close();
	}
}

async function readCurrentStat(filePath: string) {
	const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await handle.stat();
	} finally {
		await handle.close();
	}
}

function parseHeldGjcSessionFile(filePath: string, bytes: Uint8Array): LoadedGjcSessionFile {
	try {
		utf8Decoder.decode(bytes);
	} catch (error) {
		throw new GjcSessionLoadError(
			filePath,
			[{ code: "corrupt_session_file", message: `GJC session file is not valid UTF-8: ${filePath}`, filePath }],
			error,
		);
	}
	let header: SessionHeader | undefined;
	const entries: SessionEntry[] = [];
	let lineStart = 0;
	for (let index = 0; index <= bytes.length; index++) {
		if (index !== bytes.length && bytes[index] !== 0x0a) continue;
		const line = bytes.subarray(lineStart, index);
		lineStart = index + 1;
		if (line.length === 0 || (line.length === 1 && line[0] === 0x0d)) continue;
		if (line.length > MAX_DISCOVERY_SESSION_LINE_BYTES)
			throw corruptFile(filePath, `GJC session line exceeds the discovery size limit: ${filePath}`);
		let entry: unknown;
		try {
			entry = JSON.parse(utf8Decoder.decode(line));
		} catch (error) {
			throw new GjcSessionLoadError(
				filePath,
				[
					{
						code: "corrupt_session_file",
						message: `GJC session file contains invalid JSONL: ${filePath}`,
						filePath,
					},
				],
				error,
			);
		}
		if (!header) {
			header = decodeSessionHeader(entry);
			if (!header) throw invalidHeader(filePath, entry);
			continue;
		}
		const decoded = decodeSessionEntry(entry);
		if (!decoded) throw corruptFile(filePath, `GJC session file contains an invalid entry: ${filePath}`);
		entries.push(decoded);
	}
	if (!header)
		throw new GjcSessionLoadError(filePath, [
			{ code: "empty_session_file", message: `No valid GJC session entries found in ${filePath}`, filePath },
		]);
	return { filePath, header, entries, diagnostics: [] };
}

function corruptFile(filePath: string, message: string): GjcSessionLoadError {
	return new GjcSessionLoadError(filePath, [{ code: "corrupt_session_file", message, filePath }]);
}
function invalidHeader(filePath: string, value: unknown): GjcSessionLoadError {
	if (!isRecord(value) || value.type !== "session")
		return corruptFile(filePath, `GJC session file contains an invalid entry: ${filePath}`);
	if (typeof value.id !== "string" || value.id.trim().length === 0)
		return new GjcSessionLoadError(filePath, [
			{
				code: "invalid_session_header",
				message: `GJC session header in ${filePath} must contain a non-empty string id`,
				filePath,
			},
		]);
	if (typeof value.cwd !== "string" || value.cwd.trim().length === 0)
		return new GjcSessionLoadError(filePath, [
			{
				code: "invalid_session_header",
				message: `GJC session header in ${filePath} must contain a non-empty string cwd`,
				filePath,
			},
		]);
	return corruptFile(filePath, `GJC session file contains an invalid entry: ${filePath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function loadFailureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
async function canonicalSessionRoot(sessionRoot: string): Promise<string> {
	const root = await realpath(sessionRoot);
	if (!isAbsolute(root)) throw new Error(`GJC session root is not absolute: ${sessionRoot}`);
	return root;
}

async function assertHeldDescriptorContained(root: string, filePath: string, handle: FileHandle): Promise<void> {
	// On Linux the held descriptor's real path proves the candidate did not
	// escape the session root through a symlink opened before the lstat check.
	// Portable platforms lack /proc; assertNoSymlinkComponents() ran before
	// open() so every path component was verified real and symlink-free, and
	// the post-open stat identity check below still bounds the candidate.
	if (process.platform === "linux") {
		const heldPath = await realpath(`/proc/self/fd/${handle.fd}`);
		if (!isContained(root, heldPath))
			throw corruptFile(filePath, `GJC session candidate escapes session root through a symlink: ${filePath}`);
	}
}

/**
 * Verifies every path component from the root down to the file is a real
 * directory (or the terminal file) with no symlink, closing the descriptor-proof
 * gap on platforms without /proc/self/fd. A component swapped for a symlink
 * between this check and open() is caught by the post-open realpath and the
 * device/inode identity comparison.
 */
async function assertNoSymlinkComponents(root: string, filePath: string): Promise<void> {
	// Resolve the parent through realpath so a platform-equivalent spelling
	// (macOS /var -> /private/var) cannot make a legitimate in-root candidate
	// look like it escaped; the terminal file name is appended unchanged.
	const parent = await realpath(dirname(filePath));
	const canonicalCandidate = `${parent}${sep}${basename(filePath)}`;
	const fromRoot = relative(root, canonicalCandidate);
	if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot))
		throw corruptFile(filePath, "outside root");
	let current = root;
	const segments = fromRoot.split(sep).filter(segment => segment.length > 0);
	for (let index = 0; index < segments.length; index += 1) {
		current = `${current}${sep}${segments[index]}`;
		const stats = await lstat(current);
		if (stats.isSymbolicLink())
			throw corruptFile(filePath, `GJC session candidate path contains a symlink: ${current}`);
		if (index < segments.length - 1 && !stats.isDirectory())
			throw corruptFile(filePath, `GJC session candidate path contains a non-directory entry: ${current}`);
	}
}

async function assertRealpathContained(root: string, filePath: string): Promise<void> {
	const parent = await realpath(dirname(filePath));
	if (!isContained(root, parent))
		throw corruptFile(filePath, `GJC session candidate escapes session root through a symlink: ${filePath}`);
}

function isContained(root: string, candidate: string): boolean {
	// Component-based containment: relative() emits `..\` on Windows and `../`
	// elsewhere, so testing only a forward-slash prefix would let a traversal
	// candidate outside the root pass on Windows.
	const fromRoot = relative(root, candidate);
	if (fromRoot === "" || fromRoot === ".") return true;
	return !fromRoot.startsWith("..") && !isAbsolute(fromRoot) && !fromRoot.split(sep).includes("..");
}
