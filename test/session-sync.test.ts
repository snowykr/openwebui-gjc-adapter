import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import { SessionMappingStore } from "../src/gjc/session-router";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { syncProjectSessionsToOpenWebUI } from "../src/projection/session-sync";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("syncProjectSessionsToOpenWebUI", () => {
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
					chatId: "gjc-session-session-one",
					folderId: "gjc-project-project-one",
					messageCount: 2,
				},
			],
			skipped: [],
		});
		const chat = await repository.getChat("owner-1", "gjc-session-session-one");
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
				chatId: "gjc-session-session-one",
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
		]);
		expect((await repository.getChat("owner-1", "gjc-session-session-a"))?.folder_id).toBe("gjc-project-project-a");
		expect((await repository.getChat("owner-1", "gjc-session-session-b"))?.folder_id).toBe("gjc-project-project-b");
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
		const chat = await repository.getChat("owner-1", "gjc-session-session-duplicate");
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

async function writeSessionFile(
	filePath: string,
	input: {
		readonly header: Pick<SessionHeader, "id" | "title" | "cwd">;
		readonly entries: readonly SessionMessageEntry[];
	},
): Promise<void> {
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: input.header.id,
		title: input.header.title,
		timestamp: "2026-07-08T00:00:00.000Z",
		cwd: input.header.cwd,
	};
	await Bun.write(filePath, `${[header, ...input.entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

function messageEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	content: string,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		message: agentMessage(role, content),
	};
}

function agentMessage(role: "user" | "assistant", content: string): SessionMessageEntry["message"] {
	if (role === "user") return { role, content, timestamp: 1 };
	return {
		role,
		content: [{ type: "text", text: content }],
		api: "openai-responses",
		provider: "gjc",
		model: "gjc-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}
