import { describe, expect, test } from "bun:test";
import {
	buildPendingRecoveryLinkage,
	matchesPendingRecoveryLinkage,
	parsePendingRecoveryLinkage,
} from "../src/configure/bootstrap-state";

const LEGACY_LINKAGE =
	"existing:install:http://openwebui.test:http://adapter.test/v1:8080:/project:8765:managed:enabled:active:recovery-required:controller-quiesced";

function record() {
	return {
		version: 1 as const,
		mode: "existing" as const,
		priorMode: "managed" as const,
		installationId: "install",
		transactionId: "transaction",
		adapterToken: "adapter",
		readinessToken: "readiness",
		targetUrl: "http://openwebui.test",
		providerUrl: "http://adapter.test/v1",
		uiPort: 8080,
		bindPort: 8765,
		projectRoot: "/project",
		priorControllerEnabled: true,
		priorControllerActive: true,
		controllerRecoveryRequired: true,
		controllerQuiesced: true,
		linkage: "",
	};
}

describe("pending recovery runtime-location linkage", () => {
	test("keeps legacy bytes when both direct fields are absent", () => {
		expect(buildPendingRecoveryLinkage(record())).toBe(LEGACY_LINKAGE);
	});

	for (const vector of [
		{
			name: "config directory only",
			fields: { gjcConfigDirName: ".gjc" },
			suffix: ":gjc-paths-v1:WyIuZ2pjIixudWxsXQ",
		},
		{
			name: "coding-agent directory only",
			fields: { gjcCodingAgentDir: "/a:b" },
			suffix: ":gjc-paths-v1:W251bGwsIi9hOmIiXQ",
		},
		{
			name: "both direct fields",
			fields: { gjcConfigDirName: ".gjc", gjcCodingAgentDir: "/a:b" },
			suffix: ":gjc-paths-v1:WyIuZ2pjIiwiL2E6YiJd",
		},
	] as const) {
		test(`encodes the exact ${vector.name} vector`, () => {
			expect(buildPendingRecoveryLinkage({ ...record(), ...vector.fields })).toBe(
				`${LEGACY_LINKAGE}${vector.suffix}`,
			);
		});
	}

	test("round-trips target runtime-location identity through the strict parser", () => {
		const pending = {
			...record(),
			gjcConfigDirName: ".target-gjc",
			gjcCodingAgentDir: "/target/agent",
		};
		const linked = { ...pending, linkage: buildPendingRecoveryLinkage(pending) };
		expect(parsePendingRecoveryLinkage(linked)).toEqual(linked);
		expect(matchesPendingRecoveryLinkage(linked)).toBe(true);
	});

	test("validates direct fields before encoding or accepting a record", () => {
		for (const fields of [{ gjcConfigDirName: "../escape" }, { gjcCodingAgentDir: "/agent/../escape" }] as const) {
			expect(() => buildPendingRecoveryLinkage({ ...record(), ...fields })).toThrow();
			expect(matchesPendingRecoveryLinkage({ ...record(), ...fields, linkage: LEGACY_LINKAGE })).toBe(false);
		}
	});
});
