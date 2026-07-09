import { describe, expect, test } from "bun:test";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";
import { createAdapterRequestHandler } from "../src/server";

describe("createAdapterRequestHandler chat completion errors", () => {
	test("returns OpenAI-style JSON error for malformed chat completion bodies", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("unused") },
		});

		const response = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				message: "Request body must be valid JSON.",
				type: "invalid_request_error",
				code: "invalid_json",
			},
		});
	});

	test("returns OpenAI-style JSON error for valid JSON chat completion bodies missing messages", async () => {
		let calls = 0;
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: {
					run() {
						calls += 1;
						return { content: "unexpected" };
					},
				},
			},
		});

		const response = await handler(chatRequest({ model: "gjc" }));

		expect(calls).toBe(0);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: {
				message: "Request body must include a messages array.",
				type: "invalid_request_error",
				code: "invalid_request_body",
			},
		});
	});

	test("returns OpenAI-style JSON errors when the live runner throws", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: {
					run() {
						throw new Error("GJC RPC start failed: configured CLI is unavailable");
					},
				},
			},
		});

		const response = await handler(chatRequest({ model: "gjc", messages: [{ role: "user", content: "hello" }] }));

		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toStartWith("application/json");
		expect(await response.json()).toEqual({
			error: {
				message: "GJC RPC start failed: configured CLI is unavailable",
				type: "server_error",
				code: "live_runner_error",
			},
		});
	});

	test("returns generic attachment errors without leaking upstream bodies or local paths", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: fixedRunner("unused"),
				fileContextResolver() {
					throw new Error("OpenWebUI HTTP GET /api/v1/files/file-1/content failed: /secret/path token=abc");
				},
			},
		});

		const response = await handler(
			chatRequest({
				model: "gjc",
				messages: [{ role: "user", content: "hello" }],
				files: [{ id: "file-1", name: "secret.pdf", type: "application/pdf", documents: [] }],
			}),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				message: "OpenWebUI attachment files could not be resolved.",
				type: "server_error",
				code: "attachment_resolution_failed",
			},
		});
	});

	test("rejects invalid chat completion message fields before invoking the runner", async () => {
		let calls = 0;
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: {
					run() {
						calls += 1;
						return { content: "unexpected" };
					},
				},
			},
		});

		const invalidRole = await handler(chatRequest({ model: "gjc", messages: [{ role: "bad", content: "hello" }] }));
		const invalidContent = await handler(
			chatRequest({ model: "gjc", messages: [{ role: "user", content: [{ type: "image", text: "nope" }] }] }),
		);
		const invalidModel = await handler(chatRequest({ model: 123, messages: [{ role: "user", content: "hello" }] }));
		const invalidStream = await handler(
			chatRequest({ model: "gjc", stream: "yes", messages: [{ role: "user", content: "hello" }] }),
		);

		expect(calls).toBe(0);
		expect(invalidRole.status).toBe(400);
		expect(await invalidRole.json()).toMatchObject({ error: { code: "invalid_request_body" } });
		expect(invalidContent.status).toBe(400);
		expect(await invalidContent.json()).toMatchObject({ error: { code: "invalid_request_body" } });
		expect(invalidModel.status).toBe(400);
		expect(await invalidModel.json()).toMatchObject({ error: { code: "invalid_request_body" } });
		expect(invalidStream.status).toBe(400);
		expect(await invalidStream.json()).toMatchObject({
			error: { code: "invalid_request_body", message: "Request stream must be a boolean when provided." },
		});
	});
});

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	modelId: "gjc/demo",
	allowedRoot: "/work",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content }) };
}

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
