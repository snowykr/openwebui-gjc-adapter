import { describe, expect, test } from "bun:test";
import {
	GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS,
	GJC_OPENWEBUI_PROMPT_HINTS,
	OpenWebUIPromptHintClient,
	OpenWebUIPromptHintMigrationError,
} from "../src/openwebui/prompt-hints";
import { startPromptServer } from "./openwebui-prompt-hints-fixtures";

describe("OpenWebUI prompt hints", () => {
	test("creates missing GJC slash-command prompts and reports a verified seed", async () => {
		const fixture = startPromptServer([]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({
				created: GJC_OPENWEBUI_PROMPT_HINTS.length,
				updated: 0,
				unchanged: 0,
				skipped: 0,
				verified: true,
			});
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/list?page=1",
			]);
			expect(fixture.prompts.map(prompt => prompt.command)).toEqual([
				"gjc-skill-deep-interview",
				"gjc-skill-ralplan",
				"gjc-skill-ultragoal",
				"gjc-skill-team",
			]);
			expect(fixture.prompts[0]?.content).toBe("/skill:deep-interview {{REQUEST}}");
			expect(fixture.prompts.find(prompt => prompt.command === "gjc-skill-ralplan")?.content).toBe(
				"/skill:ralplan {{TASK}}",
			);
		} finally {
			fixture.stop();
		}
	});

	test("updates stale GJC prompt hints and leaves matching hints unchanged", async () => {
		const fixture = startPromptServer([
			{
				id: "prompt-interview",
				command: "gjc-skill-deep-interview",
				name: "Old interview prompt",
				content: "/skill:deep-interview old",
				tags: ["old"],
				meta: { gjc_adapter: { prompt_hint: true } },
				is_active: true,
			},
			{
				id: "prompt-ralplan",
				command: "gjc-skill-ralplan",
				name: "GJC: RAL plan",
				content: "/skill:ralplan {{TASK}}",
				tags: ["gjc", "workflow"],
				meta: {
					gjc_adapter: { prompt_hint: true },
					description: "Start the GJC ralplan workflow for acceptance-driven planning.",
				},
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({
				created: 2,
				updated: 1,
				unchanged: 1,
				skipped: 0,
				verified: true,
			});
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/id/prompt-interview/update",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/list?page=1",
			]);
			expect(fixture.prompts.find(prompt => prompt.command === "gjc-skill-deep-interview")?.content).toBe(
				"/skill:deep-interview {{REQUEST}}",
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
				id: "prompt-interview",
				command: "gjc-skill-deep-interview",
				name: "GJC: Deep interview",
				content: "/skill:deep-interview {{REQUEST}}",
				tags: ["gjc", "workflow"],
				meta: {
					gjc_adapter: { prompt_hint: true },
					description: "Start the GJC deep-interview workflow for clarifying requirements.",
				},
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({
				created: 3,
				updated: 0,
				unchanged: 1,
				skipped: 0,
				verified: true,
			});
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/list?page=2",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/list?page=2",
			]);
			expect(fixture.prompts.filter(prompt => prompt.command === "gjc-skill-deep-interview")).toHaveLength(1);
		} finally {
			fixture.stop();
		}
	});

	test("does not overwrite user-owned prompts that collide with GJC hint commands", async () => {
		const fixture = startPromptServer([
			{
				id: "user-prompt-interview",
				command: "gjc-skill-deep-interview",
				name: "User custom interview helper",
				content: "Do not overwrite this user prompt.",
				tags: ["personal"],
				meta: { owner: "user-authored" },
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.seedGjcPromptHints();

			expect(result).toEqual({
				created: 3,
				updated: 0,
				unchanged: 0,
				skipped: 1,
				verified: true,
			});
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/list?page=1",
			]);
			expect(fixture.prompts.find(prompt => prompt.id === "user-prompt-interview")?.content).toBe(
				"Do not overwrite this user prompt.",
			);
		} finally {
			fixture.stop();
		}
	});
	test("fails with a typed degraded error when create is acknowledged but the row is missing on readback", async () => {
		const missingHint = GJC_OPENWEBUI_PROMPT_HINTS[0];
		if (missingHint === undefined) throw new Error("canonical prompt hint is missing");
		const fixture = startPromptVerificationServer({ missingCommand: missingHint.command, noOpCreate: true });
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			let failure: unknown;
			try {
				await client.seedGjcPromptHints();
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(OpenWebUIPromptHintMigrationError);
			expect(failure).toMatchObject({
				reason: "readback-mismatch",
				mismatchCount: 1,
				readbackVerified: false,
			});
			expect(fixture.requests.at(-1)?.path).toBe("/api/v1/prompts/list?page=1");
		} finally {
			fixture.stop();
		}
	});

	test("fails with a typed degraded error when an updated prompt remains inactive", async () => {
		const targetHint = GJC_OPENWEBUI_PROMPT_HINTS[0];
		if (targetHint === undefined) throw new Error("canonical prompt hint is missing");
		const fixture = startPromptVerificationServer({
			inactiveUpdateCommand: targetHint.command,
		});
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			let failure: unknown;
			try {
				await client.seedGjcPromptHints();
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(OpenWebUIPromptHintMigrationError);
			expect(failure).toMatchObject({
				reason: "readback-mismatch",
				mismatchCount: 1,
				readbackVerified: false,
			});
		} finally {
			fixture.stop();
		}
	});

	test("fails with a typed degraded error when stale content or metadata survives update", async () => {
		const targetHint = GJC_OPENWEBUI_PROMPT_HINTS[0];
		if (targetHint === undefined) throw new Error("canonical prompt hint is missing");
		const fixture = startPromptVerificationServer({
			staleUpdateCommand: targetHint.command,
		});
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			let failure: unknown;
			try {
				await client.seedGjcPromptHints();
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(OpenWebUIPromptHintMigrationError);
			expect(failure).toMatchObject({
				reason: "readback-mismatch",
				mismatchCount: 1,
				readbackVerified: false,
			});
		} finally {
			fixture.stop();
		}
	});
	test("revokes only canonical marker-owned project hints and quarantines ambiguity", async () => {
		const linkHint = GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS.find(hint => hint.command === "gjc-project-link");
		if (linkHint === undefined) throw new Error("canonical project-link hint is missing");
		const fixture = startPromptRevocationServer([
			{ id: "legacy", ...linkHint, is_active: true },
			{
				id: "current",
				...linkHint,
				meta: { ...linkHint.meta, gjc_adapter: { prompt_hint: true, installation_id: "install-current" } },
				is_active: true,
			},
			{ id: "foreign-unmarked", ...linkHint, meta: { owner: "foreign" }, is_active: true },
			{
				id: "foreign-install",
				...linkHint,
				meta: { ...linkHint.meta, gjc_adapter: { prompt_hint: true, installation_id: "other-install" } },
				is_active: true,
			},
			{
				id: "generic-marker",
				command: "gjc-custom",
				name: "GJC custom",
				content: "/gjc custom",
				tags: ["gjc"],
				meta: { gjc_adapter: { prompt_hint: true } },
				is_active: true,
			},
			{
				id: "ambiguous",
				command: "gjc-project-link",
				name: "User-adjusted project link",
				content: "/gjc project link /custom/path",
				tags: ["personal"],
				meta: { gjc_adapter: { prompt_hint: true } },
				is_active: true,
			},
		]);
		const client = new OpenWebUIPromptHintClient({
			baseUrl: fixture.baseUrl,
			apiToken: "token-1",
			installationId: "install-current",
		});

		try {
			const result = await client.revokeGjcProjectAdminPromptHints();

			expect(result).toEqual({
				status: "degraded",
				degraded: true,
				listed: 6,
				currentOwned: 1,
				legacyOwned: 1,
				revoked: 2,
				retained: 3,
				retainedForeign: 2,
				retainedGeneric: 1,
				ambiguous: 1,
				quarantined: 1,
				failed: 0,
				readbackVerified: true,
			});
			expect(fixture.requests.map(request => `${request.method} ${request.path}`)).toEqual([
				"GET /api/v1/prompts/list?page=1",
				"DELETE /api/v1/prompts/id/legacy/delete",
				"DELETE /api/v1/prompts/id/current/delete",
				"POST /api/v1/prompts/id/ambiguous/toggle",
				"GET /api/v1/prompts/list?page=1",
			]);
			expect(fixture.prompts.map(prompt => prompt.id)).toEqual([
				"foreign-unmarked",
				"foreign-install",
				"generic-marker",
				"ambiguous",
			]);
			expect(fixture.prompts.find(prompt => prompt.id === "ambiguous")?.is_active).toBe(false);
		} finally {
			fixture.stop();
		}
	});

	test("rerunning revocation is idempotent and still reports unresolved quarantine", async () => {
		const linkHint = GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS.find(hint => hint.command === "gjc-project-link");
		if (linkHint === undefined) throw new Error("canonical project-link hint is missing");
		const fixture = startPromptRevocationServer([
			{ id: "ambiguous", ...linkHint, name: "Adjusted", is_active: false },
		]);
		const client = new OpenWebUIPromptHintClient({
			baseUrl: fixture.baseUrl,
			apiToken: "token-1",
			installationId: "install-current",
		});

		try {
			const result = await client.migrateGjcPromptHints();

			expect(result).toMatchObject({
				status: "degraded",
				listed: 1,
				revoked: 0,
				ambiguous: 1,
				quarantined: 1,
				failed: 0,
				readbackVerified: true,
			});
			expect(fixture.requests.map(request => `${request.method} ${request.path}`)).toEqual([
				"GET /api/v1/prompts/list?page=1",
				"GET /api/v1/prompts/list?page=1",
			]);
		} finally {
			fixture.stop();
		}
	});

	test("fails closed when a revoke does not disappear on readback", async () => {
		const linkHint = GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS.find(hint => hint.command === "gjc-project-link");
		if (linkHint === undefined) throw new Error("canonical project-link hint is missing");
		const fixture = startPromptRevocationServer([{ id: "legacy", ...linkHint, is_active: true }], {
			ignoreDeletes: true,
		});
		const client = new OpenWebUIPromptHintClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			const result = await client.revokeGjcProjectAdminPromptHints();

			expect(result).toMatchObject({
				status: "degraded",
				degraded: true,
				revoked: 1,
				readbackVerified: false,
			});
		} finally {
			fixture.stop();
		}
	});
});
interface PromptRevocationFixtureRecord {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
	is_active: boolean;
}

