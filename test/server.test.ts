import { describe, expect, test } from "bun:test";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";
import { createAdapterRequestHandler } from "../src/server";

describe("createAdapterRequestHandler", () => {
	test("returns health status", async () => {
		const handler = createAdapterRequestHandler([{ name: "config", status: "ok" }]);
		const response = await handler(new Request("http://adapter.test/healthz"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "openwebui-gjc-adapter",
			checks: [{ name: "config", status: "ok" }],
		});
	});

	test("returns 404 for unknown routes", async () => {
		const handler = createAdapterRequestHandler();
		const response = await handler(new Request("http://adapter.test/unknown"));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});

	test("returns model list from optional route dependencies", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("unused") },
		});

		const response = await handler(new Request("http://adapter.test/v1/models"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [{ id: "gjc/demo", object: "model", created: 1783468800, owned_by: "gjc" }],
		});
	});

	test("requires configured adapter bearer tokens for OpenAI-compatible routes", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const unauthorized = await handler(new Request("http://adapter.test/v1/models"));
		const authorized = await handler(
			new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer adapter-token" } }),
		);

		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(authorized.status).toBe(200);
	});

	test("fails closed when CLI service requires but lacks an adapter API token", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("unused"), requireAdapterApiToken: true },
		});

		const response = await handler(new Request("http://adapter.test/v1/models"));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "adapter_api_token_unconfigured" } });
	});

	test("routes chat completions to optional route dependencies", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("handled") },
		});

		const response = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-OpenWebUI-Chat-Id": "chat-1",
					"X-OpenWebUI-Message-Id": "assistant-1",
					"X-OpenWebUI-User-Message-Id": "user-1",
					"X-OpenWebUI-User-Message-Parent-Id": "",
					"X-OpenWebUI-User-Id": "owner-1",
				},
				body: JSON.stringify({ model: "gjc/demo", messages: [{ role: "user", content: "hello" }] }),
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("application/json");
		expect(await response.json()).toMatchObject({
			object: "chat.completion",
			choices: [{ message: { role: "assistant", content: "handled" } }],
		});
	});

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

		const response = await handler(chatRequest({ model: "gjc/demo" }));

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

		const response = await handler(
			chatRequest({ model: "gjc/demo", messages: [{ role: "user", content: "hello" }] }),
		);

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

		const invalidRole = await handler(
			chatRequest({ model: "gjc/demo", messages: [{ role: "bad", content: "hello" }] }),
		);
		const invalidContent = await handler(
			chatRequest({ model: "gjc/demo", messages: [{ role: "user", content: [{ type: "image", text: "nope" }] }] }),
		);
		const invalidModel = await handler(chatRequest({ model: 123, messages: [{ role: "user", content: "hello" }] }));
		const invalidStream = await handler(
			chatRequest({ model: "gjc/demo", stream: "yes", messages: [{ role: "user", content: "hello" }] }),
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
