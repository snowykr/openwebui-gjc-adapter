import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildProjectFolderMetadata,
	createProjectId,
	listProjectModels,
	registerProjectDirectory,
} from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";

describe("project registry primitives", () => {
	test("creates stable basename slugs and model ids", async () => {
		expect(createProjectId("/work/My App!")).toBe("my-app");
		expect(createProjectId("../Already Slugged")).toBe("already-slugged");

		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-id-"));
		const projectDirectory = path.join(workspace, "My App!");
		await fs.mkdir(projectDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);

		const project = await registerProjectDirectory(
			{ cwd: projectDirectory },
			allowedRoots,
			new Date("2026-07-08T12:34:56.000Z"),
		);

		expect(project.id).toBe("my-app");
		expect(project.name).toBe("My App!");
		expect(project.modelId).toBe("gjc/my-app");
	});

	test("realpath-validates cwd against allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-root-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const outsideDirectory = path.join(workspace, "outside");
		await fs.mkdir(allowedDirectory);
		await fs.mkdir(outsideDirectory);
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		const registered = await registerProjectDirectory({ cwd: allowedDirectory }, allowedRoots);
		expect(registered.cwd).toBe(await fs.realpath(allowedDirectory));
		expect(registered.allowedRoot).toBe(await fs.realpath(allowedDirectory));

		await expect(registerProjectDirectory({ cwd: outsideDirectory }, allowedRoots)).rejects.toThrow(
			"outside allowed artifact roots",
		);
	});

	test("realpath-validates configured session roots against allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-session-root-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const projectDirectory = path.join(allowedDirectory, "project");
		const sessionDirectory = path.join(allowedDirectory, "sessions");
		const outsideDirectory = path.join(workspace, "outside-sessions");
		await fs.mkdir(projectDirectory, { recursive: true });
		await fs.mkdir(sessionDirectory);
		await fs.mkdir(outsideDirectory);
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		const registered = await registerProjectDirectory(
			{ cwd: projectDirectory, sessionRoot: sessionDirectory },
			allowedRoots,
		);
		expect(registered.sessionRoot).toBe(await fs.realpath(sessionDirectory));

		await expect(
			registerProjectDirectory({ cwd: projectDirectory, sessionRoot: outsideDirectory }, allowedRoots),
		).rejects.toThrow("outside allowed artifact roots");
	});

	test("realpath-validates the default project session root against allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-default-session-root-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const projectDirectory = path.join(allowedDirectory, "project");
		const outsideDirectory = path.join(workspace, "outside-sessions");
		await fs.mkdir(projectDirectory, { recursive: true });
		await fs.mkdir(outsideDirectory);
		await fs.symlink(outsideDirectory, path.join(projectDirectory, ".gjc"));
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		await expect(registerProjectDirectory({ cwd: projectDirectory }, allowedRoots)).rejects.toThrow(
			"outside allowed artifact roots",
		);
	});

	test("builds OpenWebUI folder metadata projection", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-metadata-"));
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory(
			{ cwd: workspace, name: "Workspace" },
			allowedRoots,
			new Date("2026-07-08T12:34:56.000Z"),
		);

		expect(buildProjectFolderMetadata(project)).toEqual({
			gjc_adapter: {
				projectId: "workspace",
				modelId: "gjc/workspace",
				projectName: "Workspace",
			},
		});
	});

	test("lists OpenAI-compatible project model entries", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-models-"));
		const firstDirectory = path.join(workspace, "First");
		const secondDirectory = path.join(workspace, "Second");
		await fs.mkdir(firstDirectory);
		await fs.mkdir(secondDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const firstProject = await registerProjectDirectory(
			{ cwd: firstDirectory },
			allowedRoots,
			new Date("2026-07-08T12:00:00.000Z"),
		);
		const secondProject = await registerProjectDirectory(
			{ cwd: secondDirectory, name: "Second Project" },
			allowedRoots,
			new Date("2026-07-08T12:00:05.000Z"),
		);

		expect(listProjectModels([firstProject, secondProject])).toEqual([
			{
				id: "gjc/first",
				object: "model",
				created: 1783512000,
				owned_by: "gjc",
			},
			{
				id: "gjc/second-project",
				object: "model",
				created: 1783512005,
				owned_by: "gjc",
			},
		]);
	});
});
