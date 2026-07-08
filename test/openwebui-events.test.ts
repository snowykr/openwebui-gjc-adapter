import { describe, expect, it } from "bun:test";
import {
	assertSupportedMessageEventType,
	buildOpenWebUICitationEvent,
	buildOpenWebUIFilesEvent,
	buildOpenWebUISourceEvent,
	buildOpenWebUIStatusEvent,
} from "../src/openwebui/events";

describe("OpenWebUI event builders", () => {
	it("builds documented status body with done nested under data", () => {
		expect(buildOpenWebUIStatusEvent({ description: "Running GJC", done: false })).toEqual({
			type: "status",
			data: {
				description: "Running GJC",
				done: false,
			},
		});
	});

	it("builds files body without path ids outside data", () => {
		expect(buildOpenWebUIFilesEvent([{ id: "file-1", name: "trace.txt" }])).toEqual({
			type: "files",
			data: { files: [{ id: "file-1", name: "trace.txt" }] },
		});
	});

	it("builds source and citation bodies with one object payload, not wrapper arrays", () => {
		const source = { name: "doc", url: "https://example.test/doc" };
		const citation = { document: "Quoted text", metadata: { page: 3 } };

		expect(buildOpenWebUISourceEvent(source)).toEqual({ type: "source", data: source });
		expect(buildOpenWebUICitationEvent(citation)).toEqual({ type: "citation", data: citation });
		expect(Array.isArray(buildOpenWebUISourceEvent(source).data)).toBe(false);
		expect(Array.isArray(buildOpenWebUICitationEvent(citation).data)).toBe(false);
	});

	it("rejects unsupported message event types", () => {
		expect(() => assertSupportedMessageEventType("message")).toThrow(
			"Unsupported OpenWebUI message event type: message",
		);
	});
});
