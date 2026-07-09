import { describe, expect, test } from "bun:test";
import { GJC_OPENWEBUI_PROMPT_HINTS, OpenWebUIPromptHintClient } from "../src/openwebui/prompt-hints";

interface RecordedPromptRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | null;
	readonly body: unknown;
}

interface PromptRecord {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
	readonly is_active: boolean;
}

describe("OpenWebUI prompt hints", () => {
	test("creates missing GJC slash-command prompts for OpenWebUI autocomplete", async () => {
		const fixture = startPromptServer([]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({ created: GJC_OPENWEBUI_PROMPT_HINTS.length, updated: 0, unchanged: 0, skipped: 0 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
			]);
			expect(fixture.prompts.map(prompt => prompt.command)).toEqual([
				"gjc-project-link",
				"gjc-project-list",
				"gjc-project-unlink",
			]);
			expect(fixture.prompts[0]?.content).toBe("/gjc project link {{PROJECT_PATH}}");
		} finally {
			fixture.stop();
		}
	});

	test("updates stale GJC prompt hints and leaves matching hints unchanged", async () => {
		const fixture = startPromptServer([
			{
				id: "prompt-link",
				command: "gjc-project-link",
				name: "Old link prompt",
				content: "/gjc project link /tmp/old",
				tags: ["old"],
				meta: { gjc_adapter: { prompt_hint: true } },
				is_active: true,
			},
			{
				id: "prompt-list",
				command: "gjc-project-list",
				name: "GJC: List linked project folders",
				content: "/gjc project list",
				tags: ["gjc", "project"],
				meta: {
					gjc_adapter: { prompt_hint: true },
					description: "Show the GJC project folders currently linked into OpenWebUI.",
				},
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({ created: 1, updated: 1, unchanged: 1, skipped: 0 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/id/prompt-link/update",
				"/api/v1/prompts/create",
			]);
			expect(fixture.prompts.find(prompt => prompt.command === "gjc-project-link")?.content).toBe(
				"/gjc project link {{PROJECT_PATH}}",
			);
		} finally {
			fixture.stop();
		}
	});

	test("finds existing GJC prompt hints beyond the first OpenWebUI prompt page", async () => {
		const fixture = startPromptServer([
			...Array.from({ length: 30 }, (_, index) => ({
				id: `filler-${index}`,
				command: `filler-${index}`,
				name: `Filler ${index}`,
				content: `filler ${index}`,
				tags: [],
				meta: {},
				is_active: true,
			})),
			{
				id: "prompt-link",
				command: "gjc-project-link",
				name: "GJC: Link project folder",
				content: "/gjc project link {{PROJECT_PATH}}",
				tags: ["gjc", "project"],
				meta: {
					gjc_adapter: { prompt_hint: true },
					description: "Link a local folder into OpenWebUI and import its GJC session history.",
				},
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({ created: 2, updated: 0, unchanged: 1, skipped: 0 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/list?page=2",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
			]);
			expect(fixture.prompts.filter(prompt => prompt.command === "gjc-project-link")).toHaveLength(1);
		} finally {
			fixture.stop();
		}
	});

	test("does not overwrite user-owned prompts that collide with GJC hint commands", async () => {
		const fixture = startPromptServer([
			{
				id: "user-prompt-link",
				command: "gjc-project-link",
				name: "User custom link helper",
				content: "Do not overwrite this user prompt.",
				tags: ["personal"],
				meta: { owner: "user-authored" },
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 1 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
			]);
			expect(fixture.prompts.find(prompt => prompt.id === "user-prompt-link")?.content).toBe(
				"Do not overwrite this user prompt.",
			);
		} finally {
			fixture.stop();
		}
	});
});

function startPromptServer(initialPrompts: readonly PromptRecord[]) {
	const requests: RecordedPromptRequest[] = [];
	const prompts: PromptRecord[] = initialPrompts.map(prompt => ({ ...prompt, tags: [...prompt.tags] }));
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body: unknown = request.method === "GET" ? null : await request.json();
			requests.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				authorization: request.headers.get("authorization"),
				body,
			});
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				const pageNumber = Number(url.searchParams.get("page") ?? "1");
				const pageIndex = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : 0;
				const start = pageIndex * 30;
				return Response.json({ items: prompts.slice(start, start + 30), total: prompts.length });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/create") {
				const prompt = promptFromBody(`prompt-${prompts.length + 1}`, body);
				prompts.push(prompt);
				return Response.json(prompt);
			}
			const updateMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/update$/);
			if (request.method === "POST" && updateMatch !== null) {
				const promptId = updateMatch[1];
				const index = prompts.findIndex(prompt => prompt.id === promptId);
				if (index < 0) return Response.json({ detail: "not found" }, { status: 404 });
				const updated = promptFromBody(promptId, body);
				prompts.splice(index, 1, updated);
				return Response.json(updated);
			}
			const toggleMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/toggle$/);
			if (request.method === "POST" && toggleMatch !== null) {
				const promptId = toggleMatch[1];
				const index = prompts.findIndex(prompt => prompt.id === promptId);
				if (index < 0) return Response.json({ detail: "not found" }, { status: 404 });
				const existing = prompts[index];
				if (existing === undefined) return Response.json({ detail: "not found" }, { status: 404 });
				const updated = { ...existing, is_active: !existing.is_active };
				prompts.splice(index, 1, updated);
				return Response.json(updated);
			}
			return Response.json({ detail: "unexpected request" }, { status: 500 });
		},
	});
	return {
		baseUrl: `http://${server.hostname}:${server.port}`,
		requests,
		prompts,
		stop: () => server.stop(true),
	};
}

function promptFromBody(id: string, body: unknown): PromptRecord {
	if (!isRecord(body)) throw new Error("expected prompt body");
	return {
		id,
		command: stringField(body, "command"),
		name: stringField(body, "name"),
		content: stringField(body, "content"),
		tags: arrayOfStrings(body.tags),
		meta: isRecord(body.meta) ? body.meta : {},
		is_active: true,
	};
}

function stringField(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`expected string field ${key}`);
	return value;
}

function arrayOfStrings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
