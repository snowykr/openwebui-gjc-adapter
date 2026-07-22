import { describe, expect, test } from "bun:test";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import { OpenWebUIHttpClient } from "../src/openwebui/http-client";
import type { RegisteredProject } from "../src/projects/registry";
import { createAdapterRequestHandler } from "../src/server";

describe("createAdapterRequestHandler streaming", () => {
	test("returns event-stream chat completions for streaming requests", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: { run: () => ({ chunks: ["a", "b"], model: "gjc/anthropic/claude-sonnet-4:low" }) },
			},
		});

		const response = await handler(
			chatRequest({ model: "gjc", stream: true, messages: [{ role: "user", content: "hello" }] }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("text/event-stream");
		expect(sseFrames(await response.text())).toEqual([
			{
				id: expect.any(String),
				object: "chat.completion.chunk",
				created: expect.any(Number),
				model: "gjc/anthropic/claude-sonnet-4:low",
				choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
			},
			{
				id: expect.any(String),
				object: "chat.completion.chunk",
				created: expect.any(Number),
				model: "gjc/anthropic/claude-sonnet-4:low",
				choices: [{ index: 0, delta: { content: "a" }, finish_reason: null }],
			},
			{
				id: expect.any(String),
				object: "chat.completion.chunk",
				created: expect.any(Number),
				model: "gjc/anthropic/claude-sonnet-4:low",
				choices: [{ index: 0, delta: { content: "b" }, finish_reason: null }],
			},
			{
				id: expect.any(String),
				object: "chat.completion.chunk",
				created: expect.any(Number),
				model: "gjc/anthropic/claude-sonnet-4:low",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);
	});
});
describe("OpenWebUI message event responses", () => {
	test("rejects false and malformed successful responses", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const messageId = new URL(request.url).pathname.split("/").at(-2);
				if (messageId === "false") return Response.json(false);
				return new Response("not JSON", { status: 200, headers: { "content-type": "application/json" } });
			},
		});
		const client = new OpenWebUIHttpClient({
			baseUrl: `http://${server.hostname}:${server.port}`,
			apiToken: "token-1",
		});

		try {
			for (const messageId of ["false", "malformed"]) {
				await expect(
					client.postMessageEvent({
						chatId: "chat-1",
						messageId,
						event: { type: "status", data: { description: "Running", done: false } },
					}),
				).rejects.toMatchObject({
					name: "OpenWebUIMessageEventResponseError",
					method: "POST",
					path: `/api/v1/chats/chat-1/messages/${messageId}/event`,
				});
			}
		} finally {
			server.stop(true);
		}
	});
});

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

function chatRequest(body: unknown): Request {
	return new Request("http://adapter.test/v1/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-OpenWebUI-Chat-Id": "chat-1",
			"X-OpenWebUI-Message-Id": "assistant-1",
			"X-OpenWebUI-User-Message-Id": "user-1",
			"X-OpenWebUI-User-Message-Parent-Id": "",
			"X-OpenWebUI-User-Id": "owner-1",
		},
		body: JSON.stringify(body),
	});
}
function sseFrames(body: string): unknown[] {
	return body
		.split("\n\n")
		.filter(frame => frame.length > 0)
		.map(frame => {
			const data = frame.slice("data: ".length);
			return data === "[DONE]" ? data : JSON.parse(data);
		});
}
