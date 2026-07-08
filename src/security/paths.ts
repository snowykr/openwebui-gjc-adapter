import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AllowedRoot {
	readonly input: string;
	readonly realPath: string;
}

export async function resolveAllowedRoots(roots: readonly string[]): Promise<AllowedRoot[]> {
	const allowedRoots: AllowedRoot[] = [];
	for (const root of roots) {
		const realPath = await fs.realpath(path.resolve(root));
		allowedRoots.push({ input: root, realPath });
	}
	return allowedRoots;
}

export async function assertPathInsideAllowedRoots(
	targetPath: string,
	allowedRoots: readonly AllowedRoot[],
): Promise<string> {
	if (allowedRoots.length === 0) {
		throw new Error("No allowed artifact roots configured");
	}

	const resolvedTargetPath = await resolveExistingOrProspectivePath(targetPath);
	for (const allowedRoot of allowedRoots) {
		if (isPathInsideRoot(resolvedTargetPath, allowedRoot.realPath)) {
			return resolvedTargetPath;
		}
	}

	throw new Error(`Path is outside allowed artifact roots: ${targetPath}`);
}

export async function assertArtifactPathAllowed(
	targetPath: string,
	allowedRoots: readonly AllowedRoot[],
): Promise<string> {
	return assertPathInsideAllowedRoots(targetPath, allowedRoots);
}

async function resolveExistingOrProspectivePath(targetPath: string): Promise<string> {
	const absoluteTargetPath = path.resolve(targetPath);
	try {
		return await fs.realpath(absoluteTargetPath);
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
	}

	const segments = splitAbsolutePath(absoluteTargetPath);
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const parentCandidate = path.join(...segments.slice(0, index + 1));
		try {
			const realParent = await fs.realpath(parentCandidate);
			const missingSuffix = segments.slice(index + 1);
			return path.resolve(realParent, ...missingSuffix);
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error;
			}
		}
	}

	throw new Error(`No existing parent found for path: ${targetPath}`);
}

function splitAbsolutePath(absolutePath: string): string[] {
	const parsedPath = path.parse(absolutePath);
	const relativePath = path.relative(parsedPath.root, absolutePath);
	return [parsedPath.root, ...relativePath.split(path.sep).filter(segment => segment.length > 0)];
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
