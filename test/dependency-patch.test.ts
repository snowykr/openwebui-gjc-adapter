import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { RpcClientOptions, RpcDefaultModelSelection } from "@gajae-code/coding-agent";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { YAML } from "bun";

const PATCH_PATH = join(import.meta.dir, "..", "patches", "@gajae-code%2Fcoding-agent@0.10.0.patch");
const EXPECTED_PATCH_SHA256 = "73d29f9fc3575f46dd0e5e8bca8a4aff575a4a62531cdb4069458553ce6ecd8a";
const EXPECTED_PATCH_FILES = [
	"dist/types/config/settings.d.ts",
	"dist/types/modes/index.d.ts",
	"dist/types/modes/rpc/rpc-client.d.ts",
	"dist/types/modes/rpc/rpc-types.d.ts",
	"dist/types/session/agent-session.d.ts",
	"src/config/settings.ts",
	"src/internal-urls/docs-index.generated.ts",
	"src/modes/index.ts",
	"src/modes/rpc/rpc-client.ts",
	"src/modes/rpc/rpc-types.ts",
	"src/modes/shared/agent-wire/command-dispatch.ts",
	"src/modes/shared/agent-wire/command-validation.ts",
	"src/modes/shared/agent-wire/scopes.ts",
	"src/session/agent-session.ts",
] as const;
const EXPECTED_PATCH_BYTES = 279_523;
const EXPECTED_PATCH_LINES = 788;
const UNDEFINED_ENV_OPTIONS = { env: { PI_CONFIG_DIR: undefined } } satisfies RpcClientOptions;

function retainSelectionType(selection: RpcDefaultModelSelection): RpcDefaultModelSelection {
	return selection;
}

describe("approved canonical setter dependency", () => {
	test("pins exact npm 0.10.0 packages and the approved patch when the manifest is read", async () => {
		// Given
		const manifest = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

		// When
		const dependencies = Reflect.get(manifest, "dependencies");
		const patchedDependencies = Reflect.get(manifest, "patchedDependencies");

		// Then
		expect(dependencies).toEqual({
			"@gajae-code/ai": "0.10.0",
			"@gajae-code/coding-agent": "0.10.0",
		});
		expect(patchedDependencies).toEqual({
			"@gajae-code/coding-agent@0.10.0": "patches/@gajae-code%2Fcoding-agent@0.10.0.patch",
		});
	});

	test("matches approved PR provenance and file allowlist when the patch is inspected", async () => {
		// Given
		const patchFile = Bun.file(PATCH_PATH);
		const exists = await patchFile.exists();
		expect(exists, "expected the approved generated Bun patch").toBe(true);
		if (!exists) return;
		const patch = await patchFile.text();

		// When
		const headers = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
		const digest = new Bun.CryptoHasher("sha256").update(patch).digest("hex");

		// Then
		expect(digest).toBe(EXPECTED_PATCH_SHA256);
		expect(patchFile.size).toBe(EXPECTED_PATCH_BYTES);
		expect(patch.match(/\n/gu)?.length).toBe(EXPECTED_PATCH_LINES);
		expect(headers.map(match => match[1])).toEqual([...EXPECTED_PATCH_FILES]);
		expect(headers.every(match => match[1] === match[2])).toBe(true);
		expect(patch).toContain("env?: Readonly<Record<string, string | undefined>>;");
		expect(patch).toContain("type RpcDefaultModelSelection,");
		expect(patch).toContain("setGlobalModelRoleIfCurrentAndFlush(");
		expect(patch).toContain(
			'setGlobalModelRoleIfCurrentAndFlush("default", selectedDefaultModelRole, previousDefaultModelRole)',
		);
	});

	test("exports the positional canonical setter when the installed package is loaded", async () => {
		// Given
		const { RpcClient } = await import("@gajae-code/coding-agent");

		// When
		const setter = Reflect.get(RpcClient.prototype, "setDefaultModelSelection");

		// Then
		expect(setter).toBeFunction();
		expect(setter.length).toBe(3);
		expect(UNDEFINED_ENV_OPTIONS.env.PI_CONFIG_DIR).toBeUndefined();
		expect(retainSelectionType({ provider: "provider", modelId: "model", thinkingLevel: "off" })).toEqual({
			provider: "provider",
			modelId: "model",
			thinkingLevel: "off",
		});
	});

	test("does not restore a stale default over a newer external selection", async () => {
		// Given: this process has durably selected a model, then another RPC process has persisted a newer default.
		const testDir = await fs.mkdtemp(join(os.tmpdir(), "openwebui-gjc-adapter-default-model-race-"));
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		const configPath = join(agentDir, "config.yml");
		try {
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(projectDir, { recursive: true });
			await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
			const settings = await Settings.init({ agentDir, cwd: projectDir });
			await settings.setGlobalModelRoleAndFlush("default", "provider/failing:medium");
			await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/newer:high" } }));

			// When: the failed selection attempts its durable rollback.
			const restored = await settings.setGlobalModelRoleIfCurrentAndFlush(
				"default",
				"provider/failing:medium",
				"provider/original:low",
			);

			// Then: the newer shared-file value survives.
			expect(restored).toBe(false);
			expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
				modelRoles: { default: "provider/newer:high" },
			});
			expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/newer:high" });
		} finally {
			resetSettingsForTest();
			await fs.rm(testDir, { recursive: true, force: true });
		}
	});
});
