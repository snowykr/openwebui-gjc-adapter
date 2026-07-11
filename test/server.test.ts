import { describe, expect, test } from "bun:test";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";
import { createAdapterRequestHandler, initializeRuntimeReadiness } from "../src/server";

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
			data: [{ id: "gjc", object: "model", created: 0, owned_by: "gjc" }],
		});
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

	test("returns event-stream chat completions for streaming requests", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: { run: () => ({ chunks: ["a", "b"] }) } },
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
				body: JSON.stringify({ model: "gjc", stream: true, messages: [{ role: "user", content: "hello" }] }),
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("text/event-stream");
		expect(await response.text()).toContain("data: [DONE]");
	});
	test("gates provider traffic until startup authentication and prompt hints recover", async () => {
		const originalFetch = globalThis.fetch;
		let authAttempts = 0;
		globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
			if (String(input).endsWith("/auths/") && ++authAttempts === 1) return new Response("denied", { status: 401 });
			if (String(input).endsWith("/auths/")) return Response.json({ id: "owner" });
			if (String(input).endsWith("/api/config")) return Response.json({ default_prompt_suggestions: [] });
			if (init?.method === "POST")
				return Response.json([{ title: ["GJC"], content: "Use the GJC coding agent to work on this project." }]);
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		try {
			const handler = createAdapterRequestHandler({
				routes: { projects: [project], owner, runner: fixedRunner("handled") },
				runtime: {
					adapterToken: "adapter",
					readinessToken: "ready",
					openWebUIBaseUrl: "http://openwebui.test",
					openWebUIApiToken: "api",
				},
			});
			const response = await handler(
				new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer adapter" } }),
			);
			expect(response.status).toBe(200);
			expect(authAttempts).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test("retries transient authentication failure and recovers readiness", async () => {
		const originalFetch = globalThis.fetch;
		let authAttempts = 0;
		globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
			if (String(input).endsWith("/auths/") && ++authAttempts === 1) return new Response("denied", { status: 401 });
			if (String(input).endsWith("/auths/")) return Response.json({ id: "owner" });
			if (String(input).endsWith("/api/config")) return Response.json({ default_prompt_suggestions: [] });
			if (init?.method === "POST")
				return Response.json([{ title: ["GJC"], content: "Use the GJC coding agent to work on this project." }]);
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		try {
			const state = await initializeRuntimeReadiness({
				adapterToken: "adapter",
				readinessToken: "ready",
				openWebUIBaseUrl: "http://openwebui.test",
				openWebUIApiToken: "api",
			});
			expect(state.openWebUIAuthenticated).toBe(true);
			expect(state.promptHintsSeeded).toBe(true);
			expect(authAttempts).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test("recovers after the bounded startup reconciliation attempts are exhausted", async () => {
		const originalFetch = globalThis.fetch;
		let authAttempts = 0;
		globalThis.fetch = (async (input: string | Request | URL, init?: RequestInit) => {
			if (String(input).endsWith("/auths/") && ++authAttempts <= 3) return new Response("denied", { status: 503 });
			if (String(input).endsWith("/auths/")) return Response.json({ id: "owner" });
			if (String(input).endsWith("/api/config")) return Response.json({ default_prompt_suggestions: [] });
			if (init?.method === "POST")
				return Response.json([{ title: ["GJC"], content: "Use the GJC coding agent to work on this project." }]);
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		try {
			const handler = createAdapterRequestHandler({
				routes: { projects: [project], owner, runner: fixedRunner("handled") },
				runtime: {
					adapterToken: "adapter",
					readinessToken: "ready",
					openWebUIBaseUrl: "http://openwebui.test",
					openWebUIApiToken: "api",
				},
			});
			const initial = await handler(
				new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer adapter" } }),
			);
			expect(initial.status).toBe(503);
			expect(authAttempts).toBe(3);

			await new Promise(resolve => setTimeout(resolve, 120));
			const recovered = await handler(
				new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer adapter" } }),
			);
			expect(recovered.status).toBe(200);
			expect(authAttempts).toBe(4);
		} finally {
			globalThis.fetch = originalFetch;
		}
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

const owner: OpenWebUIOwnerContext = {
	ownerUserId: "owner-1",
	singleOwnerLocalMode: false,
};

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content }) };
}
