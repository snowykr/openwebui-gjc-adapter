import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { GJC_OPENWEBUI_PROMPT_HINTS } from "../src/openwebui/prompt-hints";
import { FakeGjcTurnRunner } from "./cli-fixtures";

describe("adapter CLI prompt hints", () => {
	test("seeds OpenWebUI prompt hints during CLI startup when API auth is configured", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-prompts-"));
		const fixture = startPromptServer();

		try {
			await buildAdapterServerOptionsFromEnv(
				{
					...process.env,
					GJC_OPENWEBUI_BASE_URL: fixture.baseUrl,
					GJC_OPENWEBUI_API_TOKEN: "openwebui-token",
					GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
					GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
					GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
					GJC_OPENWEBUI_SESSION_ROOT: path.join(workspace, "sessions"),
					GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "state"),
				},
				{
					turnRunner: new FakeGjcTurnRunner(),
					projectionRepository: new InMemoryOpenWebUIProjectionRepository(),
				},
			);

			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				...GJC_OPENWEBUI_PROMPT_HINTS.map(() => "/api/v1/prompts/create"),
			]);
			expect(fixture.prompts.map(prompt => prompt.command)).toEqual(
				GJC_OPENWEBUI_PROMPT_HINTS.map(prompt => prompt.command),
			);
		} finally {
			fixture.stop();
		}
	});
});

interface RecordedPromptRequest {
	readonly method: string;
	readonly path: string;
}

interface CreatedPrompt {
	readonly command: string;
}

function startPromptServer() {
	const requests: RecordedPromptRequest[] = [];
	const prompts: CreatedPrompt[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				return Response.json({ items: [], total: 0 });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/create") {
				const body = await request.json();
				if (!isRecord(body) || typeof body.command !== "string") {
					return Response.json({ detail: "bad prompt" }, { status: 400 });
				}
				prompts.push({ command: body.command });
				return Response.json({ id: `prompt-${prompts.length}`, ...body, is_active: true });
			}
			return Response.json({ detail: "unexpected request" }, { status: 500 });
		},
	});
	return { baseUrl: `http://${server.hostname}:${server.port}`, requests, prompts, stop: () => server.stop(true) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
