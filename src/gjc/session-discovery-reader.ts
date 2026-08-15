import { execFile as execFileCb } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
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
	if (process.platform === "linux") {
		// On Linux the held descriptor's real path proves the candidate did not
		// escape the session root through a symlink opened before the lstat check.
		const heldPath = await realpath(`/proc/self/fd/${handle.fd}`);
		if (!isContained(root, heldPath))
			throw corruptFile(filePath, `GJC session candidate escapes session root through a symlink: ${filePath}`);
		return;
	}
	// Portable hosts have no /proc/self/fd. The previous probe (reopen
	// /dev/fd/<fd> and compare dev/ino + lstat current path) only proved the
	// descriptor is stable, not that it is inside the root: an attacker can
	// open an external file through a temporary symlink, restore the in-root
	// directory with a hard link to the same inode, and satisfy both checks
	// while the held file remains outside the root. Instead prove the
	// descriptor's canonical location is inside the root via a descriptor-
	// based facility, or fail closed where none is available.
	const heldPath = await heldDescriptorPath(handle.fd);
	if (heldPath === null)
		throw corruptFile(
			filePath,
			`GJC session candidate cannot be proven inside session root on this platform: ${filePath}`,
		);
	let canonicalHeld: string;
	try {
		canonicalHeld = await realpath(heldPath);
	} catch {
		canonicalHeld = heldPath;
	}
	if (!isContained(root, canonicalHeld))
		throw corruptFile(filePath, `GJC session candidate escapes session root through a symlink: ${filePath}`);
}

const execFile = promisify(execFileCb);

async function heldDescriptorPath(fd: number): Promise<string | null> {
	// Darwin/macOS: resolve the descriptor's true pathname. F_GETPATH (50) is
	// the canonical facility, but Node has no binding; use lsof which reports
	// the same kernel pathname (validated above to agree with the held file's
	// dev/ino via the caller's stat checks). If lsof is unavailable, fail
	// closed per the review requirement.
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFile("lsof", ["-F", "n", "-p", String(process.pid), "-a", "-d", String(fd)], {
				timeout: 1000,
			});
			for (const line of stdout.split("\n")) {
				if (line.startsWith("n")) {
					const candidate = line.slice(1).trim();
					if (candidate.length > 0) return candidate;
				}
			}
		} catch {
			// lsof unavailable or failed — fall through to null (fail closed).
		}
		return null;
	}
	// Other non-Linux hosts: no portable descriptor-path facility is wired;
	// fail closed so an out-of-root hard-link attack cannot pass.
	return null;
}

/**
 * Verifies every path component from the root down to the file is a real
 * directory (or the terminal file) with no symlink, closing the descriptor-proof
 * gap on platforms without /proc/self/fd. A component swapped for a symlink
 * between this check and open() is caught by the post-open realpath and the
 * device/inode identity comparison.
 */
async function assertNoSymlinkComponents(root: string, filePath: string): Promise<void> {
	// Walk the ORIGINAL path components (not a realpath-resolved parent): a
	// component that is a symlink initially resolving inside root would be
	// erased by realpath before the lstat walk, so the symlink-free
	// precondition for skipping descriptor containment would not be
	// established. Verify the canonical parent stays inside the canonical
	// root, then lstat each ORIGINAL segment (from the root down) so a symlink
	// swapped in before open() is rejected.
	const parent = dirname(filePath);
	const resolvedParent = await realpath(parent);
	if (!isContained(root, resolvedParent)) throw corruptFile(filePath, "outside root");
	// How many segments of the ORIGINAL path belong to the root prefix? The
	// canonical parent may be spelled differently (macOS /var -> /private/var),
	// so compute the root-relative depth from the canonical forms, then apply
	// that depth to the original path's segments.
	const fromRoot = relative(root, resolvedParent);
	const depthUnderRoot = fromRoot === "." ? 0 : fromRoot.split(sep).filter(segment => segment.length > 0).length;
	const pathSegments = filePath.split(sep).filter(segment => segment.length > 0);
	const rootPrefixLength = pathSegments.length - depthUnderRoot - 1;
	if (rootPrefixLength < 0) throw corruptFile(filePath, "outside root");
	let current = root;
	for (let index = rootPrefixLength; index < pathSegments.length; index += 1) {
		current = `${current}${sep}${pathSegments[index]}`;
		const stats = await lstat(current);
		if (stats.isSymbolicLink()) {
			// Mirror the ELOOP errno a symlinked path would produce when the
			// descriptor is reopened, so callers (coldResume) keep reporting the
			// same failure signature for a path swapped after being opened.
			const errno = Object.assign(new Error(`ELOOP: too many levels of symbolic links, lstat '${current}'`), {
				code: "ELOOP",
				errno: -62,
				syscall: "lstat",
				path: current,
			});
			throw new GjcSessionLoadError(
				filePath,
				[{ code: "corrupt_session_file", message: errno.message, filePath }],
				errno,
			);
		}
		if (index < pathSegments.length - 1 && !stats.isDirectory())
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
