import type { GjcRuntimeLocations } from "../contracts";
import type { GjcSessionStorageLocations } from "../gjc/session-root";
import {
	closeIngressId,
	type SessionCloseResult,
	type SessionMapping,
	type SessionMappingStore,
} from "../gjc/session-router";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import { type SyncProjectSessionsResult, syncProjectSessionsToOpenWebUI } from "../projection/session-sync";
import type { AllowedRoot } from "../security/paths";
import {
	assertProjectsAdmitted,
	isProjectAllowed,
	isProjectPathValidationError,
	ProjectLinkError,
	sanitizeProjectInput,
} from "./project-admission";
import type {
	ProjectRegistration,
	ProjectRegistrationSource,
	SqliteProjectRegistrationStore,
} from "./registration-store";
import type { RegisteredProject, RegisterProjectDirectoryInput } from "./registry";
import { registerProjectDirectory } from "./registry";

export type { SessionCloseResult } from "../gjc/session-router";

export type ProjectSessionCloser = (
	mapping: SessionMapping,
	ingress: Readonly<{ ingressId: string; ingressHash: string }>,
) => Promise<SessionCloseResult>;

export interface ProjectLinkServiceOptions {
	readonly allowedRoots: readonly AllowedRoot[];
	readonly store: SqliteProjectRegistrationStore;
	readonly ownerUserId: string;
	readonly repository?: OpenWebUIProjectionRepository;
	readonly mappings?: SessionMappingStore;
	readonly protectedPaths: GjcRuntimeLocations["protectedProjectPaths"];
	readonly runtimeLocations?: GjcSessionStorageLocations;
	readonly closeSession?: ProjectSessionCloser;
}

export interface ProjectLinkResult {
	readonly project: ProjectRegistration;
	readonly sync: SyncProjectSessionsResult;
}

export interface ProjectUnlinkResult {
	readonly project: ProjectRegistration;
	readonly projectionRemoved: boolean;
	readonly closeResults: readonly { readonly chatId: string; readonly result: SessionCloseResult }[];
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
	readonly #protectedPaths: GjcRuntimeLocations["protectedProjectPaths"];
	readonly #runtimeLocations?: GjcSessionStorageLocations;
	readonly #closeSession?: ProjectSessionCloser;

	constructor(options: ProjectLinkServiceOptions) {
		this.#allowedRoots = options.allowedRoots;
		this.#store = options.store;
		this.#ownerUserId = options.ownerUserId;
		this.#repository = options.repository;
		this.#mappings = options.mappings;
		this.#protectedPaths = options.protectedPaths;
		this.#runtimeLocations = options.runtimeLocations;
		this.#closeSession = options.closeSession;
	}

	async seedConfiguredProjects(projects: readonly RegisteredProject[]): Promise<void> {
		await assertProjectsAdmitted(projects, this.#protectedPaths);
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
		await assertProjectsAdmitted([registered], this.#protectedPaths);
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
		const closeResults = await this.#closeProjectSessions(existing.id);
		const projectionRemoved = await this.#removeProjection(existing);
		const project = this.#store.unlinkProject(existing.id);
		if (project === undefined) throw new Error(`Failed to unlink project registration: ${existing.id}`);
		return { project, projectionRemoved, closeResults };
	}

	listProjects(): readonly ProjectRegistration[] {
		return this.#store.listProjects().filter(project => isProjectAllowed(project, this.#allowedRoots));
	}

	listLinkedProjects(): readonly ProjectRegistration[] {
		return this.#store.listLinkedProjects().filter(project => isProjectAllowed(project, this.#allowedRoots));
	}

	async syncLinkedProjects(): Promise<SyncProjectSessionsResult> {
		if (this.#repository === undefined) return EMPTY_SYNC_RESULT;
		const sync = await syncProjectSessionsToOpenWebUI({
			repository: this.#repository,
			ownerUserId: this.#ownerUserId,
			projects: this.listLinkedProjects(),
			mappings: this.#mappings,
			runtimeLocations: this.#runtimeLocations,
		});
		for (const folder of sync.folders) {
			const project = this.#store.getProject(folder.projectId);
			if (project !== undefined && project.openWebUIFolderId !== folder.folderId) {
				this.#store.updateOpenWebUIFolderId(project.id, folder.folderId);
			}
		}
		return sync;
	}
	async syncLinkedProject(projectId: string): Promise<SyncProjectSessionsResult> {
		const project = this.listLinkedProjects().find(candidate => candidate.id === projectId);
		if (project === undefined) throw new Error(`Linked project is unavailable for projection: ${projectId}`);
		if (this.#repository === undefined) throw new Error("OpenWebUI projection repository is not configured");
		return await this.#syncProject(project);
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
			runtimeLocations: this.#runtimeLocations,
		});
	}

	async #closeProjectSessions(
		projectId: string,
	): Promise<readonly { readonly chatId: string; readonly result: SessionCloseResult }[]> {
		if (this.#closeSession === undefined || this.#mappings === undefined) return [];
		return await Promise.all(
			this.#mappings
				.entries()
				.filter(mapping => mapping.projectId === projectId)
				.map(async mapping => {
					try {
						return {
							chatId: mapping.chatId,
							result: await this.#closeSession!(mapping, {
								ingressId: closeIngressId(`project-unlink:${projectId}`, mapping),
								ingressHash: `project-unlink:${projectId}`,
							}),
						};
					} catch (error) {
						if (error instanceof Error && error.message.includes("conflicts")) throw error;
						return {
							chatId: mapping.chatId,
							result: {
								status: "uncertain",
								message:
									error instanceof Error
										? error.message
										: "GJC session close acknowledgement was not received.",
							},
						};
					}
				}),
		);
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
	#restoreAfterFailedLink(projectId: string, previous: ProjectRegistration | undefined): void {
		if (previous?.status === "linked") {
			this.#store.linkProject(previous, previous.source);
			return;
		}
		this.#store.unlinkProject(previous?.id ?? projectId);
	}
}

export { assertProjectsAdmitted, ProjectLinkError } from "./project-admission";
