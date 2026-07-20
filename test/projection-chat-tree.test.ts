import { describe, expect, test } from "bun:test";
import type { Message } from "@gajae-code/ai";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import { projectGjcSessionToOpenWebUIChat, validateSessionEntryGraph } from "../src/projection/chat-tree";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "session-1",
	title: "Projected session",
	timestamp: "2026-07-08T00:00:00.000Z",
	cwd: "/repo",
};

function messageEntry(
	id: string,
	parentId: string | null,
	role: Message["role"],
	content: Message["content"],
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-07-08T00:00:00.000Z",
		message: {
			role,
			content,
			timestamp: 1,
		} as Message,
	};
}

describe("projectGjcSessionToOpenWebUIChat", () => {
	test("projects linear message history", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", null, "user", "hello"),
			messageEntry("a1", "u1", "assistant", [{ type: "text", text: "hi" }]),
		];

		const chat = projectGjcSessionToOpenWebUIChat({ sessionFile: "/tmp/session.jsonl", header, entries });

		expect(chat.id).toBe("session-1");
		expect(chat.history.currentId).toBe("a1");
		expect(chat.history.messages.u1).toMatchObject({
			id: "u1",
			parentId: null,
			childrenIds: ["a1"],
			role: "user",
			content: "hello",
		});
		expect(chat.history.messages.a1).toMatchObject({
			id: "a1",
			parentId: "u1",
			childrenIds: [],
			role: "assistant",
			content: "hi",
		});
		expect(chat.metadata.gjc_adapter).toMatchObject({
			sessionFileName: "session.jsonl",
			gjcEntryId: "a1",
			entryCount: 2,
			messageEntryCount: 2,
			nonMessageEntryCount: 0,
		});
		expect(chat.history.messages.a1.metadata.gjc_adapter.gjcEntryId).toBe("a1");
		expect(chat.history.messages.a1.metadata.gjc_adapter.lineageHash).toHaveLength(64);
	});

	test("preserves branched children and active leaf currentId", () => {
		const entries: SessionEntry[] = [
			messageEntry("root", null, "user", "root"),
			messageEntry("left", "root", "assistant", "left"),
			messageEntry("right", "root", "assistant", "right"),
			messageEntry("right-leaf", "right", "user", "continue"),
		];

		const chat = projectGjcSessionToOpenWebUIChat({ sessionFile: "/tmp/branched.jsonl", header, entries });

		expect(chat.history.currentId).toBe("right-leaf");
		expect(chat.history.messages.root.childrenIds).toEqual(["left", "right"]);
		expect(chat.history.messages.right.childrenIds).toEqual(["right-leaf"]);
	});

	test("reports missing parent diagnostics without rejecting projection", () => {
		const entries: SessionEntry[] = [messageEntry("orphan", "missing", "user", "hello")];

		const chat = projectGjcSessionToOpenWebUIChat({ sessionFile: "/tmp/orphan.jsonl", header, entries });

		expect(chat.metadata.gjc_adapter.diagnostics).toEqual([
			expect.objectContaining({ code: "missing_parent", entryId: "orphan", parentId: "missing" }),
		]);
		expect(chat.history.messages.orphan.parentId).toBeNull();
	});

	test("folds non-message entries out of the visible OpenWebUI message tree", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", null, "user", "hello"),
			{
				type: "custom",
				id: "tool-status",
				parentId: "u1",
				timestamp: "2026-07-08T00:00:01.000Z",
				customType: "tool-status",
				data: { status: "running" },
			},
			messageEntry("a1", "tool-status", "assistant", "done"),
		];

		const chat = projectGjcSessionToOpenWebUIChat({ sessionFile: "/tmp/non-message.jsonl", header, entries });

		expect(chat.history.messages.u1.childrenIds).toEqual(["a1"]);
		expect(chat.history.messages.a1.parentId).toBe("u1");
		expect(chat.metadata.gjc_adapter.nonMessageEntryCount).toBe(1);
	});
	test("uses first duplicate entry consistently for validation and projection", () => {
		const entries: SessionEntry[] = [
			messageEntry("root", null, "user", "canonical"),
			messageEntry("child", "root", "assistant", "child"),
			messageEntry("root", "child", "user", "duplicate parent rewrite"),
		];

		const chat = projectGjcSessionToOpenWebUIChat({ sessionFile: "/tmp/duplicate.jsonl", header, entries });

		expect(chat.metadata.gjc_adapter.diagnostics).toEqual([
			expect.objectContaining({ code: "duplicate_entry_id", entryId: "root" }),
		]);
		expect(chat.history.currentId).toBe("child");
		expect(chat.history.messages.root).toMatchObject({
			parentId: null,
			childrenIds: ["child"],
			content: "canonical",
		});
		expect(chat.history.messages.child.parentId).toBe("root");
		expect(chat.metadata.gjc_adapter).toMatchObject({
			entryCount: 2,
			messageEntryCount: 2,
			nonMessageEntryCount: 0,
		});
	});

	test("rejects parent cycles", () => {
		const entries: SessionEntry[] = [
			messageEntry("one", "two", "user", "1"),
			messageEntry("two", "one", "assistant", "2"),
		];

		expect(() => validateSessionEntryGraph(entries)).toThrow("parent cycle");
	});
});
