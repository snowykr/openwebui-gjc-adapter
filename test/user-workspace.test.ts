import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createUserWorkspaceRegistry, deriveUserWorkspaceKey } from "../src/security/user-workspace";

describe("durable user workspaces", () => {
	test("derives a stable safe key without putting the raw user ID in the path", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-key-"));
		const userId = "user/with spaces?and-secrets";
		const registry = createUserWorkspaceRegistry({ stateRoot });

		const first = await registry.open(userId);
		const second = await registry.open(userId);

		expect(deriveUserWorkspaceKey(userId)).toBe(first.safeKey);
		expect(second.safeKey).toBe(first.safeKey);
		expect(first.safeKey).toMatch(/^[a-f0-9]{64}$/);
		expect(first.root).not.toContain(userId);
		expect(first.sessionRoot).not.toContain(userId);
	});

	test("creates and reuses the durable private workspace layout", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-layout-"));
		const registry = createUserWorkspaceRegistry({ stateRoot });
		const userId = "openwebui-user-1";

		const created = await registry.open(userId);
		const reused = await createUserWorkspaceRegistry({ stateRoot }).open(userId);
		const expectedKeyRoot = path.join(stateRoot, "workspaces", created.safeKey);
		const registryDocument = JSON.parse(
			await fs.readFile(path.join(stateRoot, "workspaces", "registry.json"), "utf8"),
		) as Record<string, { userId: string; workspaceRoot: string }>;

		expect(created.root).toBe(path.join(expectedKeyRoot, "workspace"));
		expect(created.sessionRoot).toBe(path.join(created.root, ".gjc", "sessions"));
		expect(reused).toEqual(created);
		expect(registryDocument[created.safeKey]).toEqual({ userId, workspaceRoot: created.root });
		for (const directory of [
			stateRoot,
			path.join(stateRoot, "workspaces"),
			expectedKeyRoot,
			created.root,
			path.dirname(created.sessionRoot),
			created.sessionRoot,
		]) {
			expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		}
	});

	test("tightens a pre-existing state root before creating user workspaces", async () => {
		if (process.platform === "win32") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-private-state-"));
		await fs.chmod(stateRoot, 0o777);

		await createUserWorkspaceRegistry({ stateRoot }).open("private-state-user");

		expect((await fs.stat(stateRoot)).mode & 0o777).toBe(0o700);
	});
	test("serializes concurrent first use and keeps one consistent registry", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-concurrent-"));
		const registry = createUserWorkspaceRegistry({ stateRoot });
		const userIds = ["concurrent-a", "concurrent-b", "concurrent-c"];

		const workspaces = await Promise.all(userIds.map(userId => registry.open(userId)));
		const registryDocument = JSON.parse(
			await fs.readFile(path.join(stateRoot, "workspaces", "registry.json"), "utf8"),
		) as Record<string, unknown>;

		expect(new Set(workspaces.map(workspace => workspace.safeKey)).size).toBe(userIds.length);
		expect(Object.keys(registryDocument)).toHaveLength(userIds.length);
	});

	test("rejects a symlink substitution for a user workspace", async () => {
		if (process.platform === "win32") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-symlink-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-outside-"));
		const registry = createUserWorkspaceRegistry({ stateRoot });
		const userId = "symlink-user";
		const safeKey = deriveUserWorkspaceKey(userId);
		const workspacesRoot = path.join(stateRoot, "workspaces");
		await fs.mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
		await fs.symlink(outsideRoot, path.join(workspacesRoot, safeKey));

		await expect(registry.open(userId)).rejects.toThrow(/symlink|directory|escaped/i);
	});
	test("rejects a symlinked session subtree when resolving an existing workspace", async () => {
		if (process.platform === "win32") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-session-symlink-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-session-outside-"));
		const registry = createUserWorkspaceRegistry({ stateRoot });
		const workspace = await registry.open("session-symlink-user");

		await fs.rm(path.join(workspace.root, ".gjc"), { recursive: true, force: true });
		await fs.symlink(outsideRoot, path.join(workspace.root, ".gjc"));

		await expect(registry.resolve("session-symlink-user")).rejects.toThrow(/symlink|escaped/i);
	});

	test("rejects a conflicting durable registry record", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-conflict-"));
		const registry = createUserWorkspaceRegistry({ stateRoot });
		const first = await registry.open("registered-user");
		const registryPath = path.join(stateRoot, "workspaces", "registry.json");
		await fs.writeFile(
			registryPath,
			JSON.stringify({
				[first.safeKey]: {
					userId: "different-user",
					workspaceRoot: first.root,
				},
			}),
			{ mode: 0o600 },
		);

		await expect(registry.open("registered-user")).rejects.toThrow(/safe key|match|collision|inconsistent/i);
	});
});
