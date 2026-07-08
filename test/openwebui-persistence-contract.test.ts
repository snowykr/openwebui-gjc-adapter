import { describe, expect, test } from "bun:test";
import {
	OPENWEBUI_DB_FALLBACK_TABLES,
	OPENWEBUI_METADATA_NAMESPACE,
	OPENWEBUI_OWNERSHIP_PRESERVATION_FIELDS,
	OPENWEBUI_SUPPORTED_ENDPOINTS,
} from "../src/openwebui/persistence-contract";

describe("OpenWebUI persistence contract", () => {
	test("defines the exact Phase 0 DB fallback tables", () => {
		expect(OPENWEBUI_DB_FALLBACK_TABLES).toEqual(["folder", "chat", "chat_message"]);
	});

	test("defines adapter metadata namespace", () => {
		expect(OPENWEBUI_METADATA_NAMESPACE).toBe("gjc_adapter");
	});

	test("defines supported endpoint names and ownership preservation fields", () => {
		expect(OPENWEBUI_SUPPORTED_ENDPOINTS).toEqual([
			"health",
			"version",
			"user",
			"folder",
			"chat",
			"chat_message",
			"message-event",
		]);
		expect(OPENWEBUI_OWNERSHIP_PRESERVATION_FIELDS).toContain("user_id");
	});
});
