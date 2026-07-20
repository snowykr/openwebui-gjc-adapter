import { describe, expect, it } from "bun:test";
import { handleChatCompletions, type LiveGatewayRunner, WorkflowGateReplyError } from "../src/live/chat-completions";
import { buildModelList } from "../src/live/models";
import type { OpenAIChatCompletionRequest } from "../src/live/openai-types";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import type { RegisteredProject } from "../src/projects/registry";

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	allowedRoot: "/work",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const owner: OpenWebUIOwnerContext = {
	ownerUserId: "owner-1",
	singleOwnerLocalMode: false,
};

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

const projectWithFolder: RegisteredProject = { ...project, openWebUIFolderId: "folder-demo" };

describe("live OpenAI-compatible chat completions", () => {
	it("advertises only the stable gjc model", () => {
		expect(buildModelList()).toEqual({
			object: "list",
			data: [],
		});
	});
	it("passes one OpenWebUI connection-prefixed canonical model to the runner without its prefix", async () => {
		let requestedModelId: string | undefined;
		const result = await handleChatCompletions({
			request: {
				...request,
				model: "gjc-adapter.gjc/anthropic/claude-sonnet-4:low",
			},
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			projectContextRepository: await demoRepository(),
			runner: {
				run(input) {
					requestedModelId = input.requestedModelId;
					return { content: "done", model: "gjc/anthropic/claude-sonnet-4:low" };
				},
			},
		});

		expect(result.ok).toBe(true);
		expect(requestedModelId).toBe("gjc/anthropic/claude-sonnet-4:low");
	});
	it("returns an OpenAI-style 400 for invalid workflow gate replies", async () => {
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			projectContextRepository: await demoRepository(),
			runner: {
				run() {
					throw new WorkflowGateReplyError("Invalid workflow gate reply.", "invalid_workflow_gate_choice", [
						"9 is not a valid workflow gate choice. Choose a number from 1 to 3.",
					]);
				},
			},
		});

		expect(result).toEqual({
			ok: false,
			status: 400,
			body: {
				error: {
					message: "Invalid workflow gate reply.",
					type: "invalid_request_error",
					code: "invalid_workflow_gate_choice",
				},
			},
		});
	});

	it("delivers projected runner events through the injected event sink", async () => {
		const delivered: unknown[] = [];
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			projectContextRepository: await demoRepository(),
			runner: {
				run() {
					return {
						content: "done",
						model: "gjc/anthropic/claude-sonnet-4:low",
						events: [{ type: "status", data: { description: "Tool ran", done: true } }],
					};
				},
			},
			eventSink(input) {
				delivered.push(input);
			},
		});

		expect(result.ok).toBe(true);
		expect(delivered).toEqual([
			{
				chatId: "chat-1",
				messageId: "assistant-1",
				ownerUserId: "owner-1",
				projectId: "demo",
				events: [{ type: "status", data: { description: "Tool ran", done: true } }],
			},
		]);
	});

	it("persists final assistant content to the injected message sink", async () => {
		const persisted: unknown[] = [];
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [projectWithFolder],
			owner,
			projectContextRepository: await demoRepository(),
			runner: fixedRunner("GJC_UI_REAL_BACKEND_OK"),
			messageSink(input: unknown) {
				persisted.push(input);
			},
		});

		expect(result.ok).toBe(true);
		expect(persisted).toEqual([
			{
				chatId: "chat-1",
				messageId: "assistant-1",
				ownerUserId: "owner-1",
				projectId: "demo",
				content: "GJC_UI_REAL_BACKEND_OK",
			},
		]);
	});
});

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content, model: "gjc/anthropic/claude-sonnet-4:low" }) };
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
