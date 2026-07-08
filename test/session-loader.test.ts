import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import { GjcSessionLoadError, loadGjcSessionFile } from "../src/gjc/session-loader";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) {
		await fs.rm(tempDir, { force: true, recursive: true });
	}
});

describe("loadGjcSessionFile", () => {
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