interface PromptRevocationFixtureOptions {
	readonly ignoreDeletes?: boolean;
}

function startPromptRevocationServer(
	initialPrompts: readonly PromptRevocationFixtureRecord[],
	options: PromptRevocationFixtureOptions = {},
) {
	const requests: Array<{ readonly method: string; readonly path: string }> = [];
	const prompts = initialPrompts.map(prompt => ({ ...prompt, tags: [...prompt.tags], meta: { ...prompt.meta } }));
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				return Response.json({ items: prompts, total: prompts.length });
			}
			const deleteMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/delete$/);
			if (request.method === "DELETE" && deleteMatch !== null) {
				if (!options.ignoreDeletes) {
					const index = prompts.findIndex(prompt => prompt.id === deleteMatch[1]);
					if (index >= 0) prompts.splice(index, 1);
				}
				return Response.json(true);
			}
			const toggleMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/toggle$/);
			if (request.method === "POST" && toggleMatch !== null) {
				const prompt = prompts.find(item => item.id === toggleMatch[1]);
				if (prompt === undefined) return Response.json({ detail: "not found" }, { status: 404 });
				prompt.is_active = !prompt.is_active;
				return Response.json(prompt);
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
interface PromptVerificationFixtureOptions {
	readonly missingCommand?: string;
	readonly noOpCreate?: boolean;
	readonly inactiveUpdateCommand?: string;
	readonly staleUpdateCommand?: string;
}

interface PromptVerificationFixtureRecord {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: string[];
	readonly meta: Record<string, unknown>;
	is_active: boolean;
}

function startPromptVerificationServer(options: PromptVerificationFixtureOptions = {}) {
	const requests: Array<{ readonly method: string; readonly path: string }> = [];
	const prompts: PromptVerificationFixtureRecord[] = GJC_OPENWEBUI_PROMPT_HINTS.filter(
		hint => hint.command !== options.missingCommand,
	).map((hint, index) => ({
		id: `prompt-${index + 1}`,
		command: hint.command,
		name: hint.command === options.inactiveUpdateCommand ? `${hint.name} before inactive update` : hint.name,
		content: hint.command === options.staleUpdateCommand ? `${hint.content} stale` : hint.content,
		tags: [...hint.tags],
		meta: hint.command === options.staleUpdateCommand ? { ...hint.meta, stale: true } : { ...hint.meta },
		is_active: true,
	}));
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
			if (request.method === "GET" && url.pathname === "/api/v1/prompts/list") {
				return Response.json({ items: prompts, total: prompts.length });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/prompts/create") {
				const body: unknown = await request.json();
				if (!isRecord(body) || typeof body.command !== "string") {
					return Response.json({ detail: "bad prompt" }, { status: 400 });
				}
				const prompt = promptVerificationRecord(`prompt-${prompts.length + 1}`, body, true);
				if (options.noOpCreate && body.command === options.missingCommand) return Response.json(prompt);
				prompts.push(prompt);
				return Response.json(prompt);
			}
			const updateMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/update$/);
			if (request.method === "POST" && updateMatch !== null) {
				const index = prompts.findIndex(prompt => prompt.id === updateMatch[1]);
				if (index < 0) return Response.json({ detail: "not found" }, { status: 404 });
				const existing = prompts[index];
				if (existing === undefined) return Response.json({ detail: "not found" }, { status: 404 });
				const body: unknown = await request.json();
				if (!isRecord(body) || typeof body.command !== "string") {
					return Response.json({ detail: "bad prompt" }, { status: 400 });
				}
				if (existing.command === options.inactiveUpdateCommand) {
					const updated = promptVerificationRecord(existing.id, body, false);
					prompts.splice(index, 1, updated);
					return Response.json(updated);
				}
				if (existing.command === options.staleUpdateCommand) return Response.json(existing);
				const updated = promptVerificationRecord(existing.id, body, true);
				prompts.splice(index, 1, updated);
				return Response.json(updated);
			}
			const toggleMatch = url.pathname.match(/^\/api\/v1\/prompts\/id\/([^/]+)\/toggle$/);
			if (request.method === "POST" && toggleMatch !== null) {
				const index = prompts.findIndex(prompt => prompt.id === toggleMatch[1]);
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

function promptVerificationRecord(
	id: string,
	body: Record<string, unknown>,
	isActive: boolean,
): PromptVerificationFixtureRecord {
	return {
		id,
		command: typeof body.command === "string" ? body.command : "",
		name: typeof body.name === "string" ? body.name : "",
		content: typeof body.content === "string" ? body.content : "",
		tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : [],
		meta: isRecord(body.meta) ? { ...body.meta } : {},
		is_active: isActive,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
