import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectLinkError } from "../src/projects/link-service";
import * as registrationStoreModule from "../src/projects/registration-store";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import type { RegisteredProject } from "../src/projects/registry";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("project registration store schema", () => {
	test("persists project registration fields", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-schema-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Schema Project");
		await fs.mkdir(projectDirectory);
		const databasePath = path.join(workspace, "projects.sqlite");
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory({ cwd: projectDirectory, name: "Schema Project" }, allowedRoots);
		const store = new SqliteProjectRegistrationStore(databasePath);

		const linked = store.linkProject(project, "admin");
		store.close();
		const database = new Database(databasePath, { readonly: true });
		try {
			const columns = database.query("PRAGMA table_info(project_registration)").all().map(tableColumnName);

			expect(linked).toMatchObject({
				id: "schema-project",
				name: "Schema Project",
				cwd: projectDirectory,
				status: "linked",
			});
			expect(columns).toEqual([
				"id",
				"name",
				"open_webui_folder_name",
				"cwd",
				"open_webui_folder_id",
				"allowed_root",
				"session_root",
				"created_at",
				"updated_at",
				"source",
				"status",
			]);
		} finally {
			database.close();
		}
	});

	test("rejects every protected-path relation for linked and unlinked cwd and session roots", async () => {
		// Given: four isolated protected paths and every candidate field, relation, and persisted status.
		const workspace = await createWorkspace("matrix");
		const protectedPaths = await createProtectedPaths(workspace);
		const relations = ["equal", "ancestor", "descendant"] as const;
		const fields = ["cwd", "sessionRoot"] as const;
		const statuses = ["linked", "unlinked"] as const;

		for (const [protectedIndex, protectedPath] of protectedPaths.entries()) {
			for (const relation of relations) {
				for (const field of fields) {
					for (const status of statuses) {
						const candidate = relatedPath(protectedPath, relation);
						const store = new SqliteProjectRegistrationStore(":memory:");
						try {
							const project = projectWithCandidate({
								candidate,
								field,
								workspace,
								protectedIndex,
								relation,
								status,
							});
							store.linkProject(project, "admin");
							if (status === "unlinked") store.unlinkProject(project.id);

							// When: the persisted registration is audited against exactly the protected tuple.
							const failure = await captureProjectLinkError(auditRegistrations(store, protectedPaths));

							// Then: the public failure is exact and discloses neither absolute path.
							expect(failure.code).toBe("invalid_project_link");
							expect(failure.message).toBe("Project paths must not overlap protected GJC runtime paths.");
							expect(failure.message).not.toContain(candidate);
							expect(failure.message).not.toContain(protectedPath);
						} finally {
							store.close();
						}
					}
				}
			}
		}
	});

	test("canonicalizes symlinks and prospective descendants before rejecting overlap", async () => {
		// Given: a symlink into one protected path and a missing descendant below that symlink.
		const workspace = await createWorkspace("symlink");
		const protectedPaths = await createProtectedPaths(workspace);
		const alias = path.join(workspace, "protected-alias");
		await fs.symlink(protectedPaths[1], alias);
		const candidates = [alias, path.join(alias, "future", "project")];

		for (const [index, candidate] of candidates.entries()) {
			const store = new SqliteProjectRegistrationStore(":memory:");
			try {
				store.linkProject(
					projectRecord({ id: `symlink-${index}`, cwd: candidate, allowedRoot: workspace }),
					"admin",
				);

				// When: the real store audit resolves the candidate.
				const failure = await captureProjectLinkError(auditRegistrations(store, protectedPaths));

				// Then: both existing and prospective symlink overlap is rejected safely.
				expect(failure).toBeInstanceOf(ProjectLinkError);
				expect(failure.message).toBe("Project paths must not overlap protected GJC runtime paths.");
			} finally {
				store.close();
			}
		}
	});

	test("leaves a real database unchanged when auditing safe siblings and an unprotected fifth path", async () => {
		// Given: a disk-backed store with a linked safe sibling and an unlinked row using a fifth runtime path.
		const workspace = await createWorkspace("readonly");
		const protectedPaths = await createProtectedPaths(workspace);
		const databasePath = path.join(workspace, "registrations.sqlite");
		const store = new SqliteProjectRegistrationStore(databasePath);
		try {
			const sibling = projectRecord({
				id: "safe-sibling",
				cwd: path.join(workspace, "projects", "safe"),
				allowedRoot: workspace,
			});
			const fifthPath = projectRecord({
				id: "fifth-path",
				cwd: path.join(workspace, "projects", "other"),
				allowedRoot: workspace,
				sessionRoot: path.join(workspace, "adapter-state"),
			});
			store.linkProject(sibling, "admin");
			store.linkProject(fifthPath, "admin");
			store.unlinkProject(fifthPath.id);
			const bytesBefore = await fs.readFile(databasePath);
			const logicalBefore = JSON.stringify(store.listProjects());

			// When: safe persisted registrations are audited.
			await auditRegistrations(store, protectedPaths);

			// Then: the audit accepts them without rewriting or deleting either row.
			expect(await fs.readFile(databasePath)).toEqual(bytesBefore);
			expect(JSON.stringify(store.listProjects())).toBe(logicalBefore);
			expect(store.listProjects()).toHaveLength(2);
		} finally {
			store.close();
		}
	});
});

