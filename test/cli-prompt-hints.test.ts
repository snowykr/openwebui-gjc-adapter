import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/cli";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { GJC_OPENWEBUI_PROMPT_HINTS } from "../src/openwebui/prompt-hints";

describe("adapter CLI prompt hints", () => {
	test("seeds OpenWebUI prompt hints during CLI startup when API auth is configured", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-adapter-cli-prompts-"));
		const fixture = startPromptServer();
		const managedRuntime = {
			state: "new",
			start: async () => undefined,
			dispose: async () => undefined,
			reconcile: async () => undefined,
			registerTenant: () => undefined,
			acquireAttachment: async () => undefined,
			generationStatus: async () => ({ status: "current" as const }),
		};

		try {
			await writeV3Authority(path.join(workspace, "sessions"));
			await buildAdapterServerOptionsFromEnv(
				{
					...process.env,
					GJC_OPENWEBUI_MODE: "existing",
					GJC_OPENWEBUI_BASE_URL: fixture.baseUrl,
					GJC_OPENWEBUI_API_TOKEN: "openwebui-token",
					GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
					GJC_OPENWEBUI_OWNER_USER_ID: "owner-test",
					GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: workspace,
					GJC_OPENWEBUI_SESSION_ROOT: path.join(workspace, "sessions"),
					GJC_OPENWEBUI_STATE_PATH: path.join(workspace, "state"),
				},
				{
					managedSdkRuntime: managedRuntime as never,
					projectionRepository: new InMemoryOpenWebUIProjectionRepository(),
				},
			);

			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/list?page=1",
				...GJC_OPENWEBUI_PROMPT_HINTS.map(() => "/api/v1/prompts/create"),
				"/api/v1/prompts/list?page=1",
			]);
			expect(fixture.prompts.map(prompt => prompt.command)).toEqual(
				GJC_OPENWEBUI_PROMPT_HINTS.map(prompt => prompt.command),
			);
		} finally {
			fixture.stop();
		}
	});
});

async function writeV3Authority(root: string): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	const canonicalPath = path.join(root, "openwebui-session-mappings.json");
	const canonical = Buffer.from(
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: [],
			provisionalOperations: [],
		})}\n`,
	);
	await fs.writeFile(canonicalPath, canonical);
	await fs.writeFile(
		`${canonicalPath}.v3-active.json`,
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: createHash("sha256").update(canonical).digest("hex"),
			source: { baseDigest: "0".repeat(64), walDigest: "0".repeat(64), walPresent: false },
		})}\n`,
	);
}

interface RecordedPromptRequest {
	readonly method: string;
	readonly path: string;
}
interface CreatedPrompt {
	readonly id: string;
	readonly command: string;
	readonly body: Record<string, unknown>;
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
				return Response.json({ items: prompts.map(prompt => prompt.body), total: prompts.length });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/create") {
				const body = await request.json();
				if (!isRecord(body) || typeof body.command !== "string") {
					return Response.json({ detail: "bad prompt" }, { status: 400 });
				}
				const id = `prompt-${prompts.length + 1}`;
				const stored = { id, ...body, is_active: true };
				prompts.push({ id, command: body.command, body: stored });
				return Response.json(stored);
			}
			return Response.json({ detail: "unexpected request" }, { status: 500 });
		},
	});
	return { baseUrl: `http://${server.hostname}:${server.port}`, requests, prompts, stop: () => server.stop(true) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
