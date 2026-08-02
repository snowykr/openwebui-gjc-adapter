import { describe, expect, test } from "bun:test";
import { GJC_LEGACY_PROMPT_SUGGESTION } from "../src/openwebui/prompt-hints";
import { initializeRuntimeReadiness } from "../src/server";

const runtime = {
	adapterToken: "adapter",
	readinessToken: "ready",
	openWebUIBaseUrl: "http://openwebui.test",
	openWebUIApiToken: "secret",
	readiness: { openWebUIAuthenticated: false, promptHintsSeeded: false, mode: "existing" as const },
};

describe("legacy prompt-suggestion removal", () => {
	test("removes the obsolete GJC suggestion while preserving foreign suggestions", async () => {
		const calls: Request[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			calls.push(new Request(String(input), init));
			if (calls.length === 1) return Response.json({ id: "admin" });
			if (calls.length === 2)
				return Response.json({
					default_prompt_suggestions: [{ title: ["foreign"], content: "x" }, GJC_LEGACY_PROMPT_SUGGESTION],
				});
			return Response.json([{ title: ["foreign"], content: "x" }]);
		}) as typeof fetch;
		try {
			const result = await initializeRuntimeReadiness(runtime);
			expect(result).toMatchObject({ openWebUIAuthenticated: true, promptHintsSeeded: true });
			expect(calls[1]?.url).toBe("http://openwebui.test/api/config");
			expect(calls[2]?.url).toBe("http://openwebui.test/api/v1/configs/suggestions");
			expect(calls[2]?.headers.get("authorization")).toBe("Bearer secret");
			expect(await calls[2]?.json()).toEqual({ suggestions: [{ title: ["foreign"], content: "x" }] });
		} finally {
			globalThis.fetch = original;
		}
	});

	test("does not write prompt suggestions when the obsolete suggestion is absent", async () => {
		const calls: Request[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			calls.push(new Request(String(input), init));
			if (calls.length === 1) return Response.json({ id: "admin" });
			return Response.json({ default_prompt_suggestions: [{ title: ["foreign"], content: "x" }] });
		}) as typeof fetch;
		try {
			const result = await initializeRuntimeReadiness(runtime);
			expect(result).toMatchObject({ openWebUIAuthenticated: true, promptHintsSeeded: true });
			expect(calls).toHaveLength(2);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("does not remove a foreign suggestion with the GJC title", async () => {
		const calls: Request[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			calls.push(new Request(String(input), init));
			if (calls.length === 1) return Response.json({ id: "admin" });
			return Response.json({ default_prompt_suggestions: [{ title: ["GJC"], content: "custom prompt" }] });
		}) as typeof fetch;
		try {
			expect(await initializeRuntimeReadiness(runtime)).toMatchObject({
				openWebUIAuthenticated: true,
				promptHintsSeeded: true,
			});
			expect(calls).toHaveLength(2);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("fails closed when removal readback does not match", async () => {
		const original = globalThis.fetch;
		let count = 0;
		globalThis.fetch = (async () => {
			count += 1;
			if (count === 1) return Response.json({ id: "admin" });
			if (count === 2) return Response.json({ default_prompt_suggestions: [GJC_LEGACY_PROMPT_SUGGESTION] });
			return Response.json([GJC_LEGACY_PROMPT_SUGGESTION]);
		}) as unknown as typeof fetch;
		try {
			expect((await initializeRuntimeReadiness(runtime)).promptHintsSeeded).toBe(false);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("removal failures do not expose the OpenWebUI API token", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async input => {
			if (String(input).endsWith("/api/v1/auths/")) return Response.json({ id: "admin" });
			return new Response("no", { status: 503 });
		}) as typeof fetch;
		try {
			const result = await initializeRuntimeReadiness(runtime);
			expect(result).toMatchObject({ openWebUIAuthenticated: true, promptHintsSeeded: false });
			expect(JSON.stringify(result)).not.toContain("secret");
		} finally {
			globalThis.fetch = original;
		}
	});
});
