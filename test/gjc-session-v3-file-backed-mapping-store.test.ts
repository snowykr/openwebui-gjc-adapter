import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

const authority = (chatId = "chat-1", projectId = "project-1", sessionId = "session-1") => ({
	authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	principalId: "user-1",
	projectId,
	canonicalWorkspace: "/workspace/project-1",
	chatId,
	sessionId,
	generation: 1,
	leaseId: "lease-1",
	epoch: SESSION_AUTHORITY_V3_EPOCH,
	requestKey: "request-1",
});

const mapping = () => ({
	chatId: "chat-1",
	projectId: "project-1",
	sessionId: "session-1",
	rawFrameCursor: 1,
	eventCursor: 2,
	operationId: "initial",
	managedAuthority: authority(),
	attachment: {
		descriptorPath: "/private/session.json",
		descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		payloadDigest: "a".repeat(64),
		generation: 1,
		expectedSessionId: "session-1",
		expectedCwd: "/private",
	},
});

describe("SessionV3FileBackedMappingStore", () => {
	test("writes canonical V3 only and recovers operation state", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-authority-"));
		const filePath = join(directory, "authority.json");
		try {
			const store = new SessionV3FileBackedMappingStore(filePath);
			store.set(mapping());
			store.beginOperation("chat-1", { id: "prompt-1", kind: "prompt", detail: "request" });
			store.transitionOperation("chat-1", "prompt-1", "complete", "done", {
				kind: "turn",
				assistantText: "done",
				managedAuthority: authority(),
				mapping: {
					chatId: "chat-1",
					projectId: "project-1",
					sessionId: "session-1",
					rawFrameCursor: 1,
					eventCursor: 2,
					operationId: "prompt-1",
				},
			});
			const firstBytes = readFileSync(filePath, "utf8");
			expect(firstBytes).toContain('"authorityEpoch":"managed/1"');
			expect(firstBytes).not.toContain("descriptorPath");
			expect(firstBytes).not.toContain("sessionFile");
			store.close();
			const recovered = new SessionV3FileBackedMappingStore(filePath);
			expect(recovered.get("chat-1")).toMatchObject({ sessionId: "session-1" });
			expect(recovered.get("chat-1")?.attachment).toBeUndefined();
			expect(recovered.operation("chat-1", "prompt-1")).toMatchObject({
				state: "complete",
				result: { assistantText: "done" },
			});
			expect(readFileSync(filePath, "utf8")).toBe(firstBytes);
			recovered.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
