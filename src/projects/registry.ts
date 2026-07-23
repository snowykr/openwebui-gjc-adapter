import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AllowedRoot, assertPathInsideAllowedRoots } from "../security/paths";
import { ProjectPathAccessError } from "./project-admission";

export interface RegisteredProject {
	readonly id: string;
	readonly name: string;
	readonly openWebUIFolderName?: string;
	readonly cwd: string;
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

export interface ProjectFolderMetadata {
	readonly gjc_adapter: {
		readonly projectId: string;
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
	const idCounts = new Map<string, number>();
	const nameCounts = new Map<string, number>();
	for (const project of projects) {
		idCounts.set(project.id, (idCounts.get(project.id) ?? 0) + 1);
		nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
	}
	const withDisambiguatedNames = projects.map(project => {
		if ((nameCounts.get(project.name) ?? 0) <= 1) return project;
		return { ...project, openWebUIFolderName: disambiguatedFolderName(project) };
	});
	const folderNameCounts = new Map<string, number>();
	for (const project of withDisambiguatedNames) {
		const folderName = project.openWebUIFolderName ?? project.name;
		folderNameCounts.set(folderName, (folderNameCounts.get(folderName) ?? 0) + 1);
	}

	return withDisambiguatedNames.map(project => {
		const id =
			(idCounts.get(project.id) ?? 0) <= 1 ? project.id : `${project.id}-${projectPathFingerprint(project.cwd)}`;
		const folderName = project.openWebUIFolderName ?? project.name;
		const openWebUIFolderName =
			(folderNameCounts.get(folderName) ?? 0) <= 1
				? folderName
				: `${folderName} ${projectPathFingerprint(project.cwd)}`;
		return { ...project, id, openWebUIFolderName };
	});
}

export async function registerProjectDirectory(
	input: RegisterProjectDirectoryInput,
	allowedRoots: readonly AllowedRoot[],
	now: Date = new Date(),
): Promise<RegisteredProject> {
	const cwd = await canonicalProjectPath(
		input.cwd,
		allowedRoots,
		`Project directory is not readable/searchable: ${path.resolve(input.cwd)}`,
	);
	const requestedSessionRoot = input.sessionRoot ?? path.join(cwd, ".gjc", "sessions");
	const sessionRoot = await canonicalProjectPath(
		requestedSessionRoot,
		allowedRoots,
		`Session root is not readable/writable/searchable: ${path.resolve(requestedSessionRoot)}`,
	);
	await assertProjectDirectoryAccess(cwd);
	await assertSessionRootWritable(sessionRoot);
	const id = createProjectId(input.name ?? cwd);
	const allowedRoot = findAllowedRoot(cwd, allowedRoots);

	return {
		id,
		name: input.name ?? path.basename(cwd),
		openWebUIFolderName: input.name ?? path.basename(cwd),
		cwd,
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
			projectName: project.name,
		},
	};
}
async function canonicalProjectPath(
	targetPath: string,
	allowedRoots: readonly AllowedRoot[],
	permissionMessage: string,
): Promise<string> {
	try {
		return await assertPathInsideAllowedRoots(targetPath, allowedRoots);
	} catch (error) {
		if (isPermissionDenied(error)) throw new ProjectPathAccessError(permissionMessage, error);
		throw error;
	}
}

async function assertProjectDirectoryAccess(cwd: string): Promise<void> {
	try {
		const stats = await fs.stat(cwd);
		if (!stats.isDirectory()) throw new Error("not a directory");
		await fs.access(cwd, constants.R_OK | constants.X_OK);
	} catch {
		throw new ProjectPathAccessError(`Project directory is not readable/searchable: ${cwd}`);
	}
}

async function assertSessionRootWritable(sessionRoot: string): Promise<void> {
	try {
		await assertDirectoryAccess(sessionRoot, constants.R_OK | constants.W_OK | constants.X_OK);
		return;
	} catch (error) {
		if (!isNotFoundError(error)) throw sessionRootAccessError(sessionRoot);
	}

	let ancestor = path.dirname(sessionRoot);
	while (true) {
		try {
			await assertDirectoryAccess(ancestor, constants.W_OK | constants.X_OK);
			return;
		} catch (error) {
			if (!isNotFoundError(error)) throw sessionRootAccessError(sessionRoot);
			const parent = path.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
	}

	throw sessionRootAccessError(sessionRoot);
}

async function assertDirectoryAccess(directory: string, mode: number): Promise<void> {
	const stats = await fs.stat(directory);
	if (!stats.isDirectory()) throw new Error("not a directory");
	await fs.access(directory, mode);
}

function sessionRootAccessError(sessionRoot: string): Error {
	return new ProjectPathAccessError(`Session root is not readable/writable/searchable: ${sessionRoot}`);
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPermissionDenied(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
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

function disambiguatedFolderName(project: RegisteredProject): string {
	return `${project.name} (${projectFolderLabel(project)})`;
}

function projectFolderLabel(project: RegisteredProject): string {
	const relativePath = path.relative(project.allowedRoot, project.cwd);
	if (relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
		return relativePath;
	}
	return projectPathFingerprint(project.cwd);
}
