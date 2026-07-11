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
			data: [{ id: "gjc", object: "model", created: 1783468800, owned_by: "gjc" }],
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
	test("protects runtime readiness separately from the provider bearer token", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("unused") },
			runtime: {
				adapterToken: "provider-token",
				readinessToken: "readiness-token",
				readiness: { openWebUIAuthenticated: true, promptHintsSeeded: true, mode: "managed" },
			},
		});

		const unauthorized = await handler(new Request("http://adapter.test/readyz"));
		const ready = await handler(
			new Request("http://adapter.test/readyz", { headers: { authorization: "Bearer readiness-token" } }),
		);
		const providerOnReadiness = await handler(
			new Request("http://adapter.test/readyz", { headers: { authorization: "Bearer provider-token" } }),
		);
		const provider = await handler(
			new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer provider-token" } }),
		);

		expect(unauthorized.status).toBe(401);
		expect(ready.status).toBe(200);
		expect(providerOnReadiness.status).toBe(401);
		expect(await ready.json()).toMatchObject({ status: "ready", identity: { mode: "managed" } });
		expect(provider.status).toBe(200);
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
				body: JSON.stringify({ model: "gjc", messages: [{ role: "user", content: "hello" }] }),
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("application/json");
		expect(await response.json()).toMatchObject({
			object: "chat.completion",
			choices: [{ message: { role: "assistant", content: "handled" } }],
		});
	});
	test("keeps malformed JSON errors and streaming responses on the current chat route", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: { run: () => ({ chunks: ["a", "b"] }) } },
		});
		const malformed = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		);
		const streaming = await handler(
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
				body: JSON.stringify({ model: "gjc", stream: true, messages: [{ role: "user", content: "hello" }] }),
			}),
		);

		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: { code: "invalid_json" } });
		expect(streaming.headers.get("content-type")).toStartWith("text/event-stream");
		expect(await streaming.text()).toContain("data: [DONE]");
	});
});

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	allowedRoot: "/work",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content }) };
}
