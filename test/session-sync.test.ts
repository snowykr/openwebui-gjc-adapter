import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionMappingStore } from "../src/gjc/session-router";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { syncProjectSessionsToOpenWebUI } from "../src/projection/session-sync";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("syncProjectSessionsToOpenWebUI", () => {
	test("imports transcripts from the current-dev SDK cwd-scoped session directory", async () => {
		// Given: a project whose transcript was written under agentDir, not its configured sessionRoot.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-sdk-root-"));
		tempDirs.push(workspace);
		const home = path.join(workspace, "home");
		const agentDir = path.join(home, ".gjc", "agent");
		const projectDirectory = path.join(workspace, "Project SDK");
		const sdkSessionRoot = path.join(agentDir, "sessions", `-tmp-${path.basename(workspace)}-Project SDK`);
		await fs.mkdir(sdkSessionRoot, { recursive: true });
		await writeSessionFile(path.join(sdkSessionRoot, "sdk-session.jsonl"), {
			header: { id: "sdk-session", title: "SDK Session", cwd: projectDirectory },
			entries: [messageEntry("sdk-user", null, "user", "new SDK transcript")],
		});
		await fs.mkdir(projectDirectory, { recursive: true });
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory(
			{ cwd: projectDirectory, name: "Project SDK", sessionRoot: path.join(workspace, "adapter-session-root") },
			allowedRoots,
		);
		const repository = new InMemoryOpenWebUIProjectionRepository();

		// When: historical synchronization runs with the same runtime locations as the SDK broker.
		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: [project],
			runtimeLocations: { home, agentDir },
		});

		// Then: the newly written SDK transcript is imported despite the configured mapping root.
		expect(result.imported).toMatchObject([
			{ sessionId: "sdk-session", sessionFile: path.join(sdkSessionRoot, "sdk-session.jsonl") },
		]);
	});

	test("imports existing project session files into owner-scoped OpenWebUI folders and mappings", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Project One");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(path.join(sessionRoot, "session-one.jsonl"), {
			header: { id: "session-one", title: "Imported One", cwd: projectDirectory },
			entries: [
				messageEntry("u1", null, "user", "existing prompt"),
				messageEntry("a1", "u1", "assistant", "existing answer"),
			],
		});

		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory({ cwd: projectDirectory, name: "Project One" }, allowedRoots);
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const mappings = new SessionMappingStore();

		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: [project],
			mappings,
		});

		expect(result).toMatchObject({
			imported: [
				{
					projectId: "project-one",
					sessionId: "session-one",
					chatId: "gjc-project-project-one-session-session-one",
					folderId: "gjc-project-project-one",
					messageCount: 2,
				},
			],
			skipped: [],
		});
		const chat = await repository.getChat("owner-1", "gjc-project-project-one-session-session-one");
		expect(chat).toMatchObject({
			folder_id: "gjc-project-project-one",
			title: "Imported One",
			history: {
				currentId: "gjc-session-session-one-message-a1",
			},
		});
		expect(Object.values(chat?.history.messages ?? {}).map(message => message.content)).toEqual([
			"existing prompt",
			"existing answer",
		]);
		expect(mappings.entries()).toMatchObject([
			{
				chatId: "gjc-project-project-one-session-session-one",
				projectId: "project-one",
				sessionId: "session-one",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "historical-import",
			},
		]);
	});

	test("keeps projects separate and skips malformed session files without aborting valid imports", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-"));
		tempDirs.push(workspace);
		const projectA = path.join(workspace, "Project A");
		const projectB = path.join(workspace, "Project B");
		const sessionRootA = path.join(projectA, ".gjc", "sessions");
		const sessionRootB = path.join(projectB, ".gjc", "sessions");
		await fs.mkdir(sessionRootA, { recursive: true });
		await fs.mkdir(sessionRootB, { recursive: true });
		await writeSessionFile(path.join(sessionRootA, "a.jsonl"), {
			header: { id: "session-a", title: "Session A", cwd: projectA },
			entries: [messageEntry("a-user", null, "user", "from A")],
		});
		await Bun.write(path.join(sessionRootA, "broken.jsonl"), "{not-json\n");
		const loopCwd = path.join(workspace, "loop-cwd");
		await fs.symlink(loopCwd, loopCwd);
		await writeSessionFile(path.join(sessionRootA, "loop.jsonl"), {
			header: { id: "session-loop", title: "Session Loop", cwd: loopCwd },
			entries: [messageEntry("loop-user", null, "user", "must be skipped")],
		});
		await writeSessionFile(path.join(sessionRootB, "b.jsonl"), {
			header: { id: "session-b", title: "Session B", cwd: projectB },
			entries: [messageEntry("b-user", null, "user", "from B")],
		});

		const allowedRoots = await resolveAllowedRoots([workspace]);
		const registeredA = await registerProjectDirectory({ cwd: projectA, name: "Project A" }, allowedRoots);
		const registeredB = await registerProjectDirectory({ cwd: projectB, name: "Project B" }, allowedRoots);
		const repository = new InMemoryOpenWebUIProjectionRepository();

		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: [registeredA, registeredB],
		});

		expect(result.imported.map(item => [item.projectId, item.sessionId, item.folderId])).toEqual([
			["project-a", "session-a", "gjc-project-project-a"],
			["project-b", "session-b", "gjc-project-project-b"],
		]);
		expect(result.skipped).toEqual([
			expect.objectContaining({
				projectId: "project-a",
				filePath: path.join(sessionRootA, "broken.jsonl"),
				code: "empty_session_file",
			}),
			{
				projectId: "project-a",
				filePath: path.join(sessionRootA, "loop.jsonl"),
				code: "session_cwd_invalid",
				message: "GJC session cwd could not be resolved",
			},
		]);
		expect((await repository.getChat("owner-1", "gjc-project-project-a-session-session-a"))?.folder_id).toBe(
			"gjc-project-project-a",
		);
		expect((await repository.getChat("owner-1", "gjc-project-project-b-session-session-b"))?.folder_id).toBe(
			"gjc-project-project-b",
		);
	});

	test("skips duplicate session ids in one project instead of overwriting imported history", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Project Duplicate");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(path.join(sessionRoot, "a-first.jsonl"), {
			header: { id: "session-duplicate", title: "First", cwd: projectDirectory },
			entries: [messageEntry("first-user", null, "user", "first history")],
		});
		await writeSessionFile(path.join(sessionRoot, "b-second.jsonl"), {
			header: { id: "session-duplicate", title: "Second", cwd: projectDirectory },
			entries: [messageEntry("second-user", null, "user", "second history")],
		});
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory(
			{ cwd: projectDirectory, name: "Project Duplicate" },
			allowedRoots,
		);
		const repository = new InMemoryOpenWebUIProjectionRepository();

		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: [project],
		});

		expect(result.imported).toHaveLength(1);
		expect(result.skipped).toEqual([
			expect.objectContaining({
				projectId: "project-duplicate",
				filePath: path.join(sessionRoot, "b-second.jsonl"),
				code: "duplicate_session_id",
			}),
		]);
		const chat = await repository.getChat("owner-1", "gjc-project-project-duplicate-session-session-duplicate");
		expect(Object.values(chat?.history.messages ?? {}).map(message => message.content)).toEqual(["first history"]);
	});

	test("updates the latest historical mapping when stale mappings share a session id", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Project One");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(path.join(sessionRoot, "session-one.jsonl"), {
			header: { id: "session-one", title: "Imported One", cwd: projectDirectory },
			entries: [messageEntry("u1", null, "user", "latest mapped history")],
		});
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory({ cwd: projectDirectory, name: "Project One" }, allowedRoots);
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const mappings = new SessionMappingStore();
		mappings.upsert({
			chatId: "stale-live-chat",
			projectId: "project-one",
			sessionId: "session-one",
			sessionFile: path.join(sessionRoot, "old.jsonl"),
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "live-turn",
		});
		mappings.upsert({
			chatId: "historical-chat",
			projectId: "project-one",
			sessionId: "session-one",
			sessionFile: path.join(sessionRoot, "session-one.jsonl"),
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "historical-import",
		});

		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: [project],
			mappings,
		});

		expect(result.imported).toMatchObject([{ chatId: "historical-chat", sessionId: "session-one" }]);
		expect(await repository.getChat("owner-1", "gjc-session-session-one")).toBeUndefined();
		expect(await repository.getChat("owner-1", "historical-chat")).toMatchObject({
			folder_id: "gjc-project-project-one",
			history: { currentId: "gjc-session-session-one-message-u1" },
		});
	});
});
