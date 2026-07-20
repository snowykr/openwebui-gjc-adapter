import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GjcRuntimeLocations } from "../contracts";

export type GjcSessionStorageLocations = Readonly<Pick<GjcRuntimeLocations, "home" | "agentDir">>;
export type GjcSessionRootResolver = (cwd: string) => string;

export function resolveGjcSdkSessionRoot(cwd: string, locations: GjcSessionStorageLocations): string {
	const canonicalCwd = resolveEquivalentPath(cwd);
	const home = resolveEquivalentPath(locations.home);
	const tempRoot = resolveEquivalentPath(tmpdir());
	const encodedDirName = pathIsWithin(home, canonicalCwd)
		? encodeRelativeSessionDirName("-", home, canonicalCwd)
		: pathIsWithin(tempRoot, canonicalCwd)
			? encodeRelativeSessionDirName("-tmp", tempRoot, canonicalCwd)
			: encodeAbsoluteSessionDirName(canonicalCwd);
	return path.join(locations.agentDir, "sessions", encodedDirName);
}

export function resolveEffectiveGjcSessionRoot(
	cwd: string,
	fallback: string,
	resolver: GjcSessionRootResolver | undefined,
): string {
	return resolver?.(cwd) ?? fallback;
}

function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return realpathSync(resolvedPath);
	} catch (error) {
		if (isNotFoundError(error)) return resolvedPath;
		throw error;
	}
}

function pathIsWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function encodeRelativeSessionDirName(prefix: string, root: string, cwd: string): string {
	const relative = path.relative(root, cwd).replace(/[/\\:]/g, "-");
	return relative.length === 0 ? prefix : `${prefix}${prefix.endsWith("-") ? "" : "-"}${relative}`;
}

function encodeAbsoluteSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
