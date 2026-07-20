import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import {
	discoverFreshGjcSessionFile,
	GjcSessionLoadError,
	loadGjcSessionFile,
	snapshotGjcSessionFiles,
} from "../src/gjc/session-loader";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("loadGjcSessionFile", () => {
	test.each([
		["missing", undefined],
		["non-string", 42],
		["blank", "  "],
	] as const)("rejects a session header whose cwd is %s", async (caseName, cwd) => {
		// Given: an upstream-loadable session header with an invalid project authority cwd.
		const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), `gjc-session-loader-${caseName}-cwd-`));
		tempDirs.push(dirPath);
		const filePath = path.join(dirPath, `${caseName}-cwd.jsonl`);
		await Bun.write(
			filePath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: `${caseName}-cwd`,
				timestamp: "2026-07-08T00:00:00.000Z",
				cwd,
			})}\n`,
		);

		// When: the adapter loads the file through its session boundary.
		const loading = loadGjcSessionFile(filePath);

		// Then: a deterministic typed header diagnostic rejects it.
		await expect(loading).rejects.toBeInstanceOf(GjcSessionLoadError);
		await expect(loading).rejects.toMatchObject({
			diagnostics: [
				{
					code: "invalid_session_header",
					message: `GJC session header in ${filePath} must contain a non-empty string cwd`,
					filePath,
				},
			],
		});
	});

	test("splits header and entries from an existing JSONL session file without overwriting it", async () => {
		const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-loader-"));
		tempDirs.push(dirPath);
		const filePath = path.join(dirPath, "session.jsonl");
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: "session-file",
			timestamp: "2026-07-08T00:00:00.000Z",
			cwd: dirPath,
		};
		const entry: SessionMessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-07-08T00:00:00.000Z",
			message: { role: "user", content: "hello", timestamp: 1 },
		};
		const originalContent = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
		await Bun.write(filePath, originalContent);

		const loaded = await loadGjcSessionFile(filePath);
		const afterContent = await Bun.file(filePath).text();

		expect(loaded.header).toEqual(header);
		expect(loaded.entries).toEqual([entry]);
		expect(loaded.diagnostics).toEqual([]);
		expect(afterContent).toBe(originalContent);
	});

	test("throws typed diagnostics for corrupt or invalid loads", async () => {
		const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-loader-"));
		tempDirs.push(dirPath);
		const filePath = path.join(dirPath, "invalid.jsonl");
		await Bun.write(filePath, `${JSON.stringify({ type: "message", id: "entry-1", parentId: null })}\n`);

		await expect(loadGjcSessionFile(filePath)).rejects.toBeInstanceOf(GjcSessionLoadError);
		await expect(loadGjcSessionFile(filePath)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "empty_session_file", filePath })],
		});
	});
});
describe("fresh GJC session discovery", () => {
	test("selects the unique fresh successor transcript", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		tempDirs.push(sessionRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const baseline = await snapshotGjcSessionFiles(sessionRoot);

		await writeSessionHeader(path.join(sessionRoot, "successor.jsonl"), "successor", projectCwd);

		await expect(discoverFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd)).resolves.toMatchObject({
			filePath: path.join(sessionRoot, "successor.jsonl"),
			header: { id: "successor", cwd: projectCwd },
		});
	});

	test("rejects symlink transcript escapes", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-outside-"));
		tempDirs.push(sessionRoot, outsideRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const baseline = await snapshotGjcSessionFiles(sessionRoot);
		const outsideTranscript = path.join(outsideRoot, "successor.jsonl");
		await writeSessionHeader(outsideTranscript, "successor", projectCwd);
		await fs.symlink(outsideTranscript, path.join(sessionRoot, "escape.jsonl"));

		await expect(discoverFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd)).rejects.toBeInstanceOf(
			GjcSessionLoadError,
		);
		expect(await snapshotGjcSessionFiles(sessionRoot)).toEqual(new Set([path.join(sessionRoot, "escape.jsonl")]));
	});
	test("excludes baseline names even when they were invalid or symlinks", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-outside-"));
		tempDirs.push(sessionRoot, outsideRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const invalidPath = path.join(sessionRoot, "invalid.jsonl");
		const symlinkPath = path.join(sessionRoot, "symlink.jsonl");
		await Bun.write(invalidPath, "not jsonl\n");
		await fs.symlink(path.join(outsideRoot, "outside.jsonl"), symlinkPath);
		const baseline = await snapshotGjcSessionFiles(sessionRoot);

		await writeSessionHeader(invalidPath, "successor", projectCwd);
		await fs.rm(symlinkPath);
		await writeSessionHeader(symlinkPath, "successor", projectCwd);
		await writeSessionHeader(path.join(sessionRoot, "fresh.jsonl"), "successor", projectCwd);

		await expect(discoverFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd)).resolves.toMatchObject({
			filePath: path.join(sessionRoot, "fresh.jsonl"),
		});
	});

	test("rejects a pathname replacement coordinated after held-byte ingestion", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		const replacementRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-replacement-"));
		tempDirs.push(sessionRoot, replacementRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const baseline = await snapshotGjcSessionFiles(sessionRoot);
		const candidate = path.join(sessionRoot, "successor.jsonl");
		const replacement = path.join(replacementRoot, "replacement.jsonl");
		await writeSessionHeader(candidate, "successor", projectCwd);
		await writeSessionHeader(replacement, "successor", projectCwd);
		const handle = await fs.open(candidate, "r");
		const prototype = Object.getPrototypeOf(handle) as { readFile: () => Promise<Buffer> };
		await handle.close();
		const originalReadFile = prototype.readFile;
		let swapped = false;
		prototype.readFile = async function (this: { readFile: () => Promise<Buffer> }): Promise<Buffer> {
			const bytes = await originalReadFile.call(this);
			if (!swapped) {
				swapped = true;
				await fs.rename(replacement, candidate);
			}
			return bytes;
		};
		try {
			await expect(
				discoverFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd),
			).rejects.toBeInstanceOf(GjcSessionLoadError);
		} finally {
			prototype.readFile = originalReadFile;
		}
	});

	test("rejects ambiguous fresh transcripts and transcripts from another cwd", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		tempDirs.push(sessionRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const baseline = await snapshotGjcSessionFiles(sessionRoot);

		await writeSessionHeader(path.join(sessionRoot, "successor-a.jsonl"), "successor", projectCwd);
		await writeSessionHeader(path.join(sessionRoot, "successor-b.jsonl"), "successor", projectCwd);
		await expect(discoverFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "corrupt_session_file" })],
		});

		await fs.rm(path.join(sessionRoot, "successor-b.jsonl"));
		await fs.rm(path.join(sessionRoot, "successor-a.jsonl"));
		await writeSessionHeader(
			path.join(sessionRoot, "wrong-cwd.jsonl"),
			"successor",
			path.join(sessionRoot, "other-project"),
		);
		await expect(discoverFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd)).rejects.toBeInstanceOf(
			GjcSessionLoadError,
		);
	});
});

async function writeSessionHeader(filePath: string, id: string, cwd: string): Promise<void> {
	await Bun.write(
		filePath,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-07-08T00:00:00.000Z", cwd })}\n`,
	);
}
