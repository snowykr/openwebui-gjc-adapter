import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertArtifactPathAllowed, assertPathInsideAllowedRoots, resolveAllowedRoots } from "../src/security/paths";

describe("path security", () => {
	test("allows files and prospective children under an allowed root", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-paths-"));
		const allowedDirectory = path.join(workspace, "allowed");
		await fs.mkdir(allowedDirectory);
		const artifactPath = path.join(allowedDirectory, "artifact.txt");
		await fs.writeFile(artifactPath, "artifact");

		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		await expect(assertArtifactPathAllowed(artifactPath, allowedRoots)).resolves.toBe(
			await fs.realpath(artifactPath),
		);
		await expect(
			assertPathInsideAllowedRoots(path.join(allowedDirectory, "new", "artifact.txt"), allowedRoots),
		).resolves.toBe(path.join(await fs.realpath(allowedDirectory), "new", "artifact.txt"));
	});

	test("rejects traversal outside allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-traversal-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const outsideDirectory = path.join(workspace, "outside");
		await fs.mkdir(allowedDirectory);
		await fs.mkdir(outsideDirectory);
		const outsidePath = path.join(allowedDirectory, "..", "outside", "artifact.txt");
		await fs.writeFile(path.join(outsideDirectory, "artifact.txt"), "artifact");

		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		await expect(assertPathInsideAllowedRoots(outsidePath, allowedRoots)).rejects.toThrow(
			"outside allowed artifact roots",
		);
	});

	test("rejects symlink escapes from allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-symlink-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const outsideDirectory = path.join(workspace, "outside");
		await fs.mkdir(allowedDirectory);
		await fs.mkdir(outsideDirectory);
		const outsideArtifact = path.join(outsideDirectory, "artifact.txt");
		await fs.writeFile(outsideArtifact, "artifact");
		const symlinkPath = path.join(allowedDirectory, "escape.txt");
		await fs.symlink(outsideArtifact, symlinkPath);

		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		await expect(assertArtifactPathAllowed(symlinkPath, allowedRoots)).rejects.toThrow(
			"outside allowed artifact roots",
		);
	});
});
