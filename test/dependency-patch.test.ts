import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PATCH_PATH = join(import.meta.dir, "..", "patches", "@gajae-code%2Fcoding-agent@0.10.0.patch");
const EXPECTED_PATCH_SHA256 = "4fd8caed7b11852cdb3782c4fa6ddcd9d79235cfd379254110f1d521f16eb11d";
const EXPECTED_PATCH_FILES = [
	"src/config/settings.ts",
	"src/internal-urls/docs-index.generated.ts",
	"src/modes/rpc/rpc-client.ts",
	"src/modes/rpc/rpc-types.ts",
	"src/modes/shared/agent-wire/command-dispatch.ts",
	"src/modes/shared/agent-wire/command-validation.ts",
	"src/modes/shared/agent-wire/scopes.ts",
	"src/session/agent-session.ts",
] as const;

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
		expect(headers.map(match => match[1])).toEqual([...EXPECTED_PATCH_FILES]);
		expect(headers.every(match => match[1] === match[2])).toBe(true);
	});

	test("exports the positional canonical setter when the installed package is loaded", async () => {
		// Given
		const { RpcClient } = await import("@gajae-code/coding-agent");

		// When
		const setter = Reflect.get(RpcClient.prototype, "setDefaultModelSelection");

		// Then
		expect(setter).toBeFunction();
		expect(setter.length).toBe(3);
	});
});
