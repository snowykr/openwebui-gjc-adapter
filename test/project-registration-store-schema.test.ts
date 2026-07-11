import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
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
});

function tableColumnName(row: unknown): string {
	if (typeof row !== "object" || row === null || !("name" in row) || typeof row.name !== "string") {
		throw new Error("SQLite PRAGMA table_info returned an invalid row.");
	}
	return row.name;
}
