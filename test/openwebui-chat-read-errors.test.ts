import { describe, expect, test } from "bun:test";
import { OpenWebUIHttpClient, OpenWebUIHttpError } from "../src/openwebui/client";
import { startRecordingServer } from "./openwebui-http-fixture";
import { baseChat } from "./openwebui-test-fixtures";

describe("OpenWebUIHttpClient read errors", () => {
	test("throws typed HTTP errors on non-2xx OpenWebUI responses", async () => {
		const fixture = startRecordingServer({ failPath: "/api/v1/chats/chat-1", status: 503 });
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			let caught: unknown;
			try {
				await client.upsertChat(baseChat);
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				caught = error;
			}

			expect(caught).toBeInstanceOf(OpenWebUIHttpError);
			expect(caught).toMatchObject({
				name: "OpenWebUIHttpError",
				method: "GET",
				path: "/api/v1/chats/chat-1",
				status: 503,
				responseBody: '{"error":"forced failure"}',
			});
		} finally {
			fixture.stop();
		}
	});

	test("reads chats and returns undefined for missing OpenWebUI chats", async () => {
		const fixture = startRecordingServer({ responseBody: baseChat, notFoundPath: "/api/v1/chats/missing" });
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await expect(client.getChat("owner-1", "chat-1")).resolves.toEqual(baseChat);
			await expect(client.getChat("owner-1", "missing")).resolves.toBeUndefined();
			expect(fixture.requests).toEqual([
				{
					method: "GET",
					path: "/api/v1/chats/chat-1",
					authorization: "Bearer token-1",
					body: null,
				},
				{
					method: "GET",
					path: "/api/v1/chats/missing",
					authorization: "Bearer token-1",
					body: null,
				},
			]);
		} finally {
			fixture.stop();
		}
	});

	test("throws typed HTTP errors for missing write targets", async () => {
		const fixture = startRecordingServer({ notFoundPath: "/api/v1/chats/chat-1/messages/message-1/event" });
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await expect(
				client.postMessageEvent({
					chatId: "chat-1",
					messageId: "message-1",
					event: { type: "status", data: { description: "missing", done: false } },
				}),
			).rejects.toMatchObject({
				name: "OpenWebUIHttpError",
				method: "POST",
				path: "/api/v1/chats/chat-1/messages/message-1/event",
				status: 404,
			});
		} finally {
			fixture.stop();
		}
	});

	test("rejects malformed OpenWebUI chat responses before returning them", async () => {
		const fixture = startRecordingServer({
			responseBody: { id: "chat-1", history: { messages: {}, currentId: null } },
		});
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await expect(client.getChat("owner-1", "chat-1")).rejects.toMatchObject({
				name: "OpenWebUIInvalidResponseError",
				path: "/api/v1/chats/chat-1",
				detail: "chat.user_id must be a string",
			});
		} finally {
			fixture.stop();
		}
	});
});
