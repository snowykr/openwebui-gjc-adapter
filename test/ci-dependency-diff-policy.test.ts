import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareDependencyInputs } from "../scripts/ci-dependency-diff-policy";

const manifest = JSON.stringify({ dependencies: { alpha: "1.0.0" }, trustedDependencies: ["safe"] });
const lock = new TextEncoder().encode("lock-v1");

describe("compareDependencyInputs", () => {
	test("accepts unchanged dependency policy inputs", () => {
		expect(compareDependencyInputs(manifest, manifest, lock, lock)).toEqual({
			changedFields: [],
			lockChanged: false,
			ok: true,
		});
	});

	test("rejects lock-only drift", () => {
		expect(compareDependencyInputs(manifest, manifest, lock, new TextEncoder().encode("lock-v2"))).toEqual({
			changedFields: [],
			lockChanged: true,
			ok: false,
			diagnostic: "DEPENDENCY_LOCK_DRIFT",
		});
	});

	test("allows dependency changes with or without lock changes", () => {
		const changed = JSON.stringify({ dependencies: { alpha: "2.0.0" }, trustedDependencies: ["safe"] });
		expect(compareDependencyInputs(manifest, changed, lock, lock)).toMatchObject({
			changedFields: ["dependencies"],
			ok: true,
		});
		expect(compareDependencyInputs(manifest, changed, lock, new TextEncoder().encode("lock-v2"))).toMatchObject({
			changedFields: ["dependencies"],
			lockChanged: true,
			ok: true,
		});
	});
	test("rejects invalid selected fields and duplicate trusted dependencies", () => {
		expect(() => compareDependencyInputs('{"dependencies":null}', manifest, lock, lock)).toThrow(
			"DEPENDENCY_POLICY_INPUT_INVALID:invalid-dependencies",
		);
		expect(() => compareDependencyInputs('{"trustedDependencies":["safe","safe"]}', manifest, lock, lock)).toThrow(
			"DEPENDENCY_POLICY_INPUT_INVALID:duplicate-trustedDependencies",
		);
	});
});

describe("ci-dependency-diff-policy CLI", () => {
	test("emits DEPENDENCY_LOCK_DRIFT for lock-only drift", () => {
		const root = mkdtempSync(join(tmpdir(), "ci-dependency-diff-policy-"));
		const baseRoot = join(root, "base");
		const headRoot = join(root, "head");
		try {
			for (const [directory, lockContents] of [
				[baseRoot, "lock-v1"],
				[headRoot, "lock-v2"],
			] as const) {
				Bun.spawnSync(["git", "init", directory]);
				writeFileSync(join(directory, "package.json"), manifest);
				writeFileSync(join(directory, "bun.lock"), lockContents);
				Bun.spawnSync(["git", "-C", directory, "add", "package.json", "bun.lock"]);
				Bun.spawnSync([
					"git",
					"-C",
					directory,
					"-c",
					"user.name=CI policy test",
					"-c",
					"user.email=ci-policy@example.invalid",
					"commit",
					"-m",
					"fixture",
				]);
			}
			const sha = (directory: string) =>
				Bun.spawnSync(["git", "-C", directory, "rev-parse", "HEAD"]).stdout.toString().trim();
			const result = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "../scripts/ci-dependency-diff-policy.ts")],
				{
					env: {
						...process.env,
						BASE_ROOT: baseRoot,
						HEAD_ROOT: headRoot,
						BASE_SHA: sha(baseRoot),
						HEAD_SHA: sha(headRoot),
					},
				},
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toBe("DEPENDENCY_LOCK_DRIFT\n");
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});
});
