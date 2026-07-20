import { describe, expect, test } from "bun:test";
import { decodeSessionEntry } from "../src/gjc/session-transcript-decoder";

const entry = (message: unknown) => ({
	type: "message",
	id: "entry-1",
	parentId: null,
	timestamp: "2026-07-08T00:00:00.000Z",
	message,
});

const assistantToolMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "Checking" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } },
	],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-5",
	usage: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1,
};

describe("session transcript message decoder", () => {
	test("accepts released message DTO content and tool structures", () => {
		expect(
			decodeSessionEntry(entry({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 })),
		).toBeDefined();
		expect(decodeSessionEntry(entry(assistantToolMessage))).toBeDefined();
		expect(
			decodeSessionEntry(
				entry({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				}),
			),
		).toBeDefined();
	});

	test.each([
		["role", { role: "system", content: "hello", timestamp: 1 }],
		["timestamp", { role: "user", content: "hello", timestamp: "1" }],
		["content", { role: "user", content: [{ type: "text", text: 1 }], timestamp: 1 }],
		["tool", { ...assistantToolMessage, content: [{ type: "toolCall", id: "call-1", name: "read", arguments: [] }] }],
	] as const)("rejects malformed nested %s", (_field, message) => {
		expect(decodeSessionEntry(entry(message))).toBeUndefined();
	});
});
describe("session transcript entry decoder", () => {
	const entryBase = {
		id: "entry-1",
		parentId: null,
		timestamp: "2026-07-08T00:00:00.000Z",
	};

	test("accepts released optional label and cleared fields when omitted", () => {
		expect(decodeSessionEntry({ type: "label", ...entryBase, targetId: "target-1" })).toBeDefined();
		expect(
			decodeSessionEntry({
				type: "configured_model_chain",
				...entryBase,
				role: "default",
				entries: ["openai/gpt-5"],
				origin: "settings",
				explicitHead: true,
			}),
		).toBeDefined();
	});

	test.each([
		["arbitrary values", [{ unexpected: true }]],
		["assistant-only parts", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]],
		["malformed text parts", [{ type: "text", text: 1 }]],
	] as const)("rejects custom_message content with %s", (_description, content) => {
		expect(
			decodeSessionEntry({
				type: "custom_message",
				...entryBase,
				customType: "notice",
				content,
				display: true,
			}),
		).toBeUndefined();
	});
	test("accepts released custom-message attribution and eviction metadata", () => {
		expect(
			decodeSessionEntry({
				type: "custom_message",
				...entryBase,
				customType: "notice",
				content: "persisted context",
				display: false,
				attribution: "agent",
				evictedContent: {
					evictedAt: 1,
					reason: "compacted_history",
					compactionEntryId: "compaction-1",
					firstKeptEntryId: "entry-2",
					payloads: {
						content: {
							kind: "cold_spill",
							ref: "blob-1",
							encoding: "utf8",
							originalChars: 17,
							sha256: "abc123",
							bytes: 17,
						},
					},
				},
			}),
		).toBeDefined();
	});

	test.each([
		["unknown attribution", { attribution: "extension" }],
		["malformed eviction marker", { evictedContent: { evictedAt: 1 } }],
		[
			"unknown eviction payload metadata",
			{
				evictedContent: {
					evictedAt: 1,
					reason: "compacted_history",
					compactionEntryId: "compaction-1",
					firstKeptEntryId: "entry-2",
					payloads: {
						content: {
							kind: "cold_spill",
							ref: "blob-1",
							encoding: "utf8",
							originalChars: 17,
							sha256: "abc123",
							bytes: 17,
							extra: true,
						},
					},
				},
			},
		],
	] as const)("rejects custom-message %s", (_description, metadata) => {
		expect(
			decodeSessionEntry({
				type: "custom_message",
				...entryBase,
				customType: "notice",
				content: "persisted context",
				display: false,
				...metadata,
			}),
		).toBeUndefined();
	});
});
