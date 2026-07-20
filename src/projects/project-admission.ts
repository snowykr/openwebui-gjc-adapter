import * as path from "node:path";
import type { GjcRuntimeLocations } from "../contracts";
import { pathsOverlap, resolveExistingOrProspectivePath } from "../security/paths";
import type { AllowedRoot } from "../security/paths";
import type { ProjectRegistrationSource } from "./registration-store";
import type { RegisterProjectDirectoryInput, RegisteredProject } from "./registry";

export class ProjectLinkError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "ProjectLinkError";
		this.code = code;
	}
}

export async function assertProjectsAdmitted(
	projects: readonly RegisteredProject[],
	protectedPaths: GjcRuntimeLocations["protectedProjectPaths"],
): Promise<void> {
	const canonicalProtectedPaths = await Promise.all(protectedPaths.map(resolveExistingOrProspectivePath));
	for (const project of projects) {
		const candidatePaths = project.sessionRoot === undefined ? [project.cwd] : [project.cwd, project.sessionRoot];
		for (const candidatePath of candidatePaths) {
			const canonicalCandidatePath = await resolveExistingOrProspectivePath(candidatePath);
			if (canonicalProtectedPaths.some(protectedPath => pathsOverlap(canonicalCandidatePath, protectedPath))) {
				throw new ProjectLinkError(
					"Project paths must not overlap protected GJC runtime paths.",
					"invalid_project_link",
				);
			}
		}
	}
}

export function isProjectAllowed(project: RegisteredProject, allowedRoots: readonly AllowedRoot[]): boolean {
	return allowedRoots.some(root => isPathInsideRoot(project.cwd, root.realPath));
}

export function sanitizeProjectInput(
	input: RegisterProjectDirectoryInput,
	source: ProjectRegistrationSource,
): RegisterProjectDirectoryInput {
	if (source !== "admin") return input;
	return {
		cwd: input.cwd,
		...(input.name === undefined ? {} : { name: input.name }),
		...(input.sessionRoot === undefined ? {} : { sessionRoot: input.sessionRoot }),
	};
}

export function isProjectPathValidationError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.message.includes("outside allowed artifact roots") ||
			error.message.includes("No allowed artifact roots configured") ||
			error.message.includes("No existing parent found for path"))
	);
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
