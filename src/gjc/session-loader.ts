import type { SessionEntry, SessionHeader } from "@gajae-code/coding-agent";
import { loadEntriesFromFile } from "@gajae-code/coding-agent";
import { constants } from "node:fs";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
const MAX_DISCOVERY_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_DISCOVERY_SESSION_LINE_BYTES = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type GjcSessionLoadDiagnosticCode =
	| "missing_session_header"
	| "invalid_session_header"
	| "empty_session_file"
	| "corrupt_session_file";

export interface GjcSessionLoadDiagnostic {
	code: GjcSessionLoadDiagnosticCode;
	message: string;
	filePath: string;
}

export interface LoadedGjcSessionFile {
	filePath: string;
	header: SessionHeader;
	entries: SessionEntry[];
	diagnostics: GjcSessionLoadDiagnostic[];
}

export class GjcSessionLoadError extends Error {
	readonly filePath: string;
	readonly diagnostics: GjcSessionLoadDiagnostic[];
	readonly cause: unknown;

	constructor(filePath: string, diagnostics: GjcSessionLoadDiagnostic[], cause?: unknown) {
		super(diagnostics.map(diagnostic => diagnostic.message).join("; ") || `Failed to load GJC session file: ${filePath}`);
		this.name = "GjcSessionLoadError";
		this.filePath = filePath;
		this.diagnostics = diagnostics;
		this.cause = cause;
	}
}

/** Validates an absolute canonical JSONL selector without deriving a session identity. */
export function validateAbsoluteGjcSessionPath(filePath: string): string {
	if (!isAbsolute(filePath) || !filePath.endsWith(".jsonl")) {
		throw new GjcSessionLoadError(filePath, [{ code: "invalid_session_header", message: `GJC session path must be an absolute .jsonl file: ${filePath}`, filePath }]);
	}
	return resolve(filePath);
}

export async function loadAbsoluteGjcSessionFile(filePath: string): Promise<LoadedGjcSessionFile> {
	return loadGjcSessionFile(validateAbsoluteGjcSessionPath(filePath));
}

/**
 * Finds the one newly-created, validated session transcript whose immutable header
 * proves the CLI-reported session identity. Ambiguous discovery is deliberately an error.
 */
export async function discoverFreshGjcSessionFile(
	sessionRoot: string,
	baselinePaths: ReadonlySet<string>,
	expectedSessionId: string,
	expectedCwd: string,
): Promise<LoadedGjcSessionFile> {
	const root = await canonicalGjcSessionRoot(sessionRoot);
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		throw new GjcSessionLoadError(
			root,
			[{ code: "corrupt_session_file", message: `Cannot read GJC session root ${root}`, filePath: root }],
			error,
		);
	}
	const matches: LoadedGjcSessionFile[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const candidate = join(root, name);
		if (baselinePaths.has(candidate)) continue;
		try {
			const loaded = await loadProvenGjcSessionFile(root, candidate);
			if (loaded.header.id === expectedSessionId && loaded.header.cwd === expectedCwd) matches.push(loaded);
		} catch {
			// An unrelated partial/corrupt transcript cannot prove this attachment.
		}
	}
	if (matches.length !== 1) {
		throw new GjcSessionLoadError(
			root,
			[{
				code: "corrupt_session_file",
				message: `Expected exactly one fresh JSONL transcript for CLI session ${expectedSessionId} in ${expectedCwd}; found ${matches.length}`,
				filePath: root,
			}],
		);
	}
	return matches[0]!;
}

export async function snapshotGjcSessionFiles(sessionRoot: string): Promise<ReadonlySet<string>> {
	const root = await canonicalGjcSessionRoot(sessionRoot);
	let names: string[];
	try {
		names = await readdir(root);
	} catch (error) {
		throw new GjcSessionLoadError(
			root,
			[{ code: "corrupt_session_file", message: `Cannot read GJC session root ${root}`, filePath: root }],
			error,
		);
	}
	const paths = new Set<string>();
	for (const name of names) {
		if (name.endsWith(".jsonl")) paths.add(join(root, name));
	}
	return paths;
}

export function validateGjcSessionPathWithinRoot(sessionRoot: string, filePath: string): string {
	const root = validateAbsoluteGjcSessionRoot(sessionRoot);
	const canonicalPath = validateAbsoluteGjcSessionPath(filePath);
	const pathFromRoot = relative(root, canonicalPath);
	if (pathFromRoot.length === 0 || pathFromRoot === ".." || pathFromRoot.startsWith(`..${"/"}`) || isAbsolute(pathFromRoot)) {
		throw new GjcSessionLoadError(
			filePath,
			[{ code: "invalid_session_header", message: `GJC session path must be within session root ${root}: ${filePath}`, filePath }],
		);
	}
	return canonicalPath;
}

function validateAbsoluteGjcSessionRoot(sessionRoot: string): string {
	if (!isAbsolute(sessionRoot)) {
		throw new GjcSessionLoadError(
			sessionRoot,
			[{ code: "invalid_session_header", message: "GJC session root must be absolute", filePath: sessionRoot }],
		);
	}
	return resolve(sessionRoot);
}

async function canonicalGjcSessionRoot(sessionRoot: string): Promise<string> {
	const root = validateAbsoluteGjcSessionRoot(sessionRoot);
	try {
		return await realpath(root);
	} catch (error) {
		throw new GjcSessionLoadError(
			root,
			[{ code: "corrupt_session_file", message: `Cannot resolve GJC session root ${root}`, filePath: root }],
			error,
		);
	}
}

