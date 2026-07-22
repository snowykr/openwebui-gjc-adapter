import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { resolveAllowedRoots } from "../src/security/paths";
import { createAdapterRequestHandler } from "../src/server";
import { LOW_MODEL_ID, staticModelReaderFactory } from "./model-selection-fixtures";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("project admin route security boundaries", () => {
	test("rejects admin slash commands from a different forwarded OpenWebUI owner", async () => {
		const { handler, projectDirectory, service } = await adminHandlerForTempProject("Owner Mismatch");

		const response = await handler(
			chatCommandRequest(
				{
					model: "gjc",
					messages: [{ role: "user", content: `/gjc project link ${projectDirectory}` }],
				},
				{ userId: "owner-2" },
			),
		);

		expect(response.status).toBe(401);
		expect(service.listLinkedProjects()).toEqual([]);
	});

	test("does not execute admin slash commands for OpenWebUI background tasks", async () => {
		const { handler, projectDirectory, service } = await adminHandlerForTempProject("Background Task");

		const response = await handler(
			chatCommandRequest(
				{
					model: "gjc",
					messages: [{ role: "user", content: `/gjc project link ${projectDirectory}` }],
				},
				{ task: "title" },
			),
		);

		expect(response.status).toBe(200);
		expect(service.listLinkedProjects()).toEqual([]);
	});

	test("fails closed without alias output when a background admin reader is missing", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const { handler } = await buildHandler(workspace, undefined, false);
		const response = await handler(
			chatCommandRequest(
				{ model: "gjc", messages: [{ role: "user", content: "/gjc project list" }] },
				{ task: "title" },
			),
		);
		expect(response.status).toBe(409);
		const body = await response.text();
		expect(body).toContain('"code":"model_selection_default_read_failed"');
		expect(body).not.toContain('"model":"gjc"');
	});

	test.each([
		["canonical admin", {}],
		["canonical background admin", { task: "title" }],
	] as const)("maps a missing reader for %s to canonical unavailability", async (_label, options) => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const { handler } = await buildHandler(workspace, undefined, false);
		const response = await handler(
			chatCommandRequest(
				{ model: LOW_MODEL_ID, messages: [{ role: "user", content: "/gjc project list" }] },
				options,
			),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "model_selection_not_available" } });
	});

	test("routes an advertised base model admin command and applies reasoning effort", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const { handler } = await buildHandler(workspace);
		const response = await handler(
			chatCommandRequest({
				model: "gjc/anthropic/claude-sonnet-4",
				reasoning_effort: "medium",
				messages: [{ role: "user", content: "/gjc project list" }],
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			model: "gjc/anthropic/claude-sonnet-4:medium",
		});
	});

	test("rejects malformed unlink path encoding with a client error", async () => {
		const { handler } = await adminHandlerForTempProject("Unused");

		const response = await handler(
			new Request("http://adapter.test/admin/projects/%E0%A4%A/unlink", {
				method: "POST",
				headers: { authorization: "Bearer adapter-token" },
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_project_id" } });
	});

	test("ignores caller-supplied OpenWebUI folder ids when linking from admin HTTP", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Injected Folder");
		await fs.mkdir(projectDirectory);
		const repository = new InMemoryOpenWebUIProjectionRepository();
		await repository.upsertFolder({
			id: "victim-folder",
			owner_user_id: "owner-1",
			name: "User folder",
			metadata: {},
		});
		await repository.upsertChat({
			id: "victim-chat",
			owner_user_id: "owner-1",
			folder_id: "victim-folder",
			title: "Do not delete",
			metadata: {},
			history: { messages: {}, currentId: null },
		});
		const { handler } = await buildHandler(workspace, repository);

		const linked = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", {
				cwd: projectDirectory,
				openWebUIFolderId: "victim-folder",
			}),
		);
		expect(linked.status).toBe(200);
		const unlinked = await handler(
			new Request("http://adapter.test/admin/projects/injected-folder/unlink", {
				method: "POST",
				headers: { authorization: "Bearer adapter-token" },
			}),
		);

		expect(unlinked.status).toBe(200);
		expect(await repository.getChat("owner-1", "victim-chat")).toMatchObject({ title: "Do not delete" });
	});
});

const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

async function adminHandlerForTempProject(name: string) {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
	tempDirs.push(workspace);
	const projectDirectory = path.join(workspace, name);
	await fs.mkdir(projectDirectory);
	return { ...(await buildHandler(workspace)), projectDirectory };
}

async function buildHandler(
	workspace: string,
	repository?: InMemoryOpenWebUIProjectionRepository,
	includeModelReader = true,
) {
	const service = new ProjectLinkService({
		allowedRoots: await resolveAllowedRoots([workspace]),
		store: new SqliteProjectRegistrationStore(":memory:"),
		...(repository === undefined ? {} : { repository }),
		ownerUserId: "owner-1",
		protectedPaths: resolveGjcRuntimeLocations({ mode: "existing", serviceHome: workspace }).protectedProjectPaths,
	});
	const handler = createAdapterRequestHandler({
		routes: {
			projects: [],
			projectProvider: () => service.listLinkedProjects(),
			projectLinkService: service,
			owner,
			runner: fixedRunner("unused"),
			...(includeModelReader ? { modelReaderFactory: staticModelReaderFactory() } : {}),
			adapterApiToken: "adapter-token",
			requireAdapterApiToken: true,
		},
	});
	return { handler, service };
}

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content }) };
}

function jsonRequest(url: string, body: unknown): Request {
	return new Request(url, {
		method: "POST",
		headers: { authorization: "Bearer adapter-token", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function chatCommandRequest(
	body: unknown,
	options: { readonly userId?: string; readonly task?: string } = {},
): Request {
	const headers = new Headers({
		authorization: "Bearer adapter-token",
		"content-type": "application/json",
		"X-OpenWebUI-Chat-Id": "chat-1",
		"X-OpenWebUI-Message-Id": "assistant-1",
		"X-OpenWebUI-User-Message-Id": "user-1",
		"X-OpenWebUI-User-Message-Parent-Id": "",
		"X-OpenWebUI-User-Id": options.userId ?? "owner-1",
	});
	if (options.task !== undefined) headers.set("X-OpenWebUI-Task", options.task);
	return new Request("http://adapter.test/v1/chat/completions", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}
