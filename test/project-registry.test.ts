import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildProjectFolderMetadata,
	createProjectId,
	disambiguateRegisteredProjects,
	registerProjectDirectory,
} from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";

describe("project registry primitives", () => {
	test("creates stable basename slugs", async () => {
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
		expect(project.openWebUIFolderName).toBe("My App!");
	});

	test("disambiguates registered projects with the same display slug by real cwd", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-collision-"));
		const firstDirectory = path.join(workspace, "alpha", "Same");
		const secondDirectory = path.join(workspace, "beta", "Same");
		await fs.mkdir(firstDirectory, { recursive: true });
		await fs.mkdir(secondDirectory, { recursive: true });
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const firstProject = await registerProjectDirectory({ cwd: firstDirectory }, allowedRoots);
		const secondProject = await registerProjectDirectory({ cwd: secondDirectory }, allowedRoots);

		const projects = disambiguateRegisteredProjects([firstProject, secondProject]);

		expect(projects.map(project => project.name)).toEqual(["Same", "Same"]);
		expect(new Set(projects.map(project => project.id)).size).toBe(2);
		expect(projects.map(project => project.openWebUIFolderName)).toEqual(["Same (alpha/Same)", "Same (beta/Same)"]);
		expect(projects.every(project => project.id.startsWith("same-"))).toBe(true);
		expect(projects.map(project => buildProjectFolderMetadata(project).gjc_adapter.projectId)).toEqual(
			projects.map(project => project.id),
		);
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
	test("classifies canonicalization permission denial before registration", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-project-canonical-access-"));
		const lockedParent = path.join(workspace, "locked");
		const projectDirectory = path.join(lockedParent, "project");
		await fs.mkdir(projectDirectory, { recursive: true });
		const allowedRoots = await resolveAllowedRoots([workspace]);

		await fs.chmod(lockedParent, 0o000);
		try {
			await expect(registerProjectDirectory({ cwd: projectDirectory }, allowedRoots)).rejects.toThrow(
				"Project directory is not readable/searchable",
			);
		} finally {
			await fs.chmod(lockedParent, 0o755);
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
	test("rejects an unwritable default session root before registration", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-default-session-access-"));
		const projectDirectory = path.join(workspace, "project");
		await fs.mkdir(projectDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);

		await fs.chmod(projectDirectory, 0o555);
		try {
			await expect(registerProjectDirectory({ cwd: projectDirectory }, allowedRoots)).rejects.toThrow(
				"Session root is not readable/writable/searchable",
			);
		} finally {
			await fs.chmod(projectDirectory, 0o755);
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	test("allows a read-only project with a separate writable session root", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-separate-session-access-"));
		const projectDirectory = path.join(workspace, "project");
		const sessionDirectory = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		await fs.mkdir(sessionDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);

		await fs.chmod(projectDirectory, 0o555);
		try {
			const registered = await registerProjectDirectory(
				{ cwd: projectDirectory, sessionRoot: sessionDirectory },
				allowedRoots,
			);
			expect(registered.cwd).toBe(await fs.realpath(projectDirectory));
			expect(registered.sessionRoot).toBe(await fs.realpath(sessionDirectory));
		} finally {
			await fs.chmod(projectDirectory, 0o755);
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
	test("rejects an existing session root that cannot be enumerated", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-session-read-access-"));
		const projectDirectory = path.join(workspace, "project");
		const sessionDirectory = path.join(workspace, "sessions");
		await fs.mkdir(projectDirectory);
		await fs.mkdir(sessionDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);

		await fs.chmod(sessionDirectory, 0o333);
		try {
			await expect(
				registerProjectDirectory({ cwd: projectDirectory, sessionRoot: sessionDirectory }, allowedRoots),
			).rejects.toThrow("Session root is not readable/writable/searchable");
		} finally {
			await fs.chmod(sessionDirectory, 0o755);
			await fs.rm(workspace, { recursive: true, force: true });
		}
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
				projectName: "Workspace",
			},
		});
	});
});
