import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import type { GjcRuntimeLocations } from "../contracts";
import { pathsOverlap, resolveExistingOrProspectivePath } from "../security/paths";
import { ProjectLinkError } from "./link-service";
import type { RegisteredProject } from "./registry";

export type ProjectRegistrationSource = "env" | "admin";
export type ProjectRegistrationStatus = "linked" | "unlinked";

export interface ProjectRegistration extends RegisteredProject {
	readonly source: ProjectRegistrationSource;
	readonly status: ProjectRegistrationStatus;
	readonly updatedAt: Date;
}

type ProjectRegistrationRow = {
	id: string;
	name: string;
	open_webui_folder_name: string | null;
	cwd: string;
	open_webui_folder_id: string | null;
	allowed_root: string;
	session_root: string | null;
	created_at: string;
	updated_at: string;
	source: ProjectRegistrationSource;
	status: ProjectRegistrationStatus;
};

export class SqliteProjectRegistrationStore {
	readonly #db: Database;

	constructor(databasePath: string) {
		if (databasePath !== ":memory:") {
			mkdirSync(path.dirname(databasePath), { recursive: true });
		}
		this.#db = new Database(databasePath);
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec(projectRegistrationSchema());
		this.#migrateLegacyModelIdColumn();
	}

	seedConfiguredProjects(projects: readonly RegisteredProject[]): void {
		for (const project of projects) {
			const existing = this.#getByCwd(project.cwd);
			if (existing === undefined) {
				this.linkProject(project, "env");
				continue;
			}
			this.#updateProjectFields(
				existing.id,
				preserveRuntimeFolderId(project, existing),
				existing.status,
				existing.source,
			);
		}
	}

	linkProject(project: RegisteredProject, source: ProjectRegistrationSource): ProjectRegistration {
		const existing = this.#getByCwd(project.cwd);
		const assigned = existing === undefined ? this.#assignProjectIdentity(project) : { ...project, id: existing.id };
		this.#updateProjectFields(assigned.id, assigned, "linked", source);
		const linked = this.getProject(assigned.id);
		if (linked === undefined) throw new Error(`Failed to persist project registration: ${assigned.id}`);
		return linked;
	}

	unlinkProject(projectIdOrCwd: string): ProjectRegistration | undefined {
		const existing = this.#findProject(projectIdOrCwd);
		if (existing === undefined) return undefined;
		const now = new Date().toISOString();
		this.#db
			.query("UPDATE project_registration SET status = 'unlinked', updated_at = ? WHERE id = ?")
			.run(now, existing.id);
		return this.getProject(existing.id);
	}

	updateOpenWebUIFolderId(projectId: string, folderId: string): ProjectRegistration {
		const existing = this.#getById(projectId);
		if (existing === undefined) throw new Error(`Project is not registered: ${projectId}`);
		this.#db
			.query("UPDATE project_registration SET open_webui_folder_id = ?, updated_at = ? WHERE id = ?")
			.run(folderId, new Date().toISOString(), projectId);
		const updated = this.#getById(projectId);
		if (updated === undefined) throw new Error(`Failed to update project registration: ${projectId}`);
		return updated;
	}

	getProject(projectIdOrCwd: string): ProjectRegistration | undefined {
		return this.#findProject(projectIdOrCwd);
	}

	listProjects(): readonly ProjectRegistration[] {
		return this.#db
			.query("SELECT * FROM project_registration ORDER BY name ASC, cwd ASC")
			.all()
			.map(row => this.#projectFromRow(row as ProjectRegistrationRow));
	}

	listLinkedProjects(): readonly ProjectRegistration[] {
		return this.#db
			.query("SELECT * FROM project_registration WHERE status = 'linked' ORDER BY name ASC, cwd ASC")
			.all()
			.map(row => this.#projectFromRow(row as ProjectRegistrationRow));
	}

	close(): void {
		this.#db.close();
	}

	#migrateLegacyModelIdColumn(): void {
		const columns = this.#db
			.query("PRAGMA table_info(project_registration)")
			.all()
			.map(row => tableColumnName(row));
		if (!columns.includes("model_id")) return;
		const legacyTable = `project_registration_legacy_${Date.now()}`;
		this.#db.exec("BEGIN");
		try {
			this.#db.exec(`ALTER TABLE project_registration RENAME TO ${legacyTable}`);
			this.#db.exec(projectRegistrationSchema());
			this.#db.exec(`
				INSERT INTO project_registration (
					id, name, open_webui_folder_name, cwd, open_webui_folder_id,
					allowed_root, session_root, created_at, updated_at, source, status
				)
				SELECT
					id, name, open_webui_folder_name, cwd, open_webui_folder_id,
					allowed_root, session_root, created_at, updated_at, source, status
				FROM ${legacyTable}
			`);
			this.#db.exec(`DROP TABLE ${legacyTable}`);
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#updateProjectFields(
		id: string,
		project: RegisteredProject,
		status: ProjectRegistrationStatus,
		source: ProjectRegistrationSource,
	): void {
		const existing = this.#getById(id);
		const createdAt = (existing?.createdAt ?? project.createdAt).toISOString();
		const updatedAt = new Date().toISOString();
		this.#db
			.query(
				`INSERT INTO project_registration (
						id, name, open_webui_folder_name, cwd, open_webui_folder_id,
						allowed_root, session_root, created_at, updated_at, source, status
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						name = excluded.name,
						open_webui_folder_name = excluded.open_webui_folder_name,
						cwd = excluded.cwd,
						open_webui_folder_id = excluded.open_webui_folder_id,
						allowed_root = excluded.allowed_root,
						session_root = excluded.session_root,
					updated_at = excluded.updated_at,
					source = excluded.source,
					status = excluded.status`,
			)
			.run(
				id,
				project.name,
				project.openWebUIFolderName ?? null,
				project.cwd,
				project.openWebUIFolderId ?? null,
				project.allowedRoot,
				project.sessionRoot ?? null,
				createdAt,
				updatedAt,
				source,
				status,
			);
	}

	#assignProjectIdentity(project: RegisteredProject): RegisteredProject {
		const sameId = this.#getById(project.id);
		if (sameId === undefined || sameId.cwd === project.cwd) return project;
		const fingerprint = createHash("sha256").update(project.cwd).digest("hex").slice(0, 8);
		const fingerprintedId = `${project.id}-${fingerprint}`;
		return { ...project, id: fingerprintedId };
	}

	#findProject(projectIdOrCwd: string): ProjectRegistration | undefined {
		return this.#getById(projectIdOrCwd) ?? this.#getByCwd(projectIdOrCwd);
	}

	#getById(id: string): ProjectRegistration | undefined {
		const row = this.#db.query("SELECT * FROM project_registration WHERE id = ?").get(id);
		return row === null ? undefined : this.#projectFromRow(row as ProjectRegistrationRow);
	}

	#getByCwd(cwd: string): ProjectRegistration | undefined {
		const row = this.#db.query("SELECT * FROM project_registration WHERE cwd = ?").get(cwd);
		return row === null ? undefined : this.#projectFromRow(row as ProjectRegistrationRow);
	}

	#projectFromRow(row: ProjectRegistrationRow): ProjectRegistration {
		return {
			id: row.id,
			name: row.name,
			...(row.open_webui_folder_name === null ? {} : { openWebUIFolderName: row.open_webui_folder_name }),
			cwd: row.cwd,
			...(row.open_webui_folder_id === null ? {} : { openWebUIFolderId: row.open_webui_folder_id }),
			allowedRoot: row.allowed_root,
			...(row.session_root === null ? {} : { sessionRoot: row.session_root }),
			createdAt: new Date(row.created_at),
			updatedAt: new Date(row.updated_at),
			source: row.source,
			status: row.status,
		};
	}
}

export async function auditProjectRegistrations(
	store: SqliteProjectRegistrationStore,
	protectedPaths: GjcRuntimeLocations["protectedProjectPaths"],
): Promise<void> {
	const canonicalProtectedPaths = await Promise.all(protectedPaths.map(resolveExistingOrProspectivePath));
	for (const project of store.listProjects()) {
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

function projectRegistrationSchema(): string {
	return `
		CREATE TABLE IF NOT EXISTS project_registration (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			open_webui_folder_name TEXT,
			cwd TEXT NOT NULL UNIQUE,
			open_webui_folder_id TEXT,
			allowed_root TEXT NOT NULL,
			session_root TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			source TEXT NOT NULL CHECK (source IN ('env', 'admin')),
			status TEXT NOT NULL CHECK (status IN ('linked', 'unlinked'))
		)
	`;
}

function tableColumnName(row: unknown): string {
	if (typeof row !== "object" || row === null || !("name" in row) || typeof row.name !== "string") {
		throw new Error("SQLite PRAGMA table_info returned an invalid row.");
	}
	return row.name;
}

function preserveRuntimeFolderId(project: RegisteredProject, existing: ProjectRegistration): RegisteredProject {
	if (project.openWebUIFolderId !== undefined || existing.openWebUIFolderId === undefined) return project;
	return { ...project, openWebUIFolderId: existing.openWebUIFolderId };
}
