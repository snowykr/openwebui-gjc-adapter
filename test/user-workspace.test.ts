import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createUserWorkspaceRegistry, deriveUserWorkspaceKey } from "../src/security/user-workspace";

async function processStartTicks(pid = process.pid): Promise<string> {
	const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
	const closing = stat.lastIndexOf(")");
	const fields = stat
		.slice(closing + 2)
		.trim()
		.split(/\s+/);
	const startTicks = fields[19];
	if (startTicks === undefined || !/^\d+$/.test(startTicks)) {
		throw new Error(`missing process start identity for PID ${pid}`);
	}
	return startTicks;
}

async function withoutProcessUid<T>(operation: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
	Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
	try {
		return await operation();
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(process, "getuid");
		else Object.defineProperty(process, "getuid", descriptor);
	}
}

async function withForeignProcessUid<T>(operation: () => Promise<T>): Promise<T> {
	const currentUid = process.getuid?.();
	if (currentUid === undefined) return operation();
	const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
	Object.defineProperty(process, "getuid", { configurable: true, value: () => currentUid + 1 });
	try {
		return await operation();
	} finally {
		if (descriptor === undefined) Reflect.deleteProperty(process, "getuid");
		else Object.defineProperty(process, "getuid", descriptor);
	}
}

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
	test("recovers a registry lock left by a dead process", async () => {
		if (process.platform !== "linux") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-dead-"));
		const lockPath = path.join(stateRoot, ".workspace-registry.lock");
		await fs.writeFile(lockPath, `${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, startTicks: "1" })}\n`, {
			mode: 0o600,
		});

		const workspace = await createUserWorkspaceRegistry({ stateRoot }).open("dead-lock-user");

		expect(workspace.userId).toBe("dead-lock-user");
		await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("recovers a registry lock whose PID was reused by another process", async () => {
		if (process.platform !== "linux") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-pid-reuse-"));
		const lockPath = path.join(stateRoot, ".workspace-registry.lock");
		const startTicks = await processStartTicks();
		await fs.writeFile(
			lockPath,
			`${JSON.stringify({ pid: process.pid, startTicks: startTicks === "0" ? "1" : "0" })}\n`,
			{ mode: 0o600 },
		);

		await expect(createUserWorkspaceRegistry({ stateRoot }).open("pid-reused-lock-user")).resolves.toMatchObject({
			userId: "pid-reused-lock-user",
		});
	});

	test("blocks a live registry lock owner without removing the guard", async () => {
		if (process.platform !== "linux") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-live-"));
		const lockPath = path.join(stateRoot, ".workspace-registry.lock");
		const lockText = `${JSON.stringify({ pid: process.pid, startTicks: await processStartTicks() })}\n`;
		await fs.writeFile(lockPath, lockText, { mode: 0o600 });

		await expect(createUserWorkspaceRegistry({ stateRoot }).open("live-lock-user")).rejects.toThrow(/unavailable/i);
		expect(await fs.readFile(lockPath, "utf8")).toBe(lockText);
	});
	test("blocks malformed, non-private, or symlinked registry locks without removing them", async () => {
		if (process.platform !== "linux") return;
		const malformedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-malformed-"));
		const malformedPath = path.join(malformedRoot, ".workspace-registry.lock");
		await fs.writeFile(malformedPath, "not-json\n", { mode: 0o600 });

		await expect(
			createUserWorkspaceRegistry({ stateRoot: malformedRoot }).open("malformed-lock-user"),
		).rejects.toThrow(/metadata|JSON|unavailable/i);
		expect(await fs.readFile(malformedPath, "utf8")).toBe("not-json\n");

		const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-nonprivate-"));
		const privatePath = path.join(privateRoot, ".workspace-registry.lock");
		await fs.writeFile(
			privatePath,
			`${JSON.stringify({ pid: process.pid, startTicks: await processStartTicks() })}\n`,
			{
				mode: 0o644,
			},
		);
		await fs.chmod(privatePath, 0o644);

		await expect(
			createUserWorkspaceRegistry({ stateRoot: privateRoot }).open("non-private-lock-user"),
		).rejects.toThrow(/private/i);
		expect((await fs.stat(privatePath)).mode & 0o777).toBe(0o644);
		const symlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-symlink-"));
		const symlinkPath = path.join(symlinkRoot, ".workspace-registry.lock");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-lock-outside-"));
		await fs.symlink(outside, symlinkPath);

		await expect(createUserWorkspaceRegistry({ stateRoot: symlinkRoot }).open("symlink-lock-user")).rejects.toThrow(
			/regular|symlink/i,
		);
		expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
	});
	test("acquires a fresh workspace when the UID API is unavailable", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-portable-"));
		await withoutProcessUid(async () => {
			const workspace = await createUserWorkspaceRegistry({ stateRoot }).open("portable-user");
			expect(workspace.userId).toBe("portable-user");
		});
	});

	test("denies a registry lock owned by a foreign POSIX UID", async () => {
		if (process.platform === "win32" || typeof process.getuid !== "function") return;
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-user-workspace-foreign-"));
		await expect(
			withForeignProcessUid(() => createUserWorkspaceRegistry({ stateRoot }).open("foreign-uid-user")),
		).rejects.toThrow(/foreign ownership/i);
		await expect(fs.lstat(path.join(stateRoot, ".workspace-registry.lock"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
