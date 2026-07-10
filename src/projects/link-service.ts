import * as path from "node:path";
import type { SessionMappingStore } from "../gjc/session-router";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import { type SyncProjectSessionsResult, syncProjectSessionsToOpenWebUI } from "../projection/session-sync";
import type { AllowedRoot } from "../security/paths";
import type {
	ProjectRegistration,
	ProjectRegistrationSource,
	SqliteProjectRegistrationStore,
} from "./registration-store";
import type { RegisteredProject, RegisterProjectDirectoryInput } from "./registry";
import { registerProjectDirectory } from "./registry";

export interface ProjectLinkServiceOptions {
	readonly allowedRoots: readonly AllowedRoot[];
	readonly store: SqliteProjectRegistrationStore;
	readonly ownerUserId: string;
	readonly repository?: OpenWebUIProjectionRepository;
	readonly mappings?: SessionMappingStore;
}

export interface ProjectLinkResult {
	readonly project: ProjectRegistration;
	readonly sync: SyncProjectSessionsResult;
}

export interface ProjectUnlinkResult {
	readonly project: ProjectRegistration;
	readonly projectionRemoved: boolean;
}

export interface ProjectReconcileResult {
	readonly checked: number;
	readonly unlinked: readonly ProjectRegistration[];
}

export interface ProjectReconcileInput {
	readonly projectIds?: ReadonlySet<string>;
}

const EMPTY_SYNC_RESULT: SyncProjectSessionsResult = { folders: [], imported: [], skipped: [] };

export class ProjectLinkService {
	readonly #allowedRoots: readonly AllowedRoot[];
	readonly #store: SqliteProjectRegistrationStore;
	readonly #ownerUserId: string;
	readonly #repository?: OpenWebUIProjectionRepository;
	readonly #mappings?: SessionMappingStore;

	constructor(options: ProjectLinkServiceOptions) {
		this.#allowedRoots = options.allowedRoots;
		this.#store = options.store;
		this.#ownerUserId = options.ownerUserId;
		this.#repository = options.repository;
		this.#mappings = options.mappings;
	}

	seedConfiguredProjects(projects: readonly RegisteredProject[]): void {
		this.#store.seedConfiguredProjects(projects);
	}

	async linkProject(
		input: RegisterProjectDirectoryInput,
		source: ProjectRegistrationSource = "admin",
	): Promise<ProjectLinkResult> {
		let registered: RegisteredProject;
		try {
			registered = await registerProjectDirectory(sanitizeProjectInput(input, source), this.#allowedRoots);
		} catch (error) {
			if (isProjectPathValidationError(error)) {
				throw new ProjectLinkError(error.message, "invalid_project_link");
			}
			throw error;
		}
		const previous = this.#store.getProject(registered.cwd);
		let project = this.#store.linkProject(registered, source);
		try {
			const sync = await this.#syncProject(project);
			const syncedFolder = sync.folders.find(folder => folder.projectId === project.id);
			if (syncedFolder !== undefined && syncedFolder.folderId !== project.openWebUIFolderId) {
				project = this.#store.updateOpenWebUIFolderId(project.id, syncedFolder.folderId);
			}
			return { project, sync };
		} catch (error) {
			this.#restoreAfterFailedLink(project.id, previous);
			throw error;
		}
	}

	async unlinkProject(projectIdOrCwd: string): Promise<ProjectUnlinkResult> {
		const existing = this.#store.getProject(projectIdOrCwd);
		if (existing === undefined) {
			throw new ProjectLinkError(`Project is not registered: ${projectIdOrCwd}`, "project_not_found");
		}
		const projectionRemoved = await this.#removeProjection(existing);
		const project = this.#store.unlinkProject(existing.id);
		if (project === undefined) throw new Error(`Failed to unlink project registration: ${existing.id}`);
		return { project, projectionRemoved };
	}

	listProjects(): readonly ProjectRegistration[] {
		return this.#store.listProjects().filter(project => this.#isProjectAllowed(project));
	}

	listLinkedProjects(): readonly ProjectRegistration[] {
		return this.#store.listLinkedProjects().filter(project => this.#isProjectAllowed(project));
	}

	async syncLinkedProjects(): Promise<SyncProjectSessionsResult> {
		if (this.#repository === undefined) return EMPTY_SYNC_RESULT;
		const sync = await syncProjectSessionsToOpenWebUI({
			repository: this.#repository,
			ownerUserId: this.#ownerUserId,
			projects: this.listLinkedProjects(),
			mappings: this.#mappings,
		});
		for (const folder of sync.folders) {
			const project = this.#store.getProject(folder.projectId);
			if (project !== undefined && project.openWebUIFolderId !== folder.folderId) {
				this.#store.updateOpenWebUIFolderId(project.id, folder.folderId);
			}
		}
		return sync;
	}

	async reconcileOpenWebUIFolderLinks(input: ProjectReconcileInput = {}): Promise<ProjectReconcileResult> {
		const getFolder = this.#repository?.getFolder;
		if (getFolder === undefined) return { checked: 0, unlinked: [] };
		let checked = 0;
		const unlinked: ProjectRegistration[] = [];
		for (const project of this.listLinkedProjects()) {
			if (input.projectIds !== undefined && !input.projectIds.has(project.id)) continue;
			if (project.openWebUIFolderId === undefined) continue;
			checked += 1;
			const folder = await getFolder.call(this.#repository, this.#ownerUserId, project.openWebUIFolderId);
			if (folder !== undefined) continue;
			const updated = this.#store.unlinkProject(project.id);
			if (updated === undefined) throw new Error(`Failed to unlink project registration: ${project.id}`);
			unlinked.push(updated);
		}
		return { checked, unlinked };
	}

	async #syncProject(project: ProjectRegistration): Promise<SyncProjectSessionsResult> {
		if (this.#repository === undefined) return EMPTY_SYNC_RESULT;
		return await syncProjectSessionsToOpenWebUI({
			repository: this.#repository,
			ownerUserId: this.#ownerUserId,
			projects: [project],
			mappings: this.#mappings,
		});
	}

	async #removeProjection(project: ProjectRegistration): Promise<boolean> {
		const deleteFolder = this.#repository?.deleteFolder;
		if (deleteFolder === undefined) return false;
		const folderId = project.openWebUIFolderId ?? `gjc-project-${project.id}`;
		await deleteFolder.call(this.#repository, this.#ownerUserId, folderId, {
			deleteContents: true,
			expectedProjectId: project.id,
		});
		return true;
	}

	#isProjectAllowed(project: ProjectRegistration): boolean {
		return this.#allowedRoots.some(root => isPathInsideRoot(project.cwd, root.realPath));
	}

	#restoreAfterFailedLink(projectId: string, previous: ProjectRegistration | undefined): void {
		if (previous?.status === "linked") {
			this.#store.linkProject(previous, previous.source);
			return;
		}
		this.#store.unlinkProject(previous?.id ?? projectId);
	}
}

export class ProjectLinkError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "ProjectLinkError";
		this.code = code;
	}
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = path.relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function sanitizeProjectInput(
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

function isProjectPathValidationError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.message.includes("outside allowed artifact roots") ||
			error.message.includes("No allowed artifact roots configured") ||
			error.message.includes("No existing parent found for path"))
	);
}
