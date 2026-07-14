import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const UPSTREAM_REPOSITORY = "https://github.com/Yeachan-Heo/gajae-code.git";
const UPSTREAM_COMMIT = "6fae7cc5475ba85b075608f1e87e6c0cb9e8693d";
const BUN_IMAGE_DIGEST = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const RUST_IMAGE_DIGEST = "sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944";
const PYTHON_IMAGE_DIGEST = "sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b";
const BROKER_RUNTIME_PATH = "packages/coding-agent/src/sdk/broker/runtime.ts";
const BROKER_FIXTURE_PATH = "test/fixtures/gajae-code-6fae7cc-sdk-broker-runtime.txt";
const BROKER_FIXTURE_SHA256 = "767be871319a7ef50da5aea230bbe32964e563caf8259e7d3eee95fa4b49434a";
const BROKER_PATCH_PATH = "patches/gajae-code-6fae7cc-sdk-broker-safe-bun.patch";
const STALE_PROVENANCE_PREFIXES = [
	["d13", "c09c"].join(""),
	["44a", "8645"].join(""),
	["d29", "da7a"].join(""),
	["67a", "8fd4"].join(""),
	["a8f", "9602"].join(""),
] as const;

describe("GJC SDK runtime provenance", () => {
	test("pins the released packages used by adapter source to exact 0.10.1 versions", async () => {
		// Given
		const manifest = await Bun.file(join(ROOT, "package.json")).json();

		// When
		const dependencies = Reflect.get(manifest, "dependencies");
		const patchedDependencies = Reflect.get(manifest, "patchedDependencies");

		// Then
		expect(dependencies).toEqual({
			"@gajae-code/ai": "0.10.1",
			"@gajae-code/coding-agent": "0.10.1",
		});
		expect(patchedDependencies).toBeUndefined();
	});

	test("pins the executable runtime to the inspected immutable dev commit", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		// When
		const repositoryDeclaration = `GJC_UPSTREAM_REPOSITORY=${UPSTREAM_REPOSITORY}`;
		const commitDeclaration = `GJC_UPSTREAM_COMMIT=${UPSTREAM_COMMIT}`;

		// Then
		expect(dockerfile).toContain(repositoryDeclaration);
		expect(dockerfile).toContain(commitDeclaration);
		expect(dockerfile).toContain('git fetch --depth=1 "$GJC_UPSTREAM_REPOSITORY" "$GJC_UPSTREAM_COMMIT"');
		expect(dockerfile).toContain('test "$(git rev-parse HEAD)" = "$GJC_UPSTREAM_COMMIT"');
		expect(dockerfile).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(dockerfile).toContain("bun --cwd=packages/natives run build");
		for (const stalePrefix of STALE_PROVENANCE_PREFIXES) expect(dockerfile).not.toContain(stalePrefix);
	});

	test("pins every external build image and sources Bun from its immutable image", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		// Then
		expect(dockerfile).toContain(`FROM oven/bun:1.3.14@${BUN_IMAGE_DIGEST} AS bun-runtime`);
		expect(dockerfile).toContain(`FROM rust:1.86-slim-bookworm@${RUST_IMAGE_DIGEST} AS gjc-builder`);
		expect(dockerfile).toContain(`FROM python:3.12-slim-bookworm@${PYTHON_IMAGE_DIGEST}`);
		expect(dockerfile).toContain("COPY --from=bun-runtime /usr/local/bin/bun /opt/bun/bin/bun");
		expect(dockerfile).not.toContain("https://bun.sh/install");
		expect(dockerfile).not.toContain("curl -fsSL");
	});

	test("exposes the exact upstream revision through runtime metadata", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();
		const runtimeStageMarker = `FROM python:3.12-slim-bookworm@${PYTHON_IMAGE_DIGEST}`;

		// When
		const runtimeStage = dockerfile.slice(dockerfile.indexOf(runtimeStageMarker));

		// Then
		expect(dockerfile).toContain(runtimeStageMarker);
		expect(runtimeStage).toContain(`GJC_UPSTREAM_COMMIT=${UPSTREAM_COMMIT}`);
		expect(runtimeStage).toContain("org.opencontainers.image.revision=$GJC_UPSTREAM_COMMIT");
	});

	test("prevents stale platform packages from shadowing the freshly built dev native addon", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		// Then
		expect(dockerfile).toContain("rm -rf packages/natives-*/native");
	});

	test("runs the adapter against the pinned source CLI instead of the released legacy binary", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		// When
		const runtimeCommand =
			'exec bun --no-env-file --config=/dev/null /opt/gajae-code/packages/coding-agent/src/cli.ts "$@"';

		// Then
		expect(dockerfile).toContain(runtimeCommand);
		expect(dockerfile).toContain("GJC_OPENWEBUI_GJC_COMMAND=/usr/local/bin/gjc");
		expect(dockerfile).not.toContain("node_modules/.bin/gjc");
	});

	test("applies the pinned source-mode broker isolation patch before installing upstream dependencies", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();
		const manifest = await Bun.file(join(ROOT, "package.json")).json();

		// Then
		const checkoutIndex = dockerfile.indexOf('test "$(git rev-parse HEAD)" = "$GJC_UPSTREAM_COMMIT"');
		const patchCheckIndex = dockerfile.indexOf("git apply --check /tmp/gajae-code-sdk-broker.patch");
		const patchApplyIndex = dockerfile.indexOf("git apply /tmp/gajae-code-sdk-broker.patch");
		const installIndex = dockerfile.indexOf("bun install --frozen-lockfile --ignore-scripts");
		expect(dockerfile).toContain(
			"COPY patches/gajae-code-6fae7cc-sdk-broker-safe-bun.patch /tmp/gajae-code-sdk-broker.patch",
		);
		expect(checkoutIndex).toBeGreaterThan(-1);
		expect(patchCheckIndex).toBeGreaterThan(checkoutIndex);
		expect(patchApplyIndex).toBeGreaterThan(patchCheckIndex);
		expect(installIndex).toBeGreaterThan(patchApplyIndex);
		expect(Reflect.get(manifest, "files")).toContain("patches");
		for (const stalePrefix of STALE_PROVENANCE_PREFIXES) {
			expect(readdirSync(join(ROOT, "patches")).join("\n")).not.toContain(stalePrefix);
			expect(readdirSync(join(ROOT, "test/fixtures")).join("\n")).not.toContain(stalePrefix);
		}
	});

	test("patches only source-mode internal Bun argv and applies cleanly to the exact dev source", () => {
		// Given
		const root = mkdtempSync(join(tmpdir(), "gjc-broker-patch-"));
		const target = join(root, BROKER_RUNTIME_PATH);
		mkdirSync(join(target, ".."), { recursive: true });
		const fixture = readFileSync(join(ROOT, BROKER_FIXTURE_PATH));
		expect(createHash("sha256").update(fixture).digest("hex")).toBe(BROKER_FIXTURE_SHA256);
		writeFileSync(target, fixture);

		try {
			// When
			const patch = join(ROOT, BROKER_PATCH_PATH);
			const checked = Bun.spawnSync(["git", "apply", "--check", patch], { cwd: root });
			expect(checked.exitCode).toBe(0);
			const applied = Bun.spawnSync(["git", "apply", patch], { cwd: root });
			expect(applied.exitCode).toBe(0);
			const source = readFileSync(target, "utf8");

			// Then
			expect(source).toContain(
				'if (runtime.mode === "compiled") return { file: runtime.execPath, args: ["sdk", action] };',
			);
			expect(source).toContain('args: ["--no-env-file", "--config=/dev/null", entrypoint, "sdk", action]');
			expect(source.match(/--no-env-file/g)).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("uses absolute system paths when creating the unprivileged adapter user", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		// Then
		expect(dockerfile).toContain("/usr/sbin/groupadd --system adapter");
		expect(dockerfile).toContain("/usr/sbin/useradd --system --gid adapter");
	});
});
