import { describe, expect, it } from "bun:test";
import { parseOpenWebUIHeaders } from "../src/openwebui/headers";

const normalChatHeaders = {
	"X-OpenWebUI-Chat-Id": "chat-1",
	"X-OpenWebUI-Message-Id": "message-1",
	"X-OpenWebUI-User-Message-Id": "user-message-1",
	"X-OpenWebUI-User-Message-Parent-Id": "parent-1",
	"X-OpenWebUI-User-Id": "user-1",
};

describe("parseOpenWebUIHeaders", () => {
	it("parses required normal-chat headers from record-like input", () => {
		const result = parseOpenWebUIHeaders(normalChatHeaders);

		expect(result).toEqual({
			ok: true,
			chatId: "chat-1",
			messageId: "message-1",
			userMessageId: "user-message-1",
			userMessageParentId: "parent-1",
			userId: "user-1",
			task: null,
			isBackgroundTask: false,
			errors: [],
		});
	});

	it("allows an empty parent id for root user messages", () => {
		const result = parseOpenWebUIHeaders({
			...normalChatHeaders,
			"X-OpenWebUI-User-Message-Parent-Id": " ",
		});

		expect(result.ok).toBe(true);
		expect(result.userMessageParentId).toBeNull();
	});

	it("rejects absent and empty required normal-chat fields", () => {
		const result = parseOpenWebUIHeaders({
			"X-OpenWebUI-Chat-Id": " ",
			"X-OpenWebUI-Message-Id": "message-1",
			"X-OpenWebUI-User-Message-Parent-Id": "parent-1",
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toEqual([
			expect.objectContaining({ name: "X-OpenWebUI-Chat-Id", code: "empty" }),
			expect.objectContaining({ name: "X-OpenWebUI-User-Message-Id", code: "missing" }),
		]);
	});

	it("rejects literal unresolved placeholders", () => {
		const result = parseOpenWebUIHeaders({
			...normalChatHeaders,
			"X-OpenWebUI-User-Message-Id": "{{USER_MESSAGE_ID}}",
		});

		expect(result.ok).toBe(false);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ name: "X-OpenWebUI-User-Message-Id", code: "placeholder" }),
		);
	});

	it("classifies non-empty task header as background without requiring session continuation fields", () => {
		const result = parseOpenWebUIHeaders(new Headers({ "X-OpenWebUI-Task": "title_generation" }));

		expect(result).toEqual({
			ok: true,
			chatId: "",
			messageId: "",
			userMessageId: "",
			userMessageParentId: null,
			userId: null,
			task: "title_generation",
			isBackgroundTask: true,
			errors: [],
		});
	});
});
