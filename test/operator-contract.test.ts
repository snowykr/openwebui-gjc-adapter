import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const README = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("operator contract", () => {
	test("documents canonical model identity and machine-global ordering", () => {
		expect(README).toContain("`gjc/<encoded-provider>/<encoded-model>:<thinking>`");
		expect(README).toContain("uppercase RFC 3986 percent-encoding");
		expect(README).toContain("decode exactly once and re-encode to the same bytes");
		expect(README).toContain("The bare `gjc` alias is accepted only as input and is never emitted");
		expect(README).toContain("machine-global last-successful-writer-wins default");
		expect(README).toContain("does not provide global request ordering or a distributed ordering guarantee");
	});

	test("documents direct runtime flags, precedence, and ambient suppression", () => {
		expect(README).toContain("`--gjc-config-dir-name NAME`");
		expect(README).toContain("`--gjc-coding-agent-dir PATH`");
		expect(README).toContain("Managed configuration rejects both runtime-location flags");
		expect(README).toContain(
			"persisted installed values, then adapter-namespaced environment values, then derived defaults",
		);
		expect(README).toContain("`GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME`");
		expect(README).toContain("`GJC_OPENWEBUI_GJC_CODING_AGENT_DIR`");
		expect(README).toContain("`GJC_CONFIG_DIR`, `PI_CONFIG_DIR`, and `GJC_CODING_AGENT_DIR` do not select");
		expect(README).toContain("XDG variables remain inherited but do not select or relocate these paths");
	});

	test("documents the exact protected paths without broadening the guard", () => {
		for (const protectedPath of ["`configDomain`", "`agentDir`", "`readerWorkspace`", "`readerSessionRoot`"]) {
			expect(README).toContain(protectedPath);
		}
		expect(README).toContain("equal to, an ancestor of, or a descendant of");
		expect(README).toContain("The guard does not cover adapter state, mappings, session stores, or SQLite");
	});

	test("documents recovery authority and adapter failure ownership", () => {
		expect(README).toContain("config-name only, agent-directory only, and both fields together");
		expect(README).toContain("a retry may omit both flags to resume the recorded values");
		expect(README).toContain(
			"a differing retry is rejected before configuration, journal, reset, or deployment writes",
		);
		expect(README).toContain("The adapter invokes the setter once and does not retry, compensate, or roll it back");
		expect(README).toContain("does not roll back an already committed project link or unlink");
	});
});
