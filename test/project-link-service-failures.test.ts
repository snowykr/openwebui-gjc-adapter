import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	OpenWebUIChatMessageRecord,
	OpenWebUIChatRecord,
	OpenWebUIFolderRecord,
	OpenWebUIProjectionRepository,
} from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import * as pathsModule from "../src/security/paths";
import { resolveAllowedRoots } from "../src/security/paths";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("project link registration failure handling", () => {
	test("detects overlap symmetrically while allowing a sibling", () => {
		// Given: equal, ancestor, descendant, and sibling path pairs.
		const root = path.join(os.tmpdir(), "gjc-overlap-root");
		const descendant = path.join(root, "child");
		const sibling = path.join(path.dirname(root), "gjc-overlap-sibling");

		// When: the public overlap predicate compares both directions.
		const overlap = pathOverlapExport();
		expect(overlap).not.toBeUndefined();
		if (overlap === undefined) return;
		const relations = [
			overlap(root, root),
			overlap(root, descendant),
			overlap(descendant, root),
			overlap(root, sibling),
		];

		// Then: only equality and ancestry in either direction overlap.
		expect(relations).toEqual([true, true, true, false]);
	});

	test("resolves an existing symlink and a prospective descendant through its real parent", async () => {
		// Given: a real directory exposed through a symlink alias.
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-canonical-path-"));
		tempDirs.push(workspace);
		const realRoot = path.join(workspace, "real-root");
		const alias = path.join(workspace, "alias");
		await fs.mkdir(realRoot);
		await fs.symlink(realRoot, alias);

		// When: existing and not-yet-created paths are canonicalized.
		const canonicalize = pathCanonicalizerExport();
		expect(canonicalize).not.toBeUndefined();
		if (canonicalize === undefined) return;
		const existing = await canonicalize(alias);
		const prospective = await canonicalize(path.join(alias, "future", "project"));

		// Then: both paths are expressed below the canonical real root.
		expect(existing).toBe(realRoot);
		expect(prospective).toBe(path.join(realRoot, "future", "project"));
	});

	test("preserves linked state when projection deletion fails", async () => {
		const { service, projectDirectory } = await serviceForTempProject(
			"Delete Failure",
			new FailingDeleteRepository(),
		);

		await service.linkProject({ cwd: projectDirectory, name: "Delete Failure" });
		await expect(service.unlinkProject("delete-failure")).rejects.toThrow("delete failed");

		expect(service.listLinkedProjects()).toMatchObject([{ id: "delete-failure", status: "linked" }]);
	});

	test("rolls back visible registration when projection sync fails during link", async () => {
		const { service, projectDirectory } = await serviceForTempProject("Sync Failure", new FailingSyncRepository());

		await expect(service.linkProject({ cwd: projectDirectory, name: "Sync Failure" })).rejects.toThrow("sync failed");

		expect(service.listLinkedProjects()).toEqual([]);
		expect(service.listProjects()).toMatchObject([{ id: "sync-failure", status: "unlinked" }]);
	});

	test("rolls back visible registration when session projection write fails", async () => {
		const { service, projectDirectory } = await serviceForTempProject(
			"Message Write Failure",
			new FailingMessageWriteRepository(),
		);
		await writeMinimalSession(projectDirectory);

		await expect(service.linkProject({ cwd: projectDirectory, name: "Message Write Failure" })).rejects.toThrow(
			"message write failed",
		);

		expect(service.listLinkedProjects()).toEqual([]);
		expect(service.listProjects()).toMatchObject([{ id: "message-write-failure", status: "unlinked" }]);
	});

	test("keeps an existing linked project visible when equivalent-path relink sync fails", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-service-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Equivalent Path");
		await fs.mkdir(projectDirectory);
		const repository = new ToggleFailingSyncRepository();
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository,
			ownerUserId: "owner-1",
		});
		await service.linkProject({ cwd: projectDirectory, name: "Equivalent Path" });
		repository.failNextSync = true;
		const equivalentCwd = path.join(workspace, "equivalent-link");
		await fs.symlink(projectDirectory, equivalentCwd);

		await expect(service.linkProject({ cwd: equivalentCwd, name: "Equivalent Path" })).rejects.toThrow("sync failed");

		expect(service.listLinkedProjects()).toMatchObject([{ id: "equivalent-path", status: "linked" }]);
	});
});

type PathOverlap = (leftPath: string, rightPath: string) => boolean;
type PathCanonicalizer = (targetPath: string) => Promise<string>;

function pathOverlapExport(): PathOverlap | undefined {
	const candidate: unknown = Reflect.get(pathsModule, "pathsOverlap");
	if (typeof candidate !== "function") return undefined;
	return (leftPath, rightPath) => {
		const result: unknown = Reflect.apply(candidate, pathsModule, [leftPath, rightPath]);
		if (typeof result !== "boolean") throw new Error("Path overlap export returned an invalid result.");
		return result;
	};
}

function pathCanonicalizerExport(): PathCanonicalizer | undefined {
	const candidate: unknown = Reflect.get(pathsModule, "resolveExistingOrProspectivePath");
	if (typeof candidate !== "function") return undefined;
	return async targetPath => {
		const result: unknown = await Reflect.apply(candidate, pathsModule, [targetPath]);
		if (typeof result !== "string") throw new Error("Path canonicalizer export returned an invalid result.");
		return result;
	};
}

async function serviceForTempProject(name: string, repository: OpenWebUIProjectionRepository) {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-link-service-"));
	tempDirs.push(workspace);
	const projectDirectory = path.join(workspace, name);
	await fs.mkdir(projectDirectory);
	const service = new ProjectLinkService({
		allowedRoots: await resolveAllowedRoots([workspace]),
		store: new SqliteProjectRegistrationStore(":memory:"),
		repository,
		ownerUserId: "owner-1",
	});
	return { service, projectDirectory };
}

class FailingDeleteRepository implements OpenWebUIProjectionRepository {
	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		return record;
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		return record;
	}

	async replaceChatMessages(
		_ownerUserId: string,
		_chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		return messages;
	}

	async getChat(): Promise<OpenWebUIChatRecord | undefined> {
		return undefined;
	}

	async deleteFolder(): Promise<void> {
		throw new Error("delete failed");
	}
}

class FailingSyncRepository extends FailingDeleteRepository {
	override async upsertFolder(): Promise<OpenWebUIFolderRecord> {
		throw new Error("sync failed");
	}
}

class ToggleFailingSyncRepository extends FailingDeleteRepository {
	failNextSync = false;

	override async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		if (this.failNextSync) throw new Error("sync failed");
		return record;
	}
}

class FailingMessageWriteRepository extends FailingDeleteRepository {
	override async replaceChatMessages(): Promise<readonly OpenWebUIChatMessageRecord[]> {
		throw new Error("message write failed");
	}
}

async function writeMinimalSession(projectDirectory: string): Promise<void> {
	const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
	await fs.mkdir(sessionRoot, { recursive: true });
	await Bun.write(
		path.join(sessionRoot, "session-one.jsonl"),
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-one",
				title: "Session One",
				timestamp: "2026-07-08T00:00:00.000Z",
				cwd: projectDirectory,
			}),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-07-08T00:00:01.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			}),
		].join("\n"),
	);
}
