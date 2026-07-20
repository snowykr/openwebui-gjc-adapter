import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	createReadStream,
	createWriteStream,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { link, mkdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RegisteredProject } from "../projects/registry";
import { resolveExistingOrProspectivePath } from "./session-file-path";
import { decodeSessionHeader } from "./session-transcript-decoder";
import { getProjectSessionRoot } from "./turn-runner";
export class SessionFileBoundaryError extends Error {
	override readonly name = "SessionFileBoundaryError";
}
/**
 * A no-follow descriptor held across a descriptor-dependent effect.
 *
 * The child is deliberately given `canonicalPath`, not a parent-process descriptor path:
 * tmux does not prove inherited descriptor ownership.  A pathname replacement
 * after launch is therefore reported as uncertain and the exactly-owned pane is
 * cleaned up.
 */
export interface OpenedRegularSessionFile {
	readonly canonicalPath: string;
	readonly descriptor: number;
	close(): void;
}

export function openAbsoluteRegularSessionFile(sessionFile: string): OpenedRegularSessionFile {
	if (!isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) {
		throw new SessionFileBoundaryError(`GJC session path must be an absolute .jsonl file: ${sessionFile}`);
	}
	const canonicalPath = resolve(sessionFile);
	const descriptor = openSync(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile())
			throw new SessionFileBoundaryError(`Stored GJC session path is not a regular file: ${sessionFile}`);
		let closed = false;
		return {
			canonicalPath,
			descriptor,
			close: () => {
				if (!closed) {
					closed = true;
					closeSync(descriptor);
				}
			},
		};
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

/**
 * Proves both the held descriptor and the originally selected name still identify one regular file.
 * Call immediately before launch and again after launch before any prompt is injected.
 */
export function revalidateOpenedRegularSessionFile(opened: OpenedRegularSessionFile): void {
	const held = fstatSync(opened.descriptor);
	if (!held.isFile())
		throw new SessionFileBoundaryError(
			`Held GJC session descriptor is no longer a regular file: ${opened.canonicalPath}`,
		);
	const currentDescriptor = openSync(opened.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const current = fstatSync(currentDescriptor);
		if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino) {
			throw new SessionFileBoundaryError(`GJC session path changed during CLI resume: ${opened.canonicalPath}`);
		}
	} finally {
		closeSync(currentDescriptor);
	}
}

export function validateSessionFile(
	project: RegisteredProject,
	sessionFile: string | undefined,
	sessionRoot: string = getProjectSessionRoot(project),
): string | undefined {
	if (sessionFile === undefined) return undefined;
	return validatePathWithinRoot(sessionFile, sessionRoot);
}
/**
 * Reopens the canonical path and proves it remains a regular file under the
 * approved root immediately before a descriptor-dependent effect.
 */
export function rereadValidatedSessionFile(
	project: RegisteredProject,
	sessionFile: string,
	sessionRoot: string = getProjectSessionRoot(project),
): string {
	const canonical = validateSessionFile(project, sessionFile, sessionRoot);
	if (canonical === undefined) throw new SessionFileBoundaryError("Session file is required.");
	const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(descriptor).isFile())
			throw new SessionFileBoundaryError(`Stored GJC session path is not a regular file: ${sessionFile}`);
		return validatePathWithinRoot(canonical, sessionRoot);
	} finally {
		closeSync(descriptor);
	}
}

export async function ensureSdkSessionFile(
	project: RegisteredProject,
	sessionFile: string | undefined,
	sdkSessionRoot: string,
	expectedLegacySessionId?: string,
): Promise<string | undefined> {
	if (sessionFile === undefined) return undefined;
	try {
		return validateSessionFile(project, sessionFile, sdkSessionRoot);
	} catch (error) {
		if (!(error instanceof SessionFileBoundaryError)) throw error;
		const legacyFile = validateExplicitLegacySessionFile(project, sessionFile, expectedLegacySessionId);
		if (legacyFile === undefined) throw error;
		try {
			return await copyLegacySessionFile(legacyFile, sdkSessionRoot);
		} finally {
			legacyFile.close();
		}
	}
}

function validatePathWithinRoot(sessionFile: string, sessionRoot: string): string {
	const resolvedSessionRoot = resolveExistingOrProspectivePath(sessionRoot);
	const resolvedSessionFile = resolveExistingOrProspectivePath(sessionFile);
	const relativeSessionFile = relative(resolvedSessionRoot, resolvedSessionFile);
	if (relativeSessionFile.length === 0 || relativeSessionFile.startsWith("..") || isAbsolute(relativeSessionFile)) {
		throw new SessionFileBoundaryError(
			`Stored GJC session file is not a file within project session root: ${sessionFile}`,
		);
	}
	return resolvedSessionFile;
}

function validateExplicitLegacySessionFile(
	project: RegisteredProject,
	sessionFile: string,
	expectedSessionId: string | undefined,
): OpenedRegularSessionFile | undefined {
	if (expectedSessionId === undefined || expectedSessionId.trim().length === 0) return undefined;
	let legacyPath: string;
	try {
		legacyPath = validateSessionFile(project, sessionFile) ?? "";
	} catch (error) {
		if (error instanceof SessionFileBoundaryError) return undefined;
		throw error;
	}
	if (legacyPath.length === 0) return undefined;

	let opened: OpenedRegularSessionFile;
	try {
		opened = openAbsoluteRegularSessionFile(sessionFile);
	} catch {
		return undefined;
	}
	let accepted = false;
	try {
		const headerBytes = Buffer.alloc(1024 * 1024);
		const bytesRead = readSync(opened.descriptor, headerBytes, 0, headerBytes.length, 0);
		const headerLine = headerBytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
		if (headerLine === undefined) return undefined;
		const header = decodeSessionHeader(JSON.parse(headerLine));
		if (
			header?.version !== 3 ||
			header.id !== expectedSessionId ||
			realpathSync(header.cwd) !== realpathSync(project.cwd)
		)
			return undefined;
		revalidateOpenedRegularSessionFile(opened);
		accepted = true;
		return opened;
	} catch {
		return undefined;
	} finally {
		if (!accepted) opened.close();
	}
}
async function copyLegacySessionFile(source: OpenedRegularSessionFile, sdkSessionRoot: string): Promise<string> {
	const canonicalRoot = resolveExistingOrProspectivePath(sdkSessionRoot);
	await mkdir(canonicalRoot, { recursive: true });
	const target = resolve(canonicalRoot, basename(source.canonicalPath));
	const temporary = join(canonicalRoot, `.${basename(source.canonicalPath)}.${randomUUID()}.migration`);
	try {
		revalidateOpenedRegularSessionFile(source);
		await pipeline(
			createReadStream("", { fd: source.descriptor, autoClose: false }),
			createWriteStream(temporary, { flags: "wx" }),
		);
		try {
			await link(temporary, target);
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
			const existingTarget = validatePathWithinRoot(target, canonicalRoot);
			if ((await hashFile(temporary)) !== (await hashFile(existingTarget))) {
				throw new Error(`SDK session migration target already contains different data: ${target}`);
			}
		}
		return validatePathWithinRoot(target, canonicalRoot);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
