import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	handleChatCompletions,
	type LiveGatewayRunner,
	type LiveGatewayRunnerInput,
} from "../src/live/chat-completions";
import { buildModelList } from "../src/live/models";
import type { OpenAIChatCompletionRequest } from "../src/live/openai-types";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import type { RegisteredProject } from "../src/projects/registry";

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	modelId: "gjc/demo",
	allowedRoot: "/work",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const projectWithFolder: RegisteredProject = { ...project, openWebUIFolderId: "folder-demo" };
const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

const chatHeaders = {
	"X-OpenWebUI-Chat-Id": "chat-1",
	"X-OpenWebUI-Message-Id": "assistant-1",
	"X-OpenWebUI-User-Message-Id": "user-1",
	"X-OpenWebUI-User-Message-Parent-Id": "parent-1",
	"X-OpenWebUI-User-Id": "owner-1",
};

const request: OpenAIChatCompletionRequest = {
	model: "gjc",
	messages: [{ role: "user", content: "Build it" }],
};

describe("live chat project context", () => {
	it("builds a stable /v1/models list without linked project ids", () => {
		expect(buildModelList([project])).toEqual({
			object: "list",
			data: [{ id: "gjc", object: "model", created: 1783468800, owned_by: "gjc" }],
		});
	});

	it("returns metadata-only responses for OpenWebUI background tasks without calling the runner", async () => {
		let calls = 0;
		const runner: LiveGatewayRunner = {
			run() {
				calls += 1;
				return { content: "unexpected" };
			},
		};

		const result = await handleChatCompletions({
			request,
			headers: { "X-OpenWebUI-Task": "title_generation", "X-OpenWebUI-User-Id": "owner-1" },
			projects: [project],
			owner,
			runner,
			now: new Date("2026-07-08T00:00:00.000Z"),
			idFactory: () => "chatcmpl-test",
		});

		expect(calls).toBe(0);
		expect(result.ok).toBe(true);
		if (!result.ok || !("body" in result)) throw new Error("expected completion body");
		expect(result.body.choices[0]?.message.content).toBe("");
		expect(result.body.metadata).toEqual({ task: "title_generation", noop: true });
	});

	it("rejects project model ids for OpenWebUI background tasks", async () => {
		let calls = 0;
		const result = await handleChatCompletions({
			request: { ...request, model: "gjc/demo" },
			headers: { "X-OpenWebUI-Task": "title_generation", "X-OpenWebUI-User-Id": "owner-1" },
			projects: [project],
			owner,
			runner: {
				run() {
					calls += 1;
					return { content: "unexpected" };
				},
			},
		});

		expect(calls).toBe(0);
		expect(result).toMatchObject({ ok: false, status: 404, body: { error: { code: "model_not_found" } } });
	});

	it("rejects forwarded user mismatches", async () => {
		const result = await handleChatCompletions({
			request,
			headers: { ...chatHeaders, "X-OpenWebUI-User-Id": "other-user" },
			projects: [project],
			owner,
			runner: fixedRunner("unused"),
		});

		expect(result).toMatchObject({ ok: false, status: 401, body: { error: { code: "owner-mismatch" } } });
	});

	it("routes normal completions using folder project context", async () => {
		const inputs: LiveGatewayRunnerInput[] = [];
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			runner: {
				run(input) {
					inputs.push(input);
					return { content: `done: ${input.prompt}` };
				},
			},
			projectContextRepository: await demoRepository(),
			now: new Date("2026-07-08T00:00:00.000Z"),
			idFactory: () => "chatcmpl-test",
		});

		expect(inputs[0]?.project).toEqual(projectWithFolder);
		expect(result).toMatchObject({
			ok: true,
			status: 200,
			body: { model: "gjc", choices: [{ message: { content: "done: Build it" } }] },
		});
	});

	it("routes folderless gjc chats to a durable neutral workspace", async () => {
		const inputs: LiveGatewayRunnerInput[] = [];
		const neutralWorkspace = await mkdtemp(path.join(os.tmpdir(), "gjc-openwebui-neutral-"));
		try {
			const result = await handleChatCompletions({
				request,
				headers: { ...chatHeaders, "X-OpenWebUI-Chat-Id": "chat-neutral" },
				projects: [project],
				owner,
				runner: {
					run(input) {
						inputs.push(input);
						return { content: `cwd: ${input.project.cwd}` };
					},
				},
				neutralWorkspace,
			});

			expect(result.ok).toBe(true);
			expect(inputs[0]?.project).toMatchObject({ id: "openwebui", cwd: neutralWorkspace });
		} finally {
			await rm(neutralWorkspace, { force: true, recursive: true });
		}
	});

	it("rejects project model ids instead of treating project names as models", async () => {
		let calls = 0;
		const result = await handleChatCompletions({
			request: { ...request, model: "gjc/demo" },
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			projectContextRepository: await demoRepository(),
			runner: {
				run() {
					calls += 1;
					return { content: "unexpected" };
				},
			},
		});

		expect(calls).toBe(0);
		expect(result).toMatchObject({ ok: false, status: 404, body: { error: { code: "model_not_found" } } });
	});

	it("rejects request objects missing messages before reading latest user text", async () => {
		let calls = 0;
		const result = await handleChatCompletions({
			request: { model: "gjc" } as OpenAIChatCompletionRequest,
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			projectContextRepository: await demoRepository(),
			runner: {
				run() {
					calls += 1;
					return { content: "unexpected" };
				},
			},
		});

		expect(calls).toBe(0);
		expect(result).toMatchObject({ ok: false, status: 400, body: { error: { code: "invalid_request_body" } } });
	});
});

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content }) };
}

async function demoRepository(): Promise<InMemoryOpenWebUIProjectionRepository> {
	const repository = new InMemoryOpenWebUIProjectionRepository();
	await repository.upsertChat({
		id: "chat-1",
		owner_user_id: "owner-1",
		folder_id: "folder-demo",
		title: "Demo chat",
		metadata: {},
		history: { currentId: null, messages: {} },
	});
	return repository;
}
