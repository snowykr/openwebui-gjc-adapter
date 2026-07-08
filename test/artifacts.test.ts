import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { projectArtifactRef } from "../src/projection/artifacts";
import { resolveAllowedRoots } from "../src/security/paths";

describe("artifact projection", () => {
	test("projects an allowed artifact as an adapter-owned URL ref", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-artifact-"));
		const allowedDirectory = path.join(workspace, "allowed");
		await fs.mkdir(allowedDirectory);
		const artifactPath = path.join(allowedDirectory, "report.txt");
		await fs.writeFile(artifactPath, "artifact");
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		const ref = await projectArtifactRef({
			path: artifactPath,
			allowedRoots,
			artifactBaseUrl: "https://adapter.example.test/artifacts",
		});

		expect(ref.kind).toBe("url");
		expect(ref.name).toBe("report.txt");
		expect(ref.url).toStartWith("https://adapter.example.test/artifacts/");
		expect(ref.url).toEndWith("/report.txt");
		expect(ref.metadata.gjc_adapter.artifactId).toBe(ref.id);
	});

	test("rejects traversal outside allowed artifact roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-artifact-traversal-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const outsideDirectory = path.join(workspace, "outside");
		await fs.mkdir(allowedDirectory);
		await fs.mkdir(outsideDirectory);
		await fs.writeFile(path.join(outsideDirectory, "secret.txt"), "secret");
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		await expect(
			projectArtifactRef({
				path: path.join(allowedDirectory, "..", "outside", "secret.txt"),
				allowedRoots,
				artifactBaseUrl: "https://adapter.example.test/artifacts",
			}),
		).rejects.toThrow("outside allowed artifact roots");
	});

	test("rejects symlink escapes from allowed artifact roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-artifact-symlink-"));
		const allowedDirectory = path.join(workspace, "allowed");
		const outsideDirectory = path.join(workspace, "outside");
		await fs.mkdir(allowedDirectory);
		await fs.mkdir(outsideDirectory);
		const outsideArtifact = path.join(outsideDirectory, "secret.txt");
		await fs.writeFile(outsideArtifact, "secret");
		const symlinkPath = path.join(allowedDirectory, "secret-link.txt");
		await fs.symlink(outsideArtifact, symlinkPath);
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		await expect(projectArtifactRef({ path: symlinkPath, allowedRoots })).rejects.toThrow(
			"outside allowed artifact roots",
		);
	});

	test("falls back to metadata-only refs when no artifact base URL is configured", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-artifact-metadata-"));
		const allowedDirectory = path.join(workspace, "allowed");
		await fs.mkdir(allowedDirectory);
		const artifactPath = path.join(allowedDirectory, "report.txt");
		await fs.writeFile(artifactPath, "artifact");
		const allowedRoots = await resolveAllowedRoots([allowedDirectory]);

		const ref = await projectArtifactRef({ path: artifactPath, allowedRoots });

		expect(ref.kind).toBe("metadata");
		expect(ref.url).toBeUndefined();
		expect(ref.name).toBe("report.txt");
		expect(ref.metadata.gjc_adapter.artifactId).toBe(ref.id);
	});
});
