import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import { resolveGjcSdkSessionRoot } from "../src/gjc/session-root";
import { SessionMappingStore } from "../src/gjc/session-router";
import {
	InMemoryOpenWebUIProjectionRepository,
	type OpenWebUIChatMessageRecord,
	type OpenWebUIChatRecord,
	type OpenWebUIFolderRecord,
	type OpenWebUIProjectionRepository,
} from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("project link registration", () => {
	test("dynamically linked projects import current-dev SDK transcripts", async () => {
		// Given: a transcript in the runtime agent directory before an admin project link.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-sdk-root-"));
		tempDirs.push(workspace);
		const home = path.join(workspace, "home");
		const projectDirectory = path.join(workspace, "SDK Project");
		await fs.mkdir(home);
		await fs.mkdir(projectDirectory);
		const runtimeLocations = resolveGjcRuntimeLocations({ mode: "existing", serviceHome: home });
		const sdkSessionRoot = resolveGjcSdkSessionRoot(projectDirectory, runtimeLocations);
		await fs.mkdir(sdkSessionRoot, { recursive: true });
		await writeSessionFile(path.join(sdkSessionRoot, "linked-sdk.jsonl"), {
			header: { id: "linked-sdk", title: "Linked SDK", cwd: projectDirectory },
			entries: [messageEntry("linked-user", null, "user", "linked SDK transcript")],
		});
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository: new InMemoryOpenWebUIProjectionRepository(),
			ownerUserId: "owner-1",
			protectedPaths: runtimeLocations.protectedProjectPaths,
			runtimeLocations,
		});

		// When: the project is dynamically linked.
		const linked = await service.linkProject({ cwd: projectDirectory, name: "SDK Project" });

		// Then: link-time historical sync discovers the SDK transcript.
		expect(linked.sync.imported).toMatchObject([
			{ sessionId: "linked-sdk", sessionFile: path.join(sdkSessionRoot, "linked-sdk.jsonl") },
		]);
	});

	test("keeps an explicit unlink across env seeding until the project is linked again", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-store-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Demo Project");
		await fs.mkdir(projectDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory({ cwd: projectDirectory, name: "Demo Project" }, allowedRoots);
		const store = new SqliteProjectRegistrationStore(":memory:");

		store.seedConfiguredProjects([project]);
		expect(store.listLinkedProjects()).toMatchObject([{ id: "demo-project", status: "linked" }]);

		expect(store.unlinkProject("demo-project")?.status).toBe("unlinked");
		store.seedConfiguredProjects([project]);
		expect(store.listLinkedProjects()).toEqual([]);
		expect(store.listProjects()).toMatchObject([{ id: "demo-project", status: "unlinked" }]);

		store.linkProject(project, "env");
		expect(store.listLinkedProjects()).toMatchObject([{ id: "demo-project", status: "linked" }]);
	});

	test("link imports sessions, unlink hides only OpenWebUI projection, and relink restores it", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-service-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Demo Project");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		const sessionFile = path.join(sessionRoot, "session-one.jsonl");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(sessionFile, {
			header: { id: "session-one", title: "Existing Session", cwd: projectDirectory },
			entries: [
				messageEntry("user-1", null, "user", "old prompt"),
				messageEntry("assistant-1", "user-1", "assistant", "old answer"),
			],
		});
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository,
			mappings: new SessionMappingStore(),
			ownerUserId: "owner-1",
			protectedPaths: protectedPathsFor(workspace),
		});

		const linked = await service.linkProject({ cwd: projectDirectory, name: "Demo Project" });
		expect(linked.sync.imported).toMatchObject([{ sessionId: "session-one", messageCount: 2 }]);
		expect(await repository.getChat("owner-1", "gjc-project-demo-project-session-session-one")).toMatchObject({
			folder_id: "gjc-project-demo-project",
			title: "Existing Session",
		});

		const unlinked = await service.unlinkProject("demo-project");
		expect(unlinked.project.status).toBe("unlinked");
		expect(service.listLinkedProjects()).toEqual([]);
		expect(await fs.stat(sessionFile)).toBeTruthy();
		expect(await repository.getChat("owner-1", "gjc-project-demo-project-session-session-one")).toBeUndefined();

		const relinked = await service.linkProject({ cwd: projectDirectory, name: "Demo Project" });
		expect(relinked.project.status).toBe("linked");
		expect(service.listLinkedProjects()).toHaveLength(1);
		expect(await repository.getChat("owner-1", "gjc-project-demo-project-session-session-one")).toMatchObject({
			title: "Existing Session",
		});
	});

	test("reconciles OpenWebUI folder deletion as an unlink without deleting local history", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-reconcile-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Deleted In UI");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		const sessionFile = path.join(sessionRoot, "session-one.jsonl");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(sessionFile, {
			header: { id: "session-one", title: "Restorable Session", cwd: projectDirectory },
			entries: [
				messageEntry("user-1", null, "user", "old prompt"),
				messageEntry("assistant-1", "user-1", "assistant", "old answer"),
			],
		});
		const repository = new FolderIdRemappingRepository("openwebui-deleted-folder-runtime");
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository,
			mappings: new SessionMappingStore(),
			ownerUserId: "owner-1",
			protectedPaths: protectedPathsFor(workspace),
		});
		await service.linkProject({ cwd: projectDirectory, name: "Deleted In UI" });

		await repository.deleteFolder("owner-1", "openwebui-deleted-folder-runtime", {
			deleteContents: true,
			expectedProjectId: "deleted-in-ui",
		});
		const result = await service.reconcileOpenWebUIFolderLinks();

		expect(result).toMatchObject({
			checked: 1,
			unlinked: [{ id: "deleted-in-ui", status: "unlinked" }],
		});
		expect(service.listLinkedProjects()).toEqual([]);
		expect(await fs.stat(sessionFile)).toBeTruthy();
		expect(await repository.getChat("owner-1", "gjc-project-deleted-in-ui-session-session-one")).toBeUndefined();

		await service.linkProject({ cwd: projectDirectory, name: "Deleted In UI" });

		expect(service.listLinkedProjects()).toMatchObject([{ id: "deleted-in-ui", status: "linked" }]);
		expect(await repository.getChat("owner-1", "gjc-project-deleted-in-ui-session-session-one")).toMatchObject({
			title: "Restorable Session",
		});
	});

	test("unlinks the actual OpenWebUI folder id returned by projection import", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-service-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "HTTP Project");
		await fs.mkdir(path.join(projectDirectory, ".gjc", "sessions"), { recursive: true });
		const repository = new FolderIdRemappingRepository("openwebui-folder-runtime");
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository,
			ownerUserId: "owner-1",
			protectedPaths: protectedPathsFor(workspace),
		});

		await service.linkProject({ cwd: projectDirectory, name: "HTTP Project" });
		expect(service.listProjects()).toMatchObject([
			{ id: "http-project", openWebUIFolderId: "openwebui-folder-runtime" },
		]);

		await service.unlinkProject("http-project");

		expect(repository.deletedFolders).toEqual(["openwebui-folder-runtime"]);
	});

	test("preserves runtime OpenWebUI folder ids across env seeding", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-service-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Env Runtime Folder");
		await fs.mkdir(projectDirectory);
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const store = new SqliteProjectRegistrationStore(":memory:");
		const repository = new FolderIdRemappingRepository("openwebui-runtime-folder");
		const service = new ProjectLinkService({
			allowedRoots,
			store,
			repository,
			ownerUserId: "owner-1",
			protectedPaths: protectedPathsFor(workspace),
		});
		await service.linkProject({ cwd: projectDirectory, name: "Env Runtime Folder" });
		const envProject = await registerProjectDirectory(
			{ cwd: projectDirectory, name: "Env Runtime Folder" },
			allowedRoots,
		);

		await service.seedConfiguredProjects([envProject]);

		expect(service.listProjects()).toMatchObject([
			{ id: "env-runtime-folder", openWebUIFolderId: "openwebui-runtime-folder" },
		]);
	});

	test("rejects project links outside the configured allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-service-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-outside-"));
		tempDirs.push(workspace, outside);
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			ownerUserId: "owner-1",
			protectedPaths: protectedPathsFor(workspace),
		});

		await expect(service.linkProject({ cwd: outside, name: "Outside" })).rejects.toThrow("outside allowed");
	});
});

function protectedPathsFor(workspace: string) {
	return resolveGjcRuntimeLocations({ mode: "existing", serviceHome: workspace }).protectedProjectPaths;
}

class FolderIdRemappingRepository implements OpenWebUIProjectionRepository {
	readonly deletedFolders: string[] = [];
	readonly #inner = new InMemoryOpenWebUIProjectionRepository();
	readonly #folderId: string;

	constructor(folderId: string) {
		this.#folderId = folderId;
	}

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		return await this.#inner.upsertFolder({ ...record, id: this.#folderId });
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		return await this.#inner.upsertChat(record);
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		return await this.#inner.replaceChatMessages(ownerUserId, chatId, messages);
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined> {
		return await this.#inner.getChat(ownerUserId, chatId);
	}

	async getFolder(ownerUserId: string, folderId: string): Promise<OpenWebUIFolderRecord | undefined> {
		return await this.#inner.getFolder(ownerUserId, folderId);
	}

	async deleteFolder(
		ownerUserId: string,
		folderId: string,
		options: { readonly deleteContents: boolean; readonly expectedProjectId?: string },
	): Promise<void> {
		this.deletedFolders.push(folderId);
		await this.#inner.deleteFolder(ownerUserId, folderId, options);
	}
}
