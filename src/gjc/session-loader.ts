import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadHeldGjcSessionFile } from "./session-discovery-reader";
import { GjcSessionLoadError, type LoadedGjcSessionFile } from "./session-loader-contract";

export type {
	GjcSessionLoadDiagnostic,
	GjcSessionLoadDiagnosticCode,
	LoadedGjcSessionFile,
} from "./session-loader-contract";
export { GjcSessionLoadError } from "./session-loader-contract";

/** Validates an absolute canonical JSONL selector without deriving a session identity. */
export function validateAbsoluteGjcSessionPath(filePath: string): string {
	if (!isAbsolute(filePath) || !filePath.endsWith(".jsonl")) {
		throw new GjcSessionLoadError(filePath, [
			{
				code: "invalid_session_header",
				message: `GJC session path must be an absolute .jsonl file: ${filePath}`,
				filePath,
			},
		]);
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
	const names = await readSessionRoot(root);
	const matches: LoadedGjcSessionFile[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const candidate = join(root, name);
		if (baselinePaths.has(candidate)) continue;
		try {
			const loaded = await loadHeldGjcSessionFile(root, validateGjcSessionPathWithinRoot(root, candidate));
			if (loaded.header.id === expectedSessionId && loaded.header.cwd === expectedCwd) matches.push(loaded);
		} catch {
			// An unrelated partial/corrupt transcript cannot prove this attachment.
		}
	}
	if (matches.length !== 1) {
		throw new GjcSessionLoadError(root, [
			{
				code: "corrupt_session_file",
				message: `Expected exactly one fresh JSONL transcript for CLI session ${expectedSessionId} in ${expectedCwd}; found ${matches.length}`,
				filePath: root,
			},
		]);
	}
	return matches[0]!;
}
export async function waitForFreshGjcSessionFile(
	sessionRoot: string,
	baselinePaths: ReadonlySet<string>,
	expectedSessionId: string,
	expectedCwd: string,
	timeoutMs = 1_000,
): Promise<LoadedGjcSessionFile> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await discoverFreshGjcSessionFile(sessionRoot, baselinePaths, expectedSessionId, expectedCwd);
		} catch (error) {
			if (!isMissingFreshTranscript(error) || Date.now() >= deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
		}
	}
}

function isMissingFreshTranscript(error: unknown): error is GjcSessionLoadError {
	return (
		error instanceof GjcSessionLoadError &&
		error.diagnostics.length === 1 &&
		error.diagnostics[0]?.code === "corrupt_session_file" &&
		error.diagnostics[0].message.endsWith("found 0")
	);
}

export async function snapshotGjcSessionFiles(sessionRoot: string): Promise<ReadonlySet<string>> {
	const root = await canonicalGjcSessionRoot(sessionRoot);
	const names = await readSessionRoot(root);
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
	if (
		pathFromRoot.length === 0 ||
		pathFromRoot === ".." ||
		pathFromRoot.startsWith(`..${"/"}`) ||
		isAbsolute(pathFromRoot)
	) {
		throw new GjcSessionLoadError(filePath, [
			{
				code: "invalid_session_header",
				message: `GJC session path must be within session root ${root}: ${filePath}`,
				filePath,
			},
		]);
	}
	return canonicalPath;
}

function validateAbsoluteGjcSessionRoot(sessionRoot: string): string {
	if (!isAbsolute(sessionRoot)) {
		throw new GjcSessionLoadError(sessionRoot, [
			{ code: "invalid_session_header", message: "GJC session root must be absolute", filePath: sessionRoot },
		]);
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

async function readSessionRoot(root: string): Promise<string[]> {
	try {
		return await readdir(root);
	} catch (error) {
		throw new GjcSessionLoadError(
			root,
			[{ code: "corrupt_session_file", message: `Cannot read GJC session root ${root}`, filePath: root }],
			error,
		);
	}
}

export async function loadGjcSessionFile(filePath: string): Promise<LoadedGjcSessionFile> {
	const candidate = validateAbsoluteGjcSessionPath(filePath);
	return loadHeldGjcSessionFile(dirname(candidate), candidate);
}
