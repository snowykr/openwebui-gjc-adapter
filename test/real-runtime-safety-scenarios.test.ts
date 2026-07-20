import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/adapter-server-options";
import { ProjectLinkError } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import type { RegisteredProject } from "../src/projects/registry";
import { startAdapterServer } from "../src/server";
import { observeStartup, spawnCli, terminateAndReap } from "./bounded-process-fixtures";
import { FakeGjcTurnRunner, reserveTcpPort } from "./cli-fixtures";

const tempDirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];

afterEach(async () => {
	await Promise.all(handles.splice(0).map(handle => handle.stop()));
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { force: true, recursive: true })));
});

describe("real runtime project safety scenarios", () => {
	test("rejects every stale linked or unlinked row before runner or listener startup without changing SQLite", async () => {
		// Given: a real database containing each possible status on a protected runtime path.
		for (const status of ["linked", "unlinked"] as const) {
			const workspace = await createWorkspace(`stale-${status}`);
			const port = await reserveTcpPort();
			const env = runtimeEnv(workspace, port);
			const databasePath = path.join(workspace, "state", "adapter-state.sqlite");
			const store = new SqliteProjectRegistrationStore(databasePath);
			const protectedPath = path.join(workspace, "home", ".gjc");
			await fs.mkdir(protectedPath, { recursive: true });
			store.linkProject(projectRecord(`${status}-stale`, protectedPath, workspace), "admin");
			if (status === "unlinked") store.unlinkProject(`${status}-stale`);
			const before = JSON.stringify(store.listProjects());
			store.close();
			const bytesBefore = await fs.readFile(databasePath);
			const marker = path.join(workspace, "runner-marker");
			const markerCommand = path.join(workspace, "runner-marker.sh");
			await fs.writeFile(markerCommand, `#!/bin/sh\nprintf invoked > ${marker}\n`);
			await fs.chmod(markerCommand, 0o700);

			// When: the shipped CLI attempts to start from the stale database within a bounded readiness window.
			const cliProcess = spawnCli([process.execPath, "run", "start"], path.resolve(import.meta.dir, ".."), {
				...process.env,
				...env,
				GJC_OPENWEBUI_GJC_COMMAND: markerCommand,
				PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
			});

			try {
				// Then: startup exits before runner invocation or listener bind and leaves SQLite unchanged.
				expect(await observeStartup(cliProcess, port)).toBe("exited");
				expect(await cliProcess.exited).toBe(1);
				const stderr = await new Response(cliProcess.stderr).text();
				expect(stderr.split("\n")).toContain("Project paths must not overlap protected GJC runtime paths.");
				expect(await Bun.file(marker).exists()).toBe(false);
				expect(await fs.readFile(databasePath)).toEqual(bytesBefore);
				const afterStore = new SqliteProjectRegistrationStore(databasePath);
				expect(JSON.stringify(afterStore.listProjects())).toBe(before);
				afterStore.close();
			} finally {
				await terminateAndReap(cliProcess);
				const portProbe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("free") });
				await portProbe.stop(true);
			}
		}
	}, 15_000);

	test("prevalidates the complete configured batch before writing any registration", async () => {
		// Given: one safe configured project followed by one protected project.
		const workspace = await createWorkspace("configured-batch");
		const safeProject = path.join(workspace, "projects", "safe");
		const unsafeProject = path.join(workspace, "home", ".gjc", "agent");
		await fs.mkdir(safeProject, { recursive: true });
		await fs.mkdir(unsafeProject, { recursive: true });
		const store = new SqliteProjectRegistrationStore(path.join(workspace, "state", "adapter-state.sqlite"));
		const env = runtimeEnv(workspace, await reserveTcpPort(), `${safeProject}|Safe;${unsafeProject}|Unsafe`);

		// When: startup parses and admits the configured seed batch.
		const failure = await captureProjectLinkError(
			buildAdapterServerOptionsFromEnv(env, {
				turnRunner: new FakeGjcTurnRunner(),
				projectRegistrationStore: store,
			}),
		);

		// Then: the unsafe member rejects the whole batch before the safe member is persisted.
		expect(failure.code).toBe("invalid_project_link");
		expect(store.listProjects()).toEqual([]);
		store.close();
	});

	test("drives unsafe and safe admin and slash links through a real loopback server", async () => {
		// Given: a live server on a dynamic port with a real temporary SQLite store.
		const workspace = await createWorkspace("loopback");
		const port = await reserveTcpPort();
		const store = new SqliteProjectRegistrationStore(path.join(workspace, "state", "adapter-state.sqlite"));
		const options = await buildAdapterServerOptionsFromEnv(runtimeEnv(workspace, port), {
			turnRunner: new FakeGjcTurnRunner(),
			projectRegistrationStore: store,
		});
		const handle = await startAdapterServer(options);
		handles.push(handle);
		const protectedPath = path.join(workspace, "home", ".gjc", "openwebui", "default-reader");

		// When: both HTTP admission surfaces receive a protected project path.
		const admin = await fetch(`${handle.url}/admin/projects/link`, requestInit({ cwd: protectedPath }));
		const slash = await fetch(
			`${handle.url}/v1/chat/completions`,
			requestInit(
				{ model: "gjc", messages: [{ role: "user", content: `/gjc project link ${protectedPath}` }] },
				true,
			),
		);

		// Then: both return the exact safe client error and perform no write.
		expect(admin.status).toBe(400);
		expect(await admin.json()).toEqual(projectSafetyError());
		expect(slash.status).toBe(400);
		expect(await slash.json()).toEqual(projectSafetyError());
		expect(store.listProjects()).toEqual([]);

		// When: a safe sibling with an intentional separate session root is linked.
		const safeProject = path.join(workspace, "projects", "safe");
		const safeSessions = path.join(workspace, "sessions", "safe");
		await fs.mkdir(safeProject, { recursive: true });
		await fs.mkdir(safeSessions, { recursive: true });
		const safe = await fetch(
			`${handle.url}/admin/projects/link`,
			requestInit({ cwd: safeProject, sessionRoot: safeSessions }),
		);

		// Then: the safe project succeeds and is the only durable row.
		expect(safe.status).toBe(200);
		expect(store.listProjects()).toMatchObject([{ cwd: safeProject, sessionRoot: safeSessions, status: "linked" }]);
		store.close();
	});

	test("preserves a dirty Git worktree when managed runtime fields arrive through flags or JSON", async () => {
		// Given: a detached real worktree with tracked and untracked byte sentinels.
		const root = await createWorkspace("dirty-worktree");
		const dirty = path.join(root, "dirty");
		const repository = path.resolve(import.meta.dir, "..");
		expect(runCommand(["git", "worktree", "add", "--detach", dirty, "HEAD"], repository).exitCode).toBe(0);
		const tracked = path.join(dirty, "README.md");
		const untracked = path.join(dirty, "untracked-sentinel");
		await fs.appendFile(tracked, "\ntracked-dirty-sentinel\n");
		await fs.writeFile(untracked, "untracked-sentinel\n");
		const statusBefore = runCommand(["git", "status", "--short", "--untracked-files=all"], dirty).stdout;
		const diffBefore = runCommand(["git", "diff", "--binary", "HEAD"], dirty).stdout;
		const trackedBefore = await fs.readFile(tracked);

		try {
			// When: the shipped CLI rejects both forbidden managed input surfaces.
			const flagResult = runCommand(
				[
					process.execPath,
					"run",
					path.join(repository, "src/cli.ts"),
					"configure",
					"managed",
					`--config=${tracked}`,
					"--gjc-config-dir-name=.hostile",
				],
				dirty,
			);
			const configPath = path.join(root, "managed.json");
			await fs.writeFile(configPath, JSON.stringify(hostileManagedConfig(root)));
			const jsonResult = runCommand(
				[process.execPath, "run", path.join(repository, "src/cli.ts"), "serve", `--config=${configPath}`],
				dirty,
			);

			// Then: rejection happens before repository, config, deployment, Docker, or systemd side effects.
			expect(flagResult).toMatchObject({
				exitCode: 2,
				stderr: "managed configuration does not accept GJC runtime location overrides\n",
			});
			expect(jsonResult).toMatchObject({
				exitCode: 1,
				stderr: "managed configuration must not include GJC runtime location fields\n",
			});
			expect(runCommand(["git", "status", "--short", "--untracked-files=all"], dirty).stdout).toBe(statusBefore);
			expect(runCommand(["git", "diff", "--binary", "HEAD"], dirty).stdout).toBe(diffBefore);
			expect(await fs.readFile(tracked)).toEqual(trackedBefore);
			expect(await fs.readFile(untracked, "utf8")).toBe("untracked-sentinel\n");
		} finally {
			runCommand(["git", "worktree", "remove", "--force", dirty], repository);
		}
	}, 15_000);
});

