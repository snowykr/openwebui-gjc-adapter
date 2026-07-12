import { describe, expect, test } from "bun:test";
import { buildHealthReport, buildReadinessReport } from "../src/health";

describe("readiness behavior", () => {
	test("is ready only when authentication and prompt seed are both complete", () => {
		expect(
			buildReadinessReport({
				openWebUIAuthenticated: true,
				promptHintsSeeded: true,
				mode: "managed",
				generation: "gen-1",
				model: "model-1",
			}),
		).toEqual({
			status: "ready",
			service: "openwebui-gjc-adapter",
			identity: { mode: "managed" },
			generation: "gen-1",
			model: "model-1",
			seed: { promptHints: "ready" },
		});
		expect(
			buildReadinessReport({ openWebUIAuthenticated: false, promptHintsSeeded: true, mode: "existing" }).status,
		).toBe("not_ready");
		expect(buildReadinessReport({ openWebUIAuthenticated: true, promptHintsSeeded: false }).seed).toEqual({
			promptHints: "pending",
		});
	});

	test("keeps optional readiness metadata null and health checks deterministic", () => {
		expect(buildReadinessReport({ openWebUIAuthenticated: false, promptHintsSeeded: false })).toMatchObject({
			identity: { mode: "unknown" },
			generation: null,
			model: null,
		});
		expect(buildHealthReport([{ name: "openwebui", status: "degraded", detail: "unavailable" }])).toEqual({
			status: "degraded",
			service: "openwebui-gjc-adapter",
			checks: [{ name: "openwebui", status: "degraded", detail: "unavailable" }],
		});
	});
});
