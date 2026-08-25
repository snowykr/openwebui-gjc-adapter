import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GJC_VERSION = "0.15.0";
const CODING_AGENT_DEV_COMMIT = "e3b3a76a590081ded16214a1188857524d40e701";
const CODING_AGENT_ARTIFACT_NAME = `gajae-code-coding-agent-${CODING_AGENT_DEV_COMMIT}-8ba25005.tgz`;
const CODING_AGENT_ARTIFACT_PATH = `vendor/${CODING_AGENT_ARTIFACT_NAME}`;
const CODING_AGENT_ARTIFACT_URL = `https://raw.githubusercontent.com/snowykr/openwebui-gjc-adapter/c09e31dc85c514cffaf7e44827b47d311620c49f/${CODING_AGENT_ARTIFACT_PATH}`;
const CODING_AGENT_ARTIFACT_SHA256 = "8ba25005471c66871842cddefcdb98c0118ab26c3890b58f1f93665da524f4cb";
const BUN_IMAGE_DIGEST = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const PYTHON_IMAGE_DIGEST = "sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b";

function normalizeRelease(version: string, nativesVersion: string, tag = "") {
	const versionPattern = /^v?\d+\.\d+\.\d+$/;
	if (!versionPattern.test(version) || !versionPattern.test(nativesVersion)) throw new Error("invalid version");
	const normalizedVersion = version.replace(/^v/, "");
	if (nativesVersion.replace(/^v/, "") !== normalizedVersion) throw new Error("mismatched natives");
	const normalizedTag = tag || `v${normalizedVersion}`;
	if (normalizedTag !== `v${normalizedVersion}`) throw new Error("invalid tag");
	return { version: normalizedVersion, nativesVersion: normalizedVersion, tag: normalizedTag };
}
function releaseRoute(event: "repository_dispatch" | "schedule" | "workflow_dispatch", version = "") {
	if (event === "repository_dispatch") return "dispatched-repository";
	if (event === "workflow_dispatch" && version !== "") return "dispatched-manual";
	return "fixed";
}

