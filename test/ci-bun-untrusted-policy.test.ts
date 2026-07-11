import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateBunUntrustedPolicy } from "../scripts/ci-bun-untrusted-policy";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", "ci-bun-untrusted-policy", name), "utf8");

describe("evaluateBunUntrustedPolicy", () => {
	test("accepts only Bun 1.3.14 clean output", () => {
		expect(evaluateBunUntrustedPolicy(0, fixture("clean.txt"))).toEqual({ ok: true });
		expect(evaluateBunUntrustedPolicy(0, "No untrusted dependencies found\r\n")).toEqual({ ok: true });
	});

	test("rejects blocked lifecycle scripts", () => {
		const output = fixture("blocked.txt");
		expect(evaluateBunUntrustedPolicy(0, output)).toEqual({ ok: false, diagnostic: "UNTRUSTED_DEPENDENCIES" });
	});

	test("fails closed for unexpected output or command failures", () => {
		for (const output of [
			"",
			"Bun 1.3.14\nNo untrusted dependencies found\n",
			"No untrusted dependencies found\n\n",
			"partial",
		]) {
			expect(evaluateBunUntrustedPolicy(0, output)).toEqual({ ok: false, diagnostic: "UNTRUSTED_OUTPUT_INVALID" });
		}
		expect(evaluateBunUntrustedPolicy(1, "No untrusted dependencies found\n")).toEqual({
			ok: false,
			diagnostic: "UNTRUSTED_OUTPUT_INVALID",
		});
	});
});
