import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, realpathSync } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { RegisteredProject } from "../projects/registry";
import { getProjectSessionRoot } from "./rpc-runner";

class SessionFileBoundaryError extends Error {}

export function validateSessionFile(
	project: RegisteredProject,
	sessionFile: string | undefined,
	sessionRoot: string = getProjectSessionRoot(project),
): string | undefined {
	if (sessionFile === undefined) return undefined;
	return validatePathWithinRoot(sessionFile, sessionRoot);
}

export async function ensureSdkSessionFile(
	project: RegisteredProject,
	sessionFile: string | undefined,
	sdkSessionRoot: string,
): Promise<string | undefined> {
	if (sessionFile === undefined) return undefined;
	try {
		return validateSessionFile(project, sessionFile, sdkSessionRoot);
	} catch (error) {
		if (!(error instanceof SessionFileBoundaryError)) throw error;
		const legacyFile = validateSessionFile(project, sessionFile);
		if (legacyFile === undefined) throw error;
		return copyLegacySessionFile(legacyFile, sdkSessionRoot);
	}
}

function validatePathWithinRoot(sessionFile: string, sessionRoot: string): string {
	const resolvedSessionRoot = resolveExistingOrProspectivePath(sessionRoot);
	const resolvedSessionFile = resolveExistingOrProspectivePath(sessionFile);
	const relativeSessionFile = relative(resolvedSessionRoot, resolvedSessionFile);
	if (relativeSessionFile.startsWith("..") || isAbsolute(relativeSessionFile)) {
		throw new SessionFileBoundaryError(`Stored GJC session file is outside project session root: ${sessionFile}`);
	}
	return resolvedSessionFile;
}

async function copyLegacySessionFile(source: string, sdkSessionRoot: string): Promise<string> {
	const canonicalRoot = resolveExistingOrProspectivePath(sdkSessionRoot);
	await mkdir(canonicalRoot, { recursive: true });
	const target = resolve(canonicalRoot, basename(source));
	const temporary = join(canonicalRoot, `.${basename(source)}.${randomUUID()}.migration`);
	try {
		await copyFile(source, temporary, constants.COPYFILE_EXCL);
		try {
			await link(temporary, target);
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
			const existingTarget = validatePathWithinRoot(target, canonicalRoot);
			if ((await hashFile(source)) !== (await hashFile(existingTarget))) {
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

function resolveExistingOrProspectivePath(targetPath: string): string {
	const absoluteTargetPath = resolve(targetPath);
	try {
		return realpathSync(absoluteTargetPath);
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}

	const parsedPath = parse(absoluteTargetPath);
	const segments = [
		parsedPath.root,
		...relative(parsedPath.root, absoluteTargetPath)
			.split(sep)
			.filter(segment => segment.length > 0),
	];
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const parentCandidate = resolve(...segments.slice(0, index + 1));
		try {
			const realParent = realpathSync(parentCandidate);
			return resolve(realParent, ...segments.slice(index + 1));
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
		}
	}
	throw new Error(`No existing parent found for path: ${targetPath}`);
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
