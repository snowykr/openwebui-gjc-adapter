import { describe, expect, test } from "bun:test";
import { GJC_OPENWEBUI_PROMPT_HINTS, OpenWebUIPromptHintClient } from "../src/openwebui/prompt-hints";
import { startPromptServer } from "./openwebui-prompt-hints-fixtures";

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
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
			]);
			expect(fixture.prompts.map(prompt => prompt.command)).toEqual([
				"gjc-project-link",
				"gjc-project-list",
				"gjc-project-unlink",
				"gjc-skill-deep-interview",
				"gjc-skill-ralplan",
				"gjc-skill-ultragoal",
				"gjc-skill-team",
			]);
			expect(fixture.prompts[0]?.content).toBe("/gjc project link {{PROJECT_PATH}}");
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

			expect(result).toEqual({ created: 5, updated: 1, unchanged: 1, skipped: 0 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/id/prompt-link/update",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
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

			expect(result).toEqual({ created: 6, updated: 0, unchanged: 1, skipped: 0 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/list?page=2",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
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

			expect(result).toEqual({ created: 6, updated: 0, unchanged: 0, skipped: 1 });
			expect(fixture.requests.map(request => request.path)).toEqual([
				"/api/v1/prompts/list?page=1",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
				"/api/v1/prompts/create",
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
