import { describe, expect, test } from "bun:test";
import { GJC_PROMPT_HINTS_PAYLOAD } from "../src/openwebui/prompt-hints";
import { initializeRuntimeReadiness } from "../src/server";

const runtime = {
	adapterToken: "adapter",
	readinessToken: "ready",
	openWebUIBaseUrl: "http://openwebui.test",
	openWebUIApiToken: "secret",
	readiness: { openWebUIAuthenticated: false, promptHintsSeeded: false, mode: "existing" as const },
};

describe("mandatory prompt-hint reconciliation", () => {
	test("authenticated seed success preserves foreign suggestions", async () => {
		const calls: Request[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			calls.push(new Request(String(input), init));
			if (calls.length === 1) return Response.json({ id: "admin" });
			if (calls.length === 2)
				return Response.json({ default_prompt_suggestions: [{ title: ["foreign"], content: "x" }] });
			return Response.json([{ title: ["foreign"], content: "x" }, ...GJC_PROMPT_HINTS_PAYLOAD.suggestions]);
		}) as typeof fetch;
		try {
			const result = await initializeRuntimeReadiness(runtime);
			expect(result).toMatchObject({ openWebUIAuthenticated: true, promptHintsSeeded: true });
			expect(calls[1]?.url).toBe("http://openwebui.test/api/config");
			expect(calls[1]?.headers.get("authorization")).toBe("Bearer secret");
			expect(calls[2]?.url).toBe("http://openwebui.test/api/v1/configs/suggestions");
			expect(calls[2]?.headers.get("authorization")).toBe("Bearer secret");
			expect(await calls[2]?.json()).toEqual({
				suggestions: [{ title: ["foreign"], content: "x" }, ...GJC_PROMPT_HINTS_PAYLOAD.suggestions],
			});
		} finally {
			globalThis.fetch = original;
		}
	});
	test("owned suggestion is replaced and readback mismatch fails closed", async () => {
		const original = globalThis.fetch;
		let count = 0;
		globalThis.fetch = (async (_input, _init) => {
			count++;
			if (count === 1) return Response.json({ id: "admin" });
			if (count === 2) return Response.json({ default_prompt_suggestions: [{ title: ["GJC"], content: "old" }] });
			return Response.json([{ title: ["GJC"], content: "wrong" }]);
		}) as typeof fetch;
		try {
			expect((await initializeRuntimeReadiness(runtime)).promptHintsSeeded).toBe(false);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("seed failure is not ready and does not expose the token", async () => {
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

	test("readback mismatch fails closed", async () => {
		const original = globalThis.fetch;
		let count = 0;
		globalThis.fetch = (async () => {
			count++;
			if (count === 1) return Response.json({ id: "admin" });
			if (count === 2) return Response.json({ default_prompt_suggestions: [] });
			return Response.json([{ title: ["foreign"], content: "x" }]);
		}) as unknown as typeof fetch;
		try {
			expect((await initializeRuntimeReadiness(runtime)).promptHintsSeeded).toBe(false);
		} finally {
			globalThis.fetch = original;
		}
	});
});
