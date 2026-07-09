import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import { createAdapterRequestHandler } from "../src/server";
import { chatRequest, FakeGjcTurnRunner } from "./cli-fixtures";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

describe("adapter CLI project reconciliation", () => {
	test("does not unlink a first-start env project with a configured folder id before sync creates it", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-reconcile-"));
		const projectDirectory = path.join(workspace, "Configured Folder");
		const sessionDirectory = path.join(projectDirectory, ".gjc", "sessions");
		await fs.mkdir(sessionDirectory, { recursive: true });
		await writeSessionFile(path.join(sessionDirectory, "session-import.jsonl"), {
			header: { id: "session-import", title: "Configured Folder Import", cwd: projectDirectory },
			entries: [messageEntry("user-import", null, "user", "load me")],
		});
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const store = new SqliteProjectRegistrationStore(":memory:");

		const options = await buildAdapterServerOptionsFromEnv(
			envFor(workspace, `${projectDirectory}|Configured Folder|configured-folder`),
			{
				turnRunner: new FakeGjcTurnRunner(),
				projectionRepository: repository,
				projectRegistrationStore: store,
			},
		);

		expect(options.routes?.projects).toMatchObject([{ id: "configured-folder", status: "linked" }]);
		expect(store.getProject("configured-folder")).toMatchObject({
			status: "linked",
			openWebUIFolderId: "configured-folder",
		});
		expect(await repository.getFolder("owner-test", "configured-folder")).toMatchObject({
			id: "configured-folder",
		});
		expect(
			await repository.getChat("owner-test", "gjc-project-configured-folder-session-session-import"),
		).toMatchObject({
			title: "Configured Folder Import",
		});
	});

	test("hides a project during model and project-list requests after its OpenWebUI folder is deleted", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-reconcile-"));
		const projectDirectory = path.join(workspace, "Deleted During Runtime");
		const sessionDirectory = path.join(projectDirectory, ".gjc", "sessions");
		await fs.mkdir(sessionDirectory, { recursive: true });
		await writeSessionFile(path.join(sessionDirectory, "session-import.jsonl"), {
			header: { id: "session-import", title: "Runtime Delete Import", cwd: projectDirectory },
			entries: [messageEntry("user-import", null, "user", "load me")],
		});
		const allowedRoots = await resolveAllowedRoots([workspace]);
		const project = await registerProjectDirectory(
			{
				cwd: projectDirectory,
				name: "Deleted During Runtime",
				openWebUIFolderId: "runtime-folder",
			},
			allowedRoots,
		);
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const store = new SqliteProjectRegistrationStore(":memory:");
		store.linkProject(project, "admin");
		await repository.upsertFolder({
			id: "runtime-folder",
			owner_user_id: "owner-test",
			name: "Deleted During Runtime",
			metadata: { gjc_adapter: { projectId: "deleted-during-runtime" } },
		});
		const options = await buildAdapterServerOptionsFromEnv(envFor(workspace, ""), {
			turnRunner: new FakeGjcTurnRunner(),
			projectionRepository: repository,
			projectRegistrationStore: store,
		});
		const routes = options.routes;
		if (routes === undefined) throw new Error("expected route dependencies");
		const handler = createAdapterRequestHandler({ routes });
		await repository.deleteFolder("owner-test", "runtime-folder", {
			deleteContents: true,
			expectedProjectId: "deleted-during-runtime",
		});

		const modelsResponse = await handler(authenticatedRequest("http://adapter.test/v1/models"));
		const models = await modelsResponse.json();
		const projectListResponse = await handler(projectListRequest());
		const projectList = await projectListResponse.json();

		expect(modelIds(models)).not.toContain("gjc/deleted-during-runtime");
		expect(projectListText(projectList)).toContain("unlinked: gjc/deleted-during-runtime");
		expect(store.getProject("deleted-during-runtime")).toMatchObject({ status: "unlinked" });
	});
});

function envFor(workspace: string, projects: string): Record<string, string | undefined> {
	return {
		...process.env,
		GJC_OPENWEBUI_BIND_HOST: "127.0.0.1",
		GJC_OPENWEBUI_BIND_PORT: "8765",
		GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
		GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
		GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
		GJC_OPENWEBUI_SESSION_ROOT: path.join(workspace, "state"),
		GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "adapter-state"),
		GJC_OPENWEBUI_PROJECTS: projects,
	};
}

function authenticatedRequest(url: string): Request {
	return new Request(url, { headers: { authorization: "Bearer adapter-token" } });
}

function projectListRequest(): Request {
	const source = chatRequest();
	return new Request(source.url, {
		method: "POST",
		headers: source.headers,
		body: JSON.stringify({ model: "gjc/projects", messages: [{ role: "user", content: "/gjc project list" }] }),
	});
}

function modelIds(value: unknown): readonly string[] {
	if (!isRecord(value) || !Array.isArray(value.data)) return [];
	return value.data.map(item => (isRecord(item) && typeof item.id === "string" ? item.id : "")).filter(Boolean);
}

function projectListText(value: unknown): string {
	if (!isRecord(value) || !Array.isArray(value.choices)) return "";
	const first = value.choices[0];
	if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") return "";
	return first.message.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
