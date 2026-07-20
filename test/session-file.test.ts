import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSdkSessionFile, SessionFileBoundaryError } from "../src/gjc/session-file";
import type { RegisteredProject } from "../src/projects/registry";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "gjc-legacy-session-"));
	const legacyRoot = join(root, "project", ".gjc", "sessions");
	const sdkRoot = join(root, "sdk", "sessions");
	mkdirSync(legacyRoot, { recursive: true });
	return {
		root,
		legacyRoot,
		sdkRoot,
		project: {
			id: "project",
			name: "Project",
			cwd: join(root, "project"),
			allowedRoot: root,
			createdAt: new Date("2026-07-20T00:00:00.000Z"),
			sessionRoot: legacyRoot,
		} satisfies RegisteredProject,
	};
}

function legacyHeader(id: string, cwd: string, version = 3): string {
	return `${JSON.stringify({ type: "session", version, id, timestamp: "2026-07-20T00:00:00.000Z", cwd })}\n`;
}

test("migrates an explicitly mapped v3 legacy transcript whose header identifies the mapped session", async () => {
	const input = fixture();
	const source = join(input.legacyRoot, "legacy-file-name.jsonl");
	try {
		writeFileSync(source, legacyHeader("mapped-session", input.project.cwd));
		const migrated = await ensureSdkSessionFile(input.project, source, input.sdkRoot, "mapped-session");
		expect(migrated).toBe(join(input.sdkRoot, "legacy-file-name.jsonl"));
		expect(readFileSync(migrated!, "utf8")).toBe(legacyHeader("mapped-session", input.project.cwd));
	} finally {
		rmSync(input.root, { recursive: true, force: true });
	}
});

test.each([
	[
		"missing legacy mapping discriminator",
		"legacy-session.jsonl",
		(cwd: string) => legacyHeader("legacy-session", cwd),
		undefined,
	],
	["generic boundary", "outside.jsonl", (cwd: string) => legacyHeader("outside", cwd, 4), "outside"],
	["bad header", "bad-header.jsonl", () => "not json\n", "bad-header"],
	["header identity mismatch", "expected.jsonl", (cwd: string) => legacyHeader("different", cwd), "expected"],
] as const)("preserves the SDK boundary error for a %s", async (_name, fileName, contents, expectedSessionId) => {
	const input = fixture();
	const source = join(input.legacyRoot, fileName);
	try {
		writeFileSync(source, typeof contents === "string" ? contents : contents(input.project.cwd));
		await expect(
			ensureSdkSessionFile(input.project, source, input.sdkRoot, expectedSessionId),
		).rejects.toBeInstanceOf(SessionFileBoundaryError);
	} finally {
		rmSync(input.root, { recursive: true, force: true });
	}
});
test("preserves the SDK boundary error when a legacy transcript belongs to a foreign project cwd", async () => {
	const input = fixture();
	const source = join(input.legacyRoot, "foreign-cwd.jsonl");
	const foreignCwd = join(input.root, "foreign-project");
	try {
		mkdirSync(foreignCwd);
		writeFileSync(source, legacyHeader("foreign-cwd", foreignCwd));
		await expect(ensureSdkSessionFile(input.project, source, input.sdkRoot, "foreign-cwd")).rejects.toBeInstanceOf(
			SessionFileBoundaryError,
		);
	} finally {
		rmSync(input.root, { recursive: true, force: true });
	}
});

test("migrates a legacy transcript whose cwd is a symlink equivalent to the registered project cwd", async () => {
	const input = fixture();
	const source = join(input.legacyRoot, "equivalent-cwd.jsonl");
	const equivalentCwd = join(input.root, "equivalent-project");
	try {
		symlinkSync(input.project.cwd, equivalentCwd);
		writeFileSync(source, legacyHeader("equivalent-cwd", equivalentCwd));
		const migrated = await ensureSdkSessionFile(input.project, source, input.sdkRoot, "equivalent-cwd");
		expect(migrated).toBe(join(input.sdkRoot, "equivalent-cwd.jsonl"));
	} finally {
		rmSync(input.root, { recursive: true, force: true });
	}
});

test("preserves the SDK boundary error for a legacy-root symlink", async () => {
	const input = fixture();
	const source = join(input.legacyRoot, "linked.jsonl");
	const target = join(input.root, "target.jsonl");
	try {
		writeFileSync(target, legacyHeader("linked", input.project.cwd));
		symlinkSync(target, source);
		await expect(ensureSdkSessionFile(input.project, source, input.sdkRoot, "linked")).rejects.toBeInstanceOf(
			SessionFileBoundaryError,
		);
	} finally {
		rmSync(input.root, { recursive: true, force: true });
	}
});
