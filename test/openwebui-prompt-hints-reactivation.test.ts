import { describe, expect, test } from "bun:test";
import { OpenWebUIPromptHintClient } from "../src/openwebui/prompt-hints";

describe("OpenWebUI prompt hint reactivation", () => {
	test("reactivates disabled adapter-owned prompt hints", async () => {
		const fixture = startPromptServer();
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({ created: 2, updated: 1, unchanged: 0, skipped: 0 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/id/prompt-link/update",
				"/api/v1/prompts/id/prompt-link/toggle",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
			]);
			expect(fixture.prompt.is_active).toBe(true);
		} finally {
			fixture.stop();
		}
	});
});

interface RecordedPromptRequest {
	readonly method: string;
	readonly path: string;
}

function startPromptServer() {
	const requests: RecordedPromptRequest[] = [];
	const prompt = {
		id: "prompt-link",
		command: "gjc-project-link",
		name: "GJC: Link project folder",
		content: "/gjc project link {{PROJECT_PATH}}",
		tags: ["gjc", "project"],
		meta: {
			gjc_adapter: { prompt_hint: true },
			description: "Link a local folder into OpenWebUI and import its GJC session history.",
		},
		is_active: false,
	};
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				return Response.json({ items: [prompt], total: 1 });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/id/prompt-link/update") {
				return Response.json(prompt);
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/id/prompt-link/toggle") {
				prompt.is_active = true;
				return Response.json(prompt);
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/create") {
				const body: unknown = await request.json();
				return Response.json({ id: "created", ...(isRecord(body) ? body : {}), is_active: true });
			}
			return Response.json({ detail: "unexpected request" }, { status: 500 });
		},
	});
	return { baseUrl: `http://${server.hostname}:${server.port}`, requests, prompt, stop: () => server.stop(true) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
