import { describe, expect, test } from "bun:test";
import {
	containsSecretLiteral,
	readRunnerConfig,
	redactLiterals,
	requireOnlyGjcModel,
	requireProjectListCompletion,
	sanitizeRunId,
} from "../scripts/e2e-runner-openwebui-support";

const baseEnv = {
	E2E_RUNNER_OPENWEBUI_BASE_URL: "http://127.0.0.1:3000",
	E2E_OPENWEBUI_API_TOKEN: "jwt-token",
	E2E_OUTPUT_ROOT: "/tmp/runner-e2e",
	E2E_RUN_ID: "123-1",
};

describe("runner OpenWebUI E2E support", () => {
	test("accepts only the fixed loopback OpenWebUI endpoint", () => {
		expect(readRunnerConfig(baseEnv).openWebUIBaseUrl).toBe("http://127.0.0.1:3000");
		expect(() => readRunnerConfig({ ...baseEnv, E2E_RUNNER_OPENWEBUI_BASE_URL: "http://adapter:8765" })).toThrow(
			"E2E_OPENWEBUI_URL_MUST_BE_LOOPBACK",
		);
	});

	test("rejects unsafe run ids and validates deterministic provider responses", () => {
		expect(sanitizeRunId("../unsafe run")).toBe("unsafe-run");
		expect(() => sanitizeRunId("...")).toThrow("E2E_INVALID_RUN_ID");
		requireOnlyGjcModel({ data: [{ id: "gjc" }] });
		expect(() => requireOnlyGjcModel({ data: [{ id: "other" }] })).toThrow("E2E_UNEXPECTED_MODELS");
		requireProjectListCompletion({ choices: [{ message: { content: "No GJC projects are linked." } }] });
		expect(() => requireProjectListCompletion({ choices: [] })).toThrow("E2E_UNEXPECTED_COMPLETION");
	});

	test("redacts generated values and dynamically acquired JWTs before scanning diagnostics", () => {
		const secrets = ["adapter-secret", "admin-password", "webui-key", "dynamic-jwt"];
		const output = redactLiterals(
			"Authorization: Bearer dynamic-jwt adapter-secret admin-password webui-key",
			secrets,
		);
		expect(output).not.toContain("dynamic-jwt");
		expect(containsSecretLiteral(output, secrets)).toBeFalse();
		expect(containsSecretLiteral("leaked dynamic-jwt", secrets)).toBeTrue();
	});
});
