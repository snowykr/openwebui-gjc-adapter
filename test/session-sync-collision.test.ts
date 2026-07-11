import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InMemoryOpenWebUIProjectionRepository,
	type OpenWebUIChatMessageRecord,
	type OpenWebUIChatOwnerResolution,
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
	async resolveChatOwner(
		_ownerUserId: string,
		_chatId: string,
	): Promise<OpenWebUIChatOwnerResolution> {
		return { kind: "missing" };
	}
}

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("syncProjectSessionsToOpenWebUI collision handling", () => {
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
