import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionMappingStore } from "../src/gjc/session-router";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { resolveAllowedRoots } from "../src/security/paths";
import { createAdapterRequestHandler } from "../src/server";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("project admin routes", () => {
	test("links, exposes, unlinks, and relinks a project without deleting local GJC sessions", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Admin Project");
		const sessionRoot = path.join(projectDirectory, ".gjc", "sessions");
		const sessionFile = path.join(sessionRoot, "session-one.jsonl");
		await fs.mkdir(sessionRoot, { recursive: true });
		await writeSessionFile(sessionFile, {
			header: { id: "session-one", title: "Admin Session", cwd: projectDirectory },
			entries: [messageEntry("user-1", null, "user", "load admin history")],
		});
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			repository,
			mappings: new SessionMappingStore(),
			ownerUserId: "owner-1",
		});
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const linked = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", {
				cwd: projectDirectory,
				name: "Admin Project",
			}),
		);
		expect(linked.status).toBe(200);
		expect(await linked.json()).toMatchObject({
			project: { id: "admin-project", status: "linked" },
			sync: { imported: [{ sessionId: "session-one" }] },
		});
		expect(await modelIds(handler)).toEqual(["gjc"]);

		const unlinked = await handler(
			new Request("http://adapter.test/admin/projects/admin-project/unlink", {
				method: "POST",
				headers: { authorization: "Bearer adapter-token" },
			}),
		);
		expect(unlinked.status).toBe(200);
		expect(await unlinked.json()).toMatchObject({ project: { id: "admin-project", status: "unlinked" } });
		expect(await modelIds(handler)).toEqual(["gjc"]);
		expect(await fs.stat(sessionFile)).toBeTruthy();
		expect(await repository.getChat("owner-1", "gjc-project-admin-project-session-session-one")).toBeUndefined();

		const relinked = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", {
				cwd: projectDirectory,
				name: "Admin Project",
			}),
		);
		expect(relinked.status).toBe(200);
		expect(await modelIds(handler)).toEqual(["gjc"]);
		expect(await repository.getChat("owner-1", "gjc-project-admin-project-session-session-one")).toMatchObject({
			title: "Admin Session",
		});
	});

	test("supports OpenWebUI chat slash commands through the regular gjc model", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Slash Project");
		await fs.mkdir(projectDirectory);
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			ownerUserId: "owner-1",
		});
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const linked = await handler(
			chatCommandRequest({
				model: "gjc",
				messages: [{ role: "user", content: `/gjc project link ${projectDirectory}` }],
			}),
		);
		expect(linked.status).toBe(200);
		const linkedBody = (await linked.json()) as ChatCompletionBody;
		expect(linkedBody.choices[0].message.content).toContain("Linked slash-project");
		expect(await modelIds(handler)).toEqual(["gjc"]);

		const unlinked = await handler(
			chatCommandRequest({
				model: "gjc",
				messages: [{ role: "user", content: "/gjc project unlink slash-project" }],
			}),
		);
		expect(unlinked.status).toBe(200);
		const unlinkedBody = (await unlinked.json()) as ChatCompletionBody;
		expect(unlinkedBody.choices[0].message.content).toContain("Unlinked slash-project");
		expect(await modelIds(handler)).toEqual(["gjc"]);
	});

	test("rejects admin link requests outside allowed roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-outside-"));
		tempDirs.push(workspace, outside);
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			ownerUserId: "owner-1",
		});
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const response = await handler(jsonRequest("http://adapter.test/admin/projects/link", { cwd: outside }));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_project_link" } });
	});

	test("rejects malformed optional link fields with a client error", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-project-admin-"));
		tempDirs.push(workspace);
		const projectDirectory = path.join(workspace, "Bad Link Body");
		await fs.mkdir(projectDirectory);
		const service = new ProjectLinkService({
			allowedRoots: await resolveAllowedRoots([workspace]),
			store: new SqliteProjectRegistrationStore(":memory:"),
			ownerUserId: "owner-1",
		});
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [],
				projectProvider: () => service.listLinkedProjects(),
				projectLinkService: service,
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const response = await handler(
			jsonRequest("http://adapter.test/admin/projects/link", { cwd: projectDirectory, name: 42 }),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_project_link", type: "invalid_request_error" },
		});
	});
});

const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

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

async function modelIds(handler: (request: Request) => Response | Promise<Response>): Promise<string[]> {
	const response = await handler(
		new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer adapter-token" } }),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { data: { id: string }[] };
	return body.data.map((model: { id: string }) => model.id);
}

type ChatCompletionBody = {
	readonly choices: readonly [{ readonly message: { readonly content: string } }];
};