async function loadProvenGjcSessionFile(sessionRoot: string, filePath: string): Promise<LoadedGjcSessionFile> {
	const candidate = validateGjcSessionPathWithinRoot(sessionRoot, filePath);
	let handle: FileHandle | undefined;
	try {
		handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		const held = await handle.stat();
		if (!held.isFile()) {
			throw new GjcSessionLoadError(candidate, [{ code: "corrupt_session_file", message: `GJC session candidate is not a regular file: ${candidate}`, filePath: candidate }]);
		}
		if (held.size > MAX_DISCOVERY_SESSION_BYTES) {
			throw new GjcSessionLoadError(candidate, [{ code: "corrupt_session_file", message: `GJC session candidate exceeds the discovery size limit: ${candidate}`, filePath: candidate }]);
		}
		const loaded = parseHeldGjcSessionFile(candidate, await handle.readFile());
		const currentHandle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		const current = await (async () => {
			try {
				return await currentHandle.stat();
			} finally {
				await currentHandle.close();
			}
		})();
		if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino) {
			throw new GjcSessionLoadError(candidate, [{ code: "corrupt_session_file", message: `GJC session candidate changed while loading: ${candidate}`, filePath: candidate }]);
		}
		return loaded;
	} catch (error) {
		if (error instanceof GjcSessionLoadError) throw error;
		throw new GjcSessionLoadError(candidate, [{ code: "corrupt_session_file", message: `Cannot safely load GJC session file ${candidate}`, filePath: candidate }], error);
	} finally {
		await handle?.close();
	}
}

function parseHeldGjcSessionFile(filePath: string, bytes: Uint8Array): LoadedGjcSessionFile {
	try {
		utf8Decoder.decode(bytes);
	} catch (error) {
		throw new GjcSessionLoadError(filePath, [{ code: "corrupt_session_file", message: `GJC session file is not valid UTF-8: ${filePath}`, filePath }], error);
	}
	const entries: Array<SessionHeader | SessionEntry> = [];
	let lineStart = 0;
	for (let index = 0; index <= bytes.length; index++) {
		if (index !== bytes.length && bytes[index] !== 0x0a) continue;
		const line = bytes.subarray(lineStart, index);
		lineStart = index + 1;
		if (line.length === 0 || (line.length === 1 && line[0] === 0x0d)) continue;
		if (line.length > MAX_DISCOVERY_SESSION_LINE_BYTES) {
			throw new GjcSessionLoadError(filePath, [{ code: "corrupt_session_file", message: `GJC session line exceeds the discovery size limit: ${filePath}`, filePath }]);
		}
		let entry: unknown;
		try {
			entry = JSON.parse(utf8Decoder.decode(line));
		} catch (error) {
			throw new GjcSessionLoadError(filePath, [{ code: "corrupt_session_file", message: `GJC session file contains invalid JSONL: ${filePath}`, filePath }], error);
		}
		if (typeof entry !== "object" || entry === null || Array.isArray(entry) || typeof (entry as { type?: unknown }).type !== "string") {
			throw new GjcSessionLoadError(filePath, [{ code: "corrupt_session_file", message: `GJC session file contains an invalid entry: ${filePath}`, filePath }]);
		}
		entries.push(entry as SessionHeader | SessionEntry);
	}
	if (entries.length === 0) throw new GjcSessionLoadError(filePath, [{ code: "empty_session_file", message: `No valid GJC session entries found in ${filePath}`, filePath }]);
	const [firstEntry] = entries;
	if (firstEntry.type !== "session") throw new GjcSessionLoadError(filePath, [{ code: "missing_session_header", message: `GJC session file ${filePath} does not start with a session header`, filePath }]);
	if (typeof firstEntry.id !== "string" || firstEntry.id.trim().length === 0) {
		throw new GjcSessionLoadError(filePath, [{ code: "invalid_session_header", message: `GJC session header in ${filePath} must contain a non-empty string id`, filePath }]);
	}
	if (typeof firstEntry.cwd !== "string" || firstEntry.cwd.trim().length === 0) {
		throw new GjcSessionLoadError(filePath, [{ code: "invalid_session_header", message: `GJC session header in ${filePath} must contain a non-empty string cwd`, filePath }]);
	}
	return { filePath, header: firstEntry, entries: entries.slice(1) as SessionEntry[], diagnostics: [] };
}

export async function loadGjcSessionFile(filePath: string): Promise<LoadedGjcSessionFile> {
	try {
		const fileEntries = await loadEntriesFromFile(filePath);
		if (fileEntries.length === 0) throw new GjcSessionLoadError(filePath, [{ code: "empty_session_file", message: `No valid GJC session entries found in ${filePath}`, filePath }]);
		const [firstEntry] = fileEntries;
		const sessionEntries = fileEntries.slice(1) as SessionEntry[];
		if (firstEntry.type !== "session") throw new GjcSessionLoadError(filePath, [{ code: "missing_session_header", message: `GJC session file ${filePath} does not start with a session header`, filePath }]);
		if (typeof firstEntry.id !== "string" || firstEntry.id.trim().length === 0) {
			throw new GjcSessionLoadError(filePath, [{ code: "invalid_session_header", message: `GJC session header in ${filePath} must contain a non-empty string id`, filePath }]);
		}
		if (typeof firstEntry.cwd !== "string" || firstEntry.cwd.trim().length === 0) {
			throw new GjcSessionLoadError(filePath, [{ code: "invalid_session_header", message: `GJC session header in ${filePath} must contain a non-empty string cwd`, filePath }]);
		}
		return { filePath, header: firstEntry, entries: sessionEntries, diagnostics: [] };
	} catch (error) {
		if (error instanceof GjcSessionLoadError) throw error;
		throw new GjcSessionLoadError(filePath, [{ code: "corrupt_session_file", message: `Failed to load GJC session file ${filePath}`, filePath }], error);
	}
}
