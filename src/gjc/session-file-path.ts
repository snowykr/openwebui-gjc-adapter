import { realpathSync } from "node:fs";
import { parse, relative, resolve, sep } from "node:path";

export function resolveExistingOrProspectivePath(targetPath: string): string {
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
