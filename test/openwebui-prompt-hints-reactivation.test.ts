import { describe, expect, test } from "bun:test";
import { GJC_OPENWEBUI_PROMPT_HINTS, OpenWebUIPromptHintClient } from "../src/openwebui/prompt-hints";

describe("OpenWebUI prompt hint reactivation", () => {
	test("reactivates disabled adapter-owned prompt hints", async () => {
		const fixture = startPromptServer();
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({
				created: GJC_OPENWEBUI_PROMPT_HINTS.length - 1,
				updated: 1,
				unchanged: 0,
				skipped: 0,
				verified: true,
			});
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/id/prompt-link/update",
				"/api/v1/prompts/id/prompt-link/toggle",
				...Array.from({ length: GJC_OPENWEBUI_PROMPT_HINTS.length - 1 }, () => "/api/v1/prompts/create"),
				"/api/v1/prompts/list?page=1",
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
type PromptRecord = {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
	is_active: boolean;
};

function startPromptServer() {
	const requests: RecordedPromptRequest[] = [];
	const prompt = {
		id: "prompt-link",
		command: "gjc-skill-deep-interview",
		name: "GJC: Deep interview",
		content: "/skill:deep-interview {{REQUEST}}",
		tags: ["gjc", "workflow"],
		meta: {
			gjc_adapter: { prompt_hint: true },
			description: "Start the GJC deep-interview workflow for clarifying requirements.",
		},
		is_active: false,
	};
	const prompts: PromptRecord[] = [prompt];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				return Response.json({ items: prompts, total: prompts.length });
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
				if (!isRecord(body)) return Response.json({ detail: "invalid body" }, { status: 400 });
				const created = {
					id: `created-${prompts.length}`,
					command: String(body.command),
					name: String(body.name),
					content: String(body.content),
					tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
					meta: isRecord(body.meta) ? body.meta : {},
					is_active: true,
				};
				prompts.push(created);
				return Response.json(created);
			}
			return Response.json({ detail: "unexpected request" }, { status: 500 });
		},
	});
	return { baseUrl: `http://${server.hostname}:${server.port}`, requests, prompt, stop: () => server.stop(true) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