async function createWorkspace(label: string): Promise<string> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-real-runtime-${label}-`));
	tempDirs.push(workspace);
	await fs.mkdir(path.join(workspace, "home"), { recursive: true });
	return workspace;
}

function runtimeEnv(workspace: string, port: number, projects = ""): Record<string, string | undefined> {
	return {
		HOME: path.join(workspace, "home"),
		GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
		GJC_OPENWEBUI_BIND_PORT: String(port),
		GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
		GJC_OPENWEBUI_OWNER_USER_ID: "owner-1",
		GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
		GJC_OPENWEBUI_SESSION_ROOT: path.join(workspace, "sessions"),
		GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "state"),
		GJC_OPENWEBUI_PROJECTS: projects,
	};
}

function projectRecord(id: string, cwd: string, allowedRoot: string): RegisteredProject {
	return { id, name: id, cwd, allowedRoot, createdAt: new Date("2026-01-01T00:00:00.000Z") };
}

async function captureProjectLinkError(promise: Promise<unknown>): Promise<ProjectLinkError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ProjectLinkError) return error;
		throw error;
	}
	throw new Error("Expected project safety failure.");
}

function requestInit(body: unknown, openWebUI = false): RequestInit {
	return {
		method: "POST",
		headers: {
			authorization: "Bearer adapter-token",
			"content-type": "application/json",
			...(openWebUI
				? {
						"X-OpenWebUI-Chat-Id": "chat-1",
						"X-OpenWebUI-Message-Id": "assistant-1",
						"X-OpenWebUI-User-Message-Id": "user-1",
						"X-OpenWebUI-User-Message-Parent-Id": "",
						"X-OpenWebUI-User-Id": "owner-1",
					}
				: {}),
		},
		body: JSON.stringify(body),
	};
}

function projectSafetyError(): unknown {
	return {
		error: {
			message: "Project paths must not overlap protected GJC runtime paths.",
			type: "invalid_request_error",
			code: "invalid_project_link",
		},
	};
}

function runCommand(args: readonly string[], cwd: string, env = process.env) {
	const result = Bun.spawnSync([...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function hostileManagedConfig(root: string): object {
	return {
		version: 1,
		mode: "managed",
		installationId: "dirty-worktree",
		adapterToken: "adapter-token",
		readinessToken: "readiness-token",
		openWebUIApiUrl: "http://localhost:8080",
		adapterProviderUrl: "http://adapter:8765/v1",
		bindHost: "0.0.0.0",
		bindPort: 8765,
		gjcConfigDirName: ".hostile",
		gjcCodingAgentDir: path.join(root, "hostile-agent"),
	};
}
