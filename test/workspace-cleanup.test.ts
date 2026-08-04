import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createUserWorkspaceRegistry } from "../src/security/user-workspace";
import { createWorkspaceCleanupService } from "../src/security/workspace-cleanup";
import { createWorkspaceLeaseManager } from "../src/security/workspace-lease";

async function createFixture(userId = "cleanup-user") {
	const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workspace-cleanup-"));
	const registry = createUserWorkspaceRegistry({ stateRoot });
	const leaseManager = createWorkspaceLeaseManager({ stateRoot });
	const service = createWorkspaceCleanupService({ registry, leaseManager, leaseMs: 10_000, heartbeatMs: 1_000 });
	const workspace = await registry.open(userId);
	return { stateRoot, registry, leaseManager, service, workspace, userId };
}

describe("admin user workspace cleanup", () => {
	test("dry-run returns metadata and never deletes workspace contents", async () => {
		const fixture = await createFixture();
		const file = path.join(fixture.workspace.root, "keep.txt");
		await fs.writeFile(file, "keep");

		const preview = await fixture.service.preview({ userId: fixture.userId });

		expect(preview.dryRun).toBe(true);
		expect(preview.found).toBe(true);
		expect(preview.safeKey).toBe(fixture.workspace.safeKey);
		expect(typeof preview.confirmationToken).toBe("string");
		expect(await fs.readFile(file, "utf8")).toBe("keep");
		await expect(fs.stat(path.join(fixture.stateRoot, "workspace-cleanup"))).rejects.toThrow();
	});

	test("rejects an invalid confirmation without deleting", async () => {
		const fixture = await createFixture();
		const file = path.join(fixture.workspace.root, "keep.txt");
		await fs.writeFile(file, "keep");
		await fixture.service.preview({ userId: fixture.userId });

		await expect(
			fixture.service.cleanup({ userId: fixture.userId, confirmationToken: "not-the-preview-token" }),
		).rejects.toThrow(/confirmation/i);
		expect(await fs.readFile(file, "utf8")).toBe("keep");
	});

	test("refuses cleanup while an active non-cleanup lease is held", async () => {
		const fixture = await createFixture();
		const preview = await fixture.service.preview({ userId: fixture.userId });
		const lease = await fixture.leaseManager.acquire({
			safeKey: fixture.workspace.safeKey,
			holderId: "active-turn",
			operation: "turn",
			leaseMs: 10_000,
		});

		await expect(
			fixture.service.cleanup({ userId: fixture.userId, confirmationToken: preview.confirmationToken! }),
		).rejects.toThrow(/already held|active/i);
		await lease.release();
		expect(await fs.stat(fixture.workspace.root)).toBeTruthy();
	});

	test("removes a confirmed workspace and unregisters its safe key", async () => {
		const fixture = await createFixture();
		await fs.writeFile(path.join(fixture.workspace.root, "remove.txt"), "remove");
		const preview = await fixture.service.preview({ userId: fixture.userId });

		const result = await fixture.service.cleanup({
			userId: fixture.userId,
			confirmationToken: preview.confirmationToken!,
		});

		expect(result.outcome).toBe("success");
		await expect(fs.stat(fixture.workspace.root)).rejects.toThrow();
		expect(await fixture.registry.resolve(fixture.userId)).toBeUndefined();
		const auditFiles = await fs.readdir(path.join(fixture.stateRoot, "workspace-cleanup", "audit"));
		expect(auditFiles.some(file => file.includes(fixture.workspace.safeKey))).toBe(true);
		for (const file of auditFiles) {
			const record = JSON.parse(
				await fs.readFile(path.join(fixture.stateRoot, "workspace-cleanup", "audit", file), "utf8"),
			) as Record<string, unknown>;
			expect(record).not.toHaveProperty("userId");
		}
	});

	test("rejects symlinks without following them or escaping stateRoot", async () => {
		if (process.platform === "win32") return;
		const fixture = await createFixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workspace-cleanup-outside-"));
		const outsideFile = path.join(outside, "outside.txt");
		await fs.writeFile(outsideFile, "outside");
		await fs.symlink(outside, path.join(fixture.workspace.root, "escape"));
		const preview = await fixture.service.preview({ userId: fixture.userId });

		await expect(
			fixture.service.cleanup({ userId: fixture.userId, confirmationToken: preview.confirmationToken! }),
		).rejects.toThrow(/symlink/i);
		expect(await fs.readFile(outsideFile, "utf8")).toBe("outside");
		await expect(
			fixture.leaseManager.acquire({
				safeKey: fixture.workspace.safeKey,
				holderId: "blocked-turn",
				operation: "turn",
				leaseMs: 10_000,
			}),
		).rejects.toThrow(/cleanup.*pending/i);
	});

	test("keeps cleanup fail-closed after a partial error and allows a later retry", async () => {
		if (process.platform === "win32") return;
		const fixture = await createFixture();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workspace-cleanup-partial-"));
		await fs.symlink(outside, path.join(fixture.workspace.root, "bad-link"));
		const first = await fixture.service.preview({ userId: fixture.userId });

		await expect(
			fixture.service.cleanup({ userId: fixture.userId, confirmationToken: first.confirmationToken! }),
		).rejects.toThrow(/symlink/i);
		await expect(
			fixture.leaseManager.acquire({
				safeKey: fixture.workspace.safeKey,
				holderId: "still-blocked",
				operation: "turn",
				leaseMs: 10_000,
			}),
		).rejects.toThrow(/cleanup.*pending/i);

		await fs.unlink(path.join(fixture.workspace.root, "bad-link"));
		const retry = await fixture.service.preview({ userId: fixture.userId });
		await fixture.service.cleanup({ userId: fixture.userId, confirmationToken: retry.confirmationToken! });
		expect(await fixture.registry.resolve(fixture.userId)).toBeUndefined();
	});
});
