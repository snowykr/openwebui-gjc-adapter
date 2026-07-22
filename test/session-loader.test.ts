import { afterEach, describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import { loadHeldGjcSessionFile } from "../src/gjc/session-discovery-reader";
import {
	discoverFreshGjcSessionFile,
	GjcSessionLoadError,
	loadGjcSessionFile,
	snapshotGjcSessionFiles,
	waitForFreshGjcSessionFile,
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
	test.each([
		["unknown type", { type: "unsupported", id: "entry-2", parentId: null, timestamp: "2026-07-08T00:00:00.000Z" }],
		[
			"extra field",
			{
				type: "message",
				id: "entry-2",
				parentId: null,
				timestamp: "2026-07-08T00:00:00.000Z",
				message: { role: "user", content: "hello", timestamp: 1 },
				untrusted: true,
			},
		],
	] as const)("rejects a malformed later entry with %s", async (_caseName, entry) => {
		const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-loader-"));
		tempDirs.push(dirPath);
		const filePath = path.join(dirPath, "session.jsonl");
		await writeSessionHeader(filePath, "session-file", dirPath);
		await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);

		await expect(loadGjcSessionFile(filePath)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "corrupt_session_file", filePath })],
		});
	});

	test("rejects unknown fields on the session header", async () => {
		const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-loader-"));
		tempDirs.push(dirPath);
		const filePath = path.join(dirPath, "session.jsonl");
		await Bun.write(
			filePath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-file",
				timestamp: "2026-07-08T00:00:00.000Z",
				cwd: dirPath,
				untrusted: true,
			})}\n`,
		);

		await expect(loadGjcSessionFile(filePath)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "corrupt_session_file", filePath })],
		});
	});

	test("classifies empty and malformed nonempty session files distinctly", async () => {
		const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-loader-"));
		tempDirs.push(dirPath);
		const emptyFilePath = path.join(dirPath, "empty.jsonl");
		const malformedFilePath = path.join(dirPath, "invalid.jsonl");
		await Bun.write(emptyFilePath, "");
		await Bun.write(malformedFilePath, `${JSON.stringify({ type: "message", id: "entry-1", parentId: null })}\n`);

		await expect(loadGjcSessionFile(emptyFilePath)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "empty_session_file", filePath: emptyFilePath })],
		});
		await expect(loadGjcSessionFile(malformedFilePath)).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "corrupt_session_file", filePath: malformedFilePath })],
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
	test("waits for the accepted session transcript to flush", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		tempDirs.push(sessionRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const baseline = await snapshotGjcSessionFiles(sessionRoot);
		const pending = waitForFreshGjcSessionFile(sessionRoot, baseline, "successor", projectCwd, 500);

		setTimeout(() => {
			void writeSessionHeader(path.join(sessionRoot, "successor.jsonl"), "successor", projectCwd);
		}, 30);

		await expect(pending).resolves.toMatchObject({
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
	test("rejects an intermediate-directory swap to an equal-identity external hard link", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-outside-"));
		tempDirs.push(sessionRoot, outsideRoot);
		const nested = path.join(sessionRoot, "nested");
		const moved = path.join(sessionRoot, "nested-held");
		const candidate = path.join(nested, "successor.jsonl");
		const outsideTranscript = path.join(outsideRoot, "successor.jsonl");
		await fs.mkdir(nested);
		await writeSessionHeader(candidate, "successor", path.join(sessionRoot, "project"));
		await fs.link(candidate, outsideTranscript);
		const handle = await fs.open(candidate, "r");
		const prototype = Object.getPrototypeOf(handle) as { stat: () => Promise<Stats> };
		await handle.close();
		const originalStat = prototype.stat;
		let swapped = false;
		prototype.stat = async function (this: { stat: () => Promise<Stats> }): Promise<Stats> {
			const held = await originalStat.call(this);
			if (!swapped) {
				swapped = true;
				await fs.rename(nested, moved);
				await fs.symlink(outsideRoot, nested);
			}
			return held;
		};
		try {
			await expect(loadHeldGjcSessionFile(sessionRoot, candidate)).rejects.toBeInstanceOf(GjcSessionLoadError);
		} finally {
			prototype.stat = originalStat;
		}
	});
	test("keeps routing contracts below their facades", async () => {
		const gjc = path.join(process.cwd(), "src", "gjc");
		const [router, turnRouter, contract, runner] = await Promise.all([
			Bun.file(path.join(gjc, "session-router.ts")).text(),
			Bun.file(path.join(gjc, "session-turn-router.ts")).text(),
			Bun.file(path.join(gjc, "session-turn-router-contract.ts")).text(),
			Bun.file(path.join(gjc, "turn-runner.ts")).text(),
		]);

		expect({
			routerReexportsLeaf: router.includes('from "./session-turn-router-contract"'),
			turnRouterAvoidsFacade: !turnRouter.includes('from "./session-router"'),
			contractAvoidsFacade: !contract.includes('from "./session-router"'),
			runnerAvoidsFacade: !runner.includes('from "./session-router"'),
		}).toEqual({
			routerReexportsLeaf: true,
			turnRouterAvoidsFacade: true,
			contractAvoidsFacade: true,
			runnerAvoidsFacade: true,
		});
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
	test("rejects intermediate-directory symlink escapes before opening a candidate", async () => {
		const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-discovery-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-outside-"));
		tempDirs.push(sessionRoot, outsideRoot);
		const projectCwd = path.join(sessionRoot, "project");
		const outsideTranscript = path.join(outsideRoot, "successor.jsonl");
		await writeSessionHeader(outsideTranscript, "successor", projectCwd);
		await fs.symlink(outsideRoot, path.join(sessionRoot, "nested"));

		await expect(
			loadHeldGjcSessionFile(sessionRoot, path.join(sessionRoot, "nested", "successor.jsonl")),
		).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: "corrupt_session_file" })],
		});
	});
});

async function writeSessionHeader(filePath: string, id: string, cwd: string): Promise<void> {
	await Bun.write(
		filePath,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-07-08T00:00:00.000Z", cwd })}\n`,
	);
}
