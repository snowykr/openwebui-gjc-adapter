import { describe, expect, test } from "bun:test";
import { buildHealthReport } from "../src/health";

describe("buildHealthReport", () => {
	test("reports ok with no degraded checks", () => {
		expect(buildHealthReport().status).toBe("ok");
		expect(buildHealthReport([{ name: "config", status: "ok" }]).status).toBe("ok");
	});

	test("reports degraded when any check is degraded", () => {
		const report = buildHealthReport([
			{ name: "config", status: "ok" },
			{ name: "openwebui", status: "degraded", detail: "missing token" },
		]);
		expect(report.status).toBe("degraded");
		expect(report.service).toBe("openwebui-gjc-adapter");
	});
});
