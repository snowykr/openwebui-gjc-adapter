import { createHash } from "node:crypto";
import * as path from "node:path";
import { type AllowedRoot, assertPathInsideAllowedRoots } from "../security/paths";

export interface RegisteredProject {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly modelId: `gjc/${string}`;
	readonly openWebUIFolderId?: string;
	readonly allowedRoot: string;
	readonly sessionRoot?: string;
	readonly createdAt: Date;
}

export interface RegisterProjectDirectoryInput {
	readonly cwd: string;
	readonly name?: string;
	readonly openWebUIFolderId?: string;
	readonly sessionRoot?: string;
}

export interface OpenAIModelListEntry {
	readonly id: string;
	readonly object: "model";
	readonly created: number;
	readonly owned_by: "gjc";
}

export interface ProjectFolderMetadata {
	readonly gjc_adapter: {
		readonly projectId: string;
		readonly modelId: string;
		readonly projectName: string;
	};
}

export function createProjectId(nameOrCwd: string): string {
	const parsedPath = path.parse(nameOrCwd);
	const sourceName = parsedPath.base.length > 0 ? parsedPath.base : nameOrCwd;
	const slug = sourceName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return slug.length > 0 ? slug : "project";
}

export function disambiguateRegisteredProjects(projects: readonly RegisteredProject[]): readonly RegisteredProject[] {
	const counts = new Map<string, number>();
	for (const project of projects) {
		counts.set(project.id, (counts.get(project.id) ?? 0) + 1);
	}
	return projects.map(project => {
		if ((counts.get(project.id) ?? 0) <= 1) return project;
		const id = `${project.id}-${projectPathFingerprint(project.cwd)}`;
		return { ...project, id, modelId: `gjc/${id}` };
	});
}

export async function registerProjectDirectory(
	input: RegisterProjectDirectoryInput,
	allowedRoots: readonly AllowedRoot[],
	now: Date = new Date(),
): Promise<RegisteredProject> {
	const cwd = await assertPathInsideAllowedRoots(input.cwd, allowedRoots);
	const sessionRoot = await assertPathInsideAllowedRoots(
		input.sessionRoot ?? path.join(cwd, ".gjc", "sessions"),
		allowedRoots,
	);
	const id = createProjectId(input.name ?? cwd);
	const allowedRoot = findAllowedRoot(cwd, allowedRoots);

	return {
		id,
		name: input.name ?? path.basename(cwd),
		cwd,
		modelId: `gjc/${id}`,
		openWebUIFolderId: input.openWebUIFolderId,
		sessionRoot,
		allowedRoot,
		createdAt: new Date(now),
	};
}

export function buildProjectFolderMetadata(project: RegisteredProject): ProjectFolderMetadata {
	return {
		gjc_adapter: {
			projectId: project.id,
			modelId: project.modelId,
			projectName: project.name,
		},
	};
}

export function listProjectModels(projects: readonly RegisteredProject[]): OpenAIModelListEntry[] {
	return projects.map(project => ({
		id: project.modelId,
		object: "model",
		created: Math.floor(project.createdAt.getTime() / 1000),
		owned_by: "gjc",
	}));
}

function findAllowedRoot(cwd: string, allowedRoots: readonly AllowedRoot[]): string {
	const matchingRoot = allowedRoots.find(allowedRoot => isPathInsideRoot(cwd, allowedRoot.realPath));
	if (matchingRoot === undefined) {
		throw new Error(`Path is outside allowed artifact roots: ${cwd}`);
	}
	return matchingRoot.realPath;
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function projectPathFingerprint(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 8);
}
