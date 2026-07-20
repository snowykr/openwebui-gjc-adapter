import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGjcSdkSessionRoot } from "../src/gjc/session-root";
import { SessionMappingStore } from "../src/gjc/session-router";
import {
	InMemoryOpenWebUIProjectionRepository,
	type OpenWebUIChatMessageRecord,
	type OpenWebUIChatRecord,
	type OpenWebUIFolderRecord,
	type OpenWebUIProjectionRepository,
} from "../src/openwebui/client";
import { syncProjectSessionsToOpenWebUI } from "../src/projection/session-sync";
import { disambiguateRegisteredProjects, registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

const tempDirs: string[] = [];

class RecordingOpenWebUIProjectionRepository implements OpenWebUIProjectionRepository {
	readonly folders: OpenWebUIFolderRecord[] = [];
	#repository = new InMemoryOpenWebUIProjectionRepository();

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		const folder = await this.#repository.upsertFolder(record);
		this.folders.push(folder);
		return folder;
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		return this.#repository.upsertChat(record);
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		return this.#repository.replaceChatMessages(ownerUserId, chatId, messages);
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined> {
		return this.#repository.getChat(ownerUserId, chatId);
	}
}

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("syncProjectSessionsToOpenWebUI collision handling", () => {
	test("skips an SDK session owned by another project when cwd encodings collide", async () => {
		// Given: two distinct project paths that encode to the same upstream-managed session root.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-encoded-collision-"));
		tempDirs.push(workspace);
		const projectA = path.join(workspace, "a-b", "c");
		const projectB = path.join(workspace, "a", "b-c");
		const runtimeLocations = {
			home: workspace,
			agentDir: path.join(workspace, ".gjc", "agent"),
		};
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });
		const sessionRootA = resolveGjcSdkSessionRoot(projectA, runtimeLocations);
		const sessionRootB = resolveGjcSdkSessionRoot(projectB, runtimeLocations);
		expect(sessionRootA).toBe(sessionRootB);
		const sessionFile = path.join(sessionRootA, "belongs-to-b.jsonl");
		await fs.mkdir(sessionRootA, { recursive: true });
		await writeSessionFile(sessionFile, {
			header: { id: "belongs-to-b", title: "Project B", cwd: projectB },
			entries: [messageEntry("project-b-user", null, "user", "must stay in project B")],
		});
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const registeredA = await registerProjectDirectory({ cwd: projectA, name: "Project A" }, allowedRoots);
		const repository = new RecordingOpenWebUIProjectionRepository();
		const mappings = new SessionMappingStore();

		// When: historical synchronization scans the collided SDK root for project A.
		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: [registeredA],
			mappings,
			runtimeLocations,
		});

		// Then: ownership is rejected before any chat import or mapping side effect.
		expect(result.imported).toEqual([]);
		expect(result.skipped).toEqual([
			{
				projectId: registeredA.id,
				filePath: sessionFile,
				code: "session_cwd_mismatch",
				message: `GJC session cwd ${projectB} does not match project cwd ${projectA}`,
			},
		]);
		expect(mappings.entries()).toEqual([]);
		expect(await repository.getChat("owner-1", `gjc-project-${registeredA.id}-session-belongs-to-b`)).toBeUndefined();
	});

	test("imports a configured-root session whose cwd is a symlink-equivalent project path", async () => {
		// Given: a configured-root transcript whose header names a symlink to the registered project.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-symlink-cwd-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "project");
		const projectAlias = path.join(workspace, "project-alias");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		await fs.mkdir(sessionRoot, { recursive: true });
		await fs.symlink(projectDirectory, projectAlias, "dir");
		const sessionFile = path.join(sessionRoot, "symlink-equivalent.jsonl");
		await writeSessionFile(sessionFile, {
			header: { id: "symlink-equivalent", title: "Equivalent", cwd: projectAlias },
			entries: [messageEntry("equivalent-user", null, "user", "same project")],
		});
		const project = await registerProjectDirectory(
			{ cwd: projectDirectory, name: "Equivalent Project" },
			await resolveAllowedRoots([workspace]),
		);

		// When: historical synchronization reads the configured session root.
		const result = await syncProjectSessionsToOpenWebUI({
			repository: new RecordingOpenWebUIProjectionRepository(),
			ownerUserId: "owner-1",
			projects: [project],
		});

		// Then: canonical path equivalence admits the session.
		expect(result.imported).toMatchObject([{ sessionId: "symlink-equivalent", sessionFile }]);
		expect(result.skipped).toEqual([]);
	});

	test("keeps same-basename projects with shared session ids in separate folders and chats", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-sync-same-name-"));
		tempDirs.push(workspace);
		const projectA = path.join(workspace, "alpha", "Same");
		const projectB = path.join(workspace, "beta", "Same");
		const sessionRootA = path.join(projectA, ".gjc", "sessions");
		const sessionRootB = path.join(projectB, ".gjc", "sessions");
		await fs.mkdir(sessionRootA, { recursive: true });
		await fs.mkdir(sessionRootB, { recursive: true });
		await writeSessionFile(path.join(sessionRootA, "shared.jsonl"), {
			header: { id: "shared-session", title: "Shared A", cwd: projectA },
			entries: [messageEntry("shared-user-a", null, "user", "from same A")],
		});
		await writeSessionFile(path.join(sessionRootB, "shared.jsonl"), {
			header: { id: "shared-session", title: "Shared B", cwd: projectB },
			entries: [messageEntry("shared-user-b", null, "user", "from same B")],
		});
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const registeredProjects = disambiguateRegisteredProjects([
			await registerProjectDirectory({ cwd: projectA }, allowedRoots),
			await registerProjectDirectory({ cwd: projectB }, allowedRoots),
		]);
		const repository = new RecordingOpenWebUIProjectionRepository();

		const result = await syncProjectSessionsToOpenWebUI({
			repository,
			ownerUserId: "owner-1",
			projects: registeredProjects,
		});

		expect(result.imported).toHaveLength(2);
		expect(new Set(result.imported.map(item => item.projectId)).size).toBe(2);
		expect(new Set(result.imported.map(item => item.folderId)).size).toBe(2);
		expect(new Set(result.imported.map(item => item.chatId)).size).toBe(2);
		expect(Array.from(new Set(repository.folders.map(folder => folder.name))).sort()).toEqual([
			"Same (alpha/Same)",
			"Same (beta/Same)",
		]);
		const importedContents = await Promise.all(
			result.imported.map(async imported => {
				const chat = await repository.getChat("owner-1", imported.chatId);
				expect(chat?.folder_id).toBe(imported.folderId);
				return Object.values(chat?.history.messages ?? {}).map(message => message.content);
			}),
		);
		expect(importedContents).toEqual([["from same A"], ["from same B"]]);
	});
});
