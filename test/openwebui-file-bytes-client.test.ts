import { describe, expect, test } from "bun:test";
import { OpenWebUIHttpClient } from "../src/openwebui/client";
import { startRecordingServer } from "./openwebui-http-fixture";

describe("OpenWebUIHttpClient original file bytes", () => {
	test("downloads original OpenWebUI file bytes for direct GJC file handoff", async () => {
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
		const fixture = startRecordingServer({
			binaryResponses: [{ path: "/api/v1/files/file-1/content", body: pdfBytes, contentType: "application/pdf" }],
		});
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await expect(client.getFileBytes("file-1")).resolves.toEqual({
				id: "file-1",
				bytes: pdfBytes,
				contentType: "application/pdf",
			});
			expect(fixture.requests).toContainEqual({
				method: "GET",
				path: "/api/v1/files/file-1/content",
				authorization: "Bearer token-1",
				body: null,
			});
		} finally {
			fixture.stop();
		}
	});

	test("treats missing original OpenWebUI file bytes as unavailable fallback material", async () => {
		const fixture = startRecordingServer({ notFoundPath: "/api/v1/files/missing-file/content" });
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await expect(client.getFileBytes("missing-file")).resolves.toBeUndefined();
			expect(fixture.requests).toContainEqual({
				method: "GET",
				path: "/api/v1/files/missing-file/content",
				authorization: "Bearer token-1",
				body: null,
			});
		} finally {
			fixture.stop();
		}
	});
});