describe("GJC SDK runtime provenance", () => {
	test("pins the published runtime pair and exact vendored coding-agent development artifact", async () => {
		const manifest = await Bun.file(join(ROOT, "package.json")).json();
		const dependencies = Reflect.get(manifest, "dependencies");

		for (const packageName of ["@gajae-code/ai", "@gajae-code/natives"])
			expect(Reflect.get(dependencies, packageName)).toBe(GJC_VERSION);
		expect(Reflect.get(dependencies, "@gajae-code/coding-agent")).toBe(CODING_AGENT_ARTIFACT_URL);
		const artifact = Bun.file(join(ROOT, CODING_AGENT_ARTIFACT_PATH));
		expect(await artifact.exists()).toBe(true);
		expect(CODING_AGENT_ARTIFACT_NAME).toBe(
			"gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz",
		);
		expect(CODING_AGENT_ARTIFACT_NAME).toContain(CODING_AGENT_DEV_COMMIT);
		expect(
			createHash("sha256")
				.update(new Uint8Array(await artifact.arrayBuffer()))
				.digest("hex"),
		).toBe(CODING_AGENT_ARTIFACT_SHA256);
		expect(Reflect.get(manifest, "patchedDependencies")).toBeUndefined();
		expect(Reflect.get(manifest, "files")).not.toContain("patches");
		expect(existsSync(join(ROOT, "patches"))).toBe(false);
	});

	test("installs and invokes the vendored CLI from the production dependency tree", async () => {
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		expect(dockerfile).toContain("COPY package.json bun.lock ./");
		expect(dockerfile).not.toContain(`COPY ${CODING_AGENT_ARTIFACT_PATH} ${CODING_AGENT_ARTIFACT_PATH}`);
		expect(dockerfile).toContain("bun install --frozen-lockfile --production");
		expect(dockerfile).toContain(
			'gjc_version="$(bun --no-env-file --config=/dev/null ./node_modules/.bin/gjc --version)"',
		);
		expect(dockerfile).toContain(`gjc_version="\${gjc_version#gjc/}"`);
		expect(dockerfile).toContain(`test "$gjc_version" = "${GJC_VERSION}"`);
		expect(dockerfile.match(/org\.opencontainers\.image\.version="[^"]+"/g)).toEqual([
			`org.opencontainers.image.version="${GJC_VERSION}"`,
		]);
		expect(dockerfile).not.toContain("0.11.2");
		expect(dockerfile).toContain("GJC_OPENWEBUI_GJC_COMMAND=/opt/openwebui-gjc-adapter/node_modules/.bin/gjc");
		expect(dockerfile).not.toContain("/opt/gajae-code");
		expect(dockerfile).not.toContain("git fetch");
		expect(dockerfile).not.toContain("git apply");
		expect(dockerfile).not.toContain("packages/natives");
		expect(dockerfile).not.toContain("GJC_UPSTREAM_COMMIT");
	});

	test("documents exact coding-agent provenance and the public managed SDK cutover target", async () => {
		const readme = await Bun.file(join(ROOT, "README.md")).text();
		const changelog = await Bun.file(join(ROOT, "CHANGELOG.md")).text();

		for (const document of [readme, changelog]) {
			expect(document).toContain(CODING_AGENT_ARTIFACT_URL);
			expect(document).toContain(CODING_AGENT_DEV_COMMIT);
			expect(document).toContain(CODING_AGENT_ARTIFACT_SHA256);
			expect(document).toContain("not the registry 0.15.0 tarball");
			expect(document).toContain("Production");
			expect(document).toContain("public managed SDK");
			expect(document).toContain("atomic cutover");
		}
	});

	test("keeps pinned base images and runs as a non-root adapter user", async () => {
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		expect(dockerfile).toContain(`FROM oven/bun:1.3.14@${BUN_IMAGE_DIGEST} AS bun-runtime`);
		expect(dockerfile).toContain(`FROM python:3.12-slim-bookworm@${PYTHON_IMAGE_DIGEST}`);
		expect(dockerfile).toContain("COPY --from=bun-runtime /usr/local/bin/bun /opt/bun/bin/bun");
		expect(dockerfile).toContain(`LABEL org.opencontainers.image.version="${GJC_VERSION}"`);
		expect(dockerfile).toContain("/usr/sbin/groupadd --system --gid 10001 adapter");
		expect(dockerfile).toContain("/usr/sbin/useradd --system --uid 10001 --gid adapter");
		expect(dockerfile).toContain("USER adapter:adapter");
	});

	test("normalizes manual versions and structurally routes release lanes", async () => {
		const workflow = await Bun.file(join(ROOT, ".github/workflows/gjc-release-compat.yml")).text();
		const reusable = await Bun.file(join(ROOT, ".github/workflows/gjc-release-compat-run.yml")).text();

		for (const fixture of [
			{
				version: "0.11.6",
				nativesVersion: "0.11.6",
				tag: "",
				expected: { version: "0.11.6", nativesVersion: "0.11.6", tag: "v0.11.6" },
			},
			{
				version: "v0.11.6",
				nativesVersion: "v0.11.6",
				tag: "v0.11.6",
				expected: { version: "0.11.6", nativesVersion: "0.11.6", tag: "v0.11.6" },
			},
		])
			expect(normalizeRelease(fixture.version, fixture.nativesVersion, fixture.tag)).toEqual(fixture.expected);
		expect(() => normalizeRelease("0.11.6", "0.11.2", "v0.11.6")).toThrow();
		expect(() => normalizeRelease("0.11.6", "0.11.6", "v0.11.2")).toThrow();
		for (const fixture of [
			{ event: "schedule" as const, version: "", route: "fixed" },
			{ event: "workflow_dispatch" as const, version: "", route: "fixed" },
			{ event: "workflow_dispatch" as const, version: "v0.11.6", route: "dispatched-manual" },
			{ event: "repository_dispatch" as const, version: "", route: "dispatched-repository" },
		])
			expect(releaseRoute(fixture.event, fixture.version)).toBe(fixture.route);

		expect(workflow).toContain("types: [gajae-code-release]");
		expect(workflow).toContain("fixed-compatibility:");
		expect(workflow).toContain("dispatched-repository-compatibility:");
		expect(workflow).toContain("dispatched-manual-compatibility:");
		expect(workflow).toContain(
			"if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.version == '')",
		);
		expect(workflow).toContain("if: github.event_name == 'repository_dispatch'");
		expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.version != ''");
		expect(workflow).toContain(`version: \${{ inputs.version }}`);
		expect(workflow).toContain(`natives_version: \${{ inputs.version }}`);
		expect(workflow).toContain(`commit: \${{ inputs.commit || github.sha }}`);
		expect(workflow).toContain("- lane: v0.11.1-pair");
		expect(workflow).toContain("- lane: v0.11.2-pair");
		expect(workflow).toContain("- lane: v0.11.4-pair");
		expect(workflow).toContain("- lane: v0.11.4-pair\n            version: 0.11.4\n            tag: v0.11.4");
		expect(workflow).toContain(`natives_version: \${{ matrix.version }}`);
		expect(workflow).not.toMatch(/^\s+if:.*\bmatrix\./m);

		expect(reusable).toContain("on:\n  workflow_call:");
		expect(reusable).toContain('[[ "$INPUT_VERSION" =~ $version_pattern ]]');
		expect(reusable).toContain(`version="\${INPUT_VERSION#v}"`);
		expect(reusable).toContain(`natives_version="\${INPUT_NATIVES_VERSION#v}"`);
		expect(reusable).toContain(`tag="\${INPUT_TAG:-v$version}"`);
		expect(reusable).toContain('[[ "$tag" = "v$version" ]]');
		expect(reusable).toContain('[[ "$INPUT_COMMIT" =~ $sha_pattern ]]');
		expect(reusable).toContain('if [[ "$INPUT_TRIGGER" = repository_dispatch ]]; then');
		expect(reusable).toContain('test -n "$INPUT_NATIVES_VERSION"');
		expect(reusable).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(reusable).toContain(
			'cp scripts/gjc-release-compat.ts scripts/gjc-release-compat-fixtures.ts scripts/gjc-release-compat-lifecycle.ts scripts/gjc-release-compat-runtime.ts scripts/gjc-release-compat-sdk.ts "$compat_root/"',
		);
		expect(reusable).toContain(`cli_version_pattern='^(gjc/)?([0-9]+\\.[0-9]+\\.[0-9]+)$'`);
		expect(reusable).toContain(`cli_version="\${BASH_REMATCH[2]}"`);
		expect(reusable).toContain('[[ "$cli_version" = "$GJC_CODING_AGENT_VERSION" ]]');
		expect(reusable).toContain("def sanitize(value, key=");
		expect(reusable).toContain('"adapter": {');
		expect(reusable).toContain('"upstream": {');
		expect(reusable).toContain("ADAPTER_REPOSITORY");
		expect(reusable).toContain("operation-report.json");
		expect(reusable).not.toContain("bun update");
		expect(reusable).not.toContain("git apply");
	});

	test("uses only the public managed SDK lifecycle and Router harness", async () => {
		const sources = await Promise.all(
			[
				"scripts/gjc-release-compat.ts",
				"scripts/gjc-release-compat-sdk.ts",
				"scripts/gjc-release-compat-runtime.ts",
				"scripts/gjc-release-compat-lifecycle.ts",
			].map(async path => await Bun.file(join(ROOT, path)).text()),
		);
		const [runner, sdk, runtime, lifecycle] = sources;
		const harness = sources.join("\n");

		expect(sdk).toContain('from "@gajae-code/coding-agent/sdk"');
		expect(sdk).toContain("router.SessionRouter");
		expect(sdk).toContain("lifecycle.createSessionLifecycleService");
		expect(sdk).toContain('type: "query_request"');
		expect(sdk).toContain('type: "control_request"');
		expect(sdk).toContain("generationStatus");
		expect(runner).toContain('"session.create"');
		expect(runner).toContain('"session.resume"');
		expect(runner).toContain('"session.fork"');
		expect(runner).toContain("push({ name, shape: shapeOf(value), observed: value })");
		expect(runner).toContain('Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: providerResponse })');
		expect(runtime).toContain('client.control("turn.prompt", { text })');
		expect(runtime).toContain('client.control("turn.abort", abortInput, { idempotencyKey })');
		expect(runtime).toContain("client.onFrame(frame =>");
		expect(runtime).toContain("frame.body");
		expect(lifecycle).toContain('phase: "sdkLogicalClose"');
		expect(lifecycle).toContain('status.status === "retired"');
		for (const forbidden of [
			"@gajae-code/bridge-client",
			"@gajae-code/coding-agent/sdk/client",
			"@gajae-code/coding-agent/sdk/acp",
			"@gajae-code/coding-agent/sdk/broker",
			"SdkClient",
			"session.switch",
			"tmux",
			"descriptor",
		])
			expect(harness).not.toContain(forbidden);
	});

	test("parses strict released CLI version output without legacy startup wiring", async () => {
		const runner = await Bun.file(join(ROOT, "scripts/gjc-release-compat.ts")).text();
		const parseReleasedCliVersion = (output: string) => {
			const match = /^(?:gjc\/)?(\d+\.\d+\.\d+)$/.exec(output.trim());
			if (match === null) throw new Error("invalid version");
			return match[1];
		};
		expect(parseReleasedCliVersion("gjc/0.11.1\n")).toBe("0.11.1");
		expect(parseReleasedCliVersion("0.11.6\n")).toBe("0.11.6");
		expect(() => parseReleasedCliVersion("gjc/0.11.1 extra")).toThrow("invalid version");
		expect(runner).toContain("const match = /^(?:gjc\\/)?(\\d+\\.\\d+\\.\\d+)$/.exec(output);");
		expect(runner).toContain('Bun.spawn([command, "--version"]');
		expect(runner).not.toContain("startupArguments");
		expect(runner).not.toContain("--thinking");
	});

	test("cites the structural scanner as a separate artifact without fabricating runtime observation", async () => {
		const runner = await Bun.file(join(ROOT, "scripts/gjc-release-compat.ts")).text();

		expect(runner).toContain(
			"Static source contract artifact: \\`test/gjc-sdk-v3-contract.test.ts\\` (separate test artifact; not observed by this runtime harness).",
		);
		expect(runner).not.toContain("structuralFallbackEvidence");
		expect(runner).not.toContain("passed-by-test");
	});
});
