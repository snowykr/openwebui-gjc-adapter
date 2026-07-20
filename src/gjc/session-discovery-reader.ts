import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
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
	const heldPath = await realpath(`/proc/self/fd/${handle.fd}`);
	if (!isContained(root, heldPath))
		throw corruptFile(filePath, `GJC session candidate escapes session root through a symlink: ${filePath}`);
}

async function assertRealpathContained(root: string, filePath: string): Promise<void> {
	const parent = await realpath(dirname(filePath));
	if (!isContained(root, parent))
		throw corruptFile(filePath, `GJC session candidate escapes session root through a symlink: ${filePath}`);
}

function isContained(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith(`..${"/"}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}