type CandidateCase = {
	readonly candidate: string;
	readonly field: "cwd" | "sessionRoot";
	readonly workspace: string;
	readonly protectedIndex: number;
	readonly relation: "equal" | "ancestor" | "descendant";
	readonly status: "linked" | "unlinked";
};

type ProjectFixture = {
	readonly id: string;
	readonly cwd: string;
	readonly allowedRoot: string;
	readonly sessionRoot?: string;
};

type ProjectAudit = (
	store: SqliteProjectRegistrationStore,
	protectedPaths: readonly [string, string, string, string],
) => Promise<void>;

async function createWorkspace(label: string): Promise<string> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-project-link-${label}-`));
	tempDirs.push(workspace);
	return workspace;
}

async function createProtectedPaths(workspace: string): Promise<readonly [string, string, string, string]> {
	const protectedPaths = [0, 1, 2, 3].map(index => path.join(workspace, `runtime-${index}`, "owned"));
	await Promise.all(protectedPaths.map(protectedPath => fs.mkdir(protectedPath, { recursive: true })));
	const [first, second, third, fourth] = protectedPaths;
	if (first === undefined || second === undefined || third === undefined || fourth === undefined)
		throw new Error("Protected-path fixture is incomplete.");
	return [first, second, third, fourth];
}

function relatedPath(protectedPath: string, relation: CandidateCase["relation"]): string {
	if (relation === "equal") return protectedPath;
	if (relation === "ancestor") return path.dirname(protectedPath);
	return path.join(protectedPath, "prospective", "project");
}

function projectWithCandidate(input: CandidateCase): RegisteredProject {
	const id = `${input.field}-${input.protectedIndex}-${input.relation}-${input.status}`;
	const safeCwd = path.join(input.workspace, "projects", id);
	return projectRecord({
		id,
		cwd: input.field === "cwd" ? input.candidate : safeCwd,
		allowedRoot: input.workspace,
		...(input.field === "sessionRoot" ? { sessionRoot: input.candidate } : {}),
	});
}

function projectRecord(input: ProjectFixture): RegisteredProject {
	return {
		id: input.id,
		name: input.id,
		cwd: input.cwd,
		allowedRoot: input.allowedRoot,
		...(input.sessionRoot === undefined ? {} : { sessionRoot: input.sessionRoot }),
		createdAt: new Date("2026-07-12T00:00:00.000Z"),
	};
}

async function captureProjectLinkError(promise: Promise<void>): Promise<ProjectLinkError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ProjectLinkError) return error;
		throw error;
	}
	throw new Error("Expected project path audit to fail.");
}

async function auditRegistrations(
	store: SqliteProjectRegistrationStore,
	protectedPaths: readonly [string, string, string, string],
): Promise<void> {
	const audit = projectAuditExport();
	expect(audit).not.toBeUndefined();
	if (audit === undefined) return;
	await audit(store, protectedPaths);
}

function projectAuditExport(): ProjectAudit | undefined {
	const candidate: unknown = Reflect.get(registrationStoreModule, "auditProjectRegistrations");
	if (typeof candidate !== "function") return undefined;
	return async (store, protectedPaths) => {
		await Reflect.apply(candidate, registrationStoreModule, [store, protectedPaths]);
	};
}

function tableColumnName(row: unknown): string {
	if (typeof row !== "object" || row === null || !("name" in row) || typeof row.name !== "string") {
		throw new Error("SQLite PRAGMA table_info returned an invalid row.");
	}
	return row.name;
}
