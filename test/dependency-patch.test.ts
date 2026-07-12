import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RpcClientOptions, RpcDefaultModelSelection } from "@gajae-code/coding-agent";

const PATCH_PATH = join(import.meta.dir, "..", "patches", "@gajae-code%2Fcoding-agent@0.10.0.patch");
const EXPECTED_PATCH_SHA256 = "3200948e7617b93d54df1431dfd368af60c1549f05e894e39ed7893e3f6f3328";
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
const EXPECTED_PATCH_BYTES = 277_547;
const EXPECTED_PATCH_LINES = 736;
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
});
