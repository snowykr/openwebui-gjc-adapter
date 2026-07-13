import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const UPSTREAM_REPOSITORY = "https://github.com/Yeachan-Heo/gajae-code.git";
const UPSTREAM_COMMIT = "a8f9602d0eb569a39725819badc7daed818fe3dc";
const BUN_IMAGE_DIGEST = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const RUST_IMAGE_DIGEST = "sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944";
const PYTHON_IMAGE_DIGEST = "sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b";

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
		expect(dockerfile).not.toContain("COPY patches ./patches");
	});

	test("uses absolute system paths when creating the unprivileged adapter user", async () => {
		// Given
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		// Then
		expect(dockerfile).toContain("/usr/sbin/groupadd --system adapter");
		expect(dockerfile).toContain("/usr/sbin/useradd --system --gid adapter");
	});
});
