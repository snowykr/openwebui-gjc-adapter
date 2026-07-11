import { describe, expect, test } from "bun:test";
import { OpenWebUIHttpClient } from "../src/openwebui/client";
import { buildOpenWebUIStatusEvent } from "../src/openwebui/events";
import { startRecordingServer } from "./openwebui-http-fixture";
import { baseChat } from "./openwebui-test-fixtures";

describe("OpenWebUIHttpClient projection writes", () => {
	test("upserts projection records and posts message events over authenticated HTTP", async () => {
		const fixture = startRecordingServer();
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await client.upsertFolder({
				id: "folder-1",
				owner_user_id: "owner-1",
				name: "Owner 1 folder",
				metadata: { gjc_adapter: { project_id: "project-1" } },
			});
			await client.upsertChat(baseChat);
			await client.replaceChatMessages("owner-1", "chat-1", [
				{
					id: "message-1",
					chat_id: "chat-1",
					owner_user_id: "owner-1",
					role: "assistant",
					content: "hello",
					metadata: { gjc_adapter: { projected_message_id: "entry-1" } },
				},
			]);
			await client.postMessageEvent({
				chatId: "chat-1",
				messageId: "message-1",
				event: buildOpenWebUIStatusEvent({ description: "Running GJC", done: false }),
			});
			await client.updateMessageContent({
				chatId: "chat-1",
				messageId: "message-1",
				content: "final assistant content",
			});

			expect(fixture.requests).toEqual([
				{ method: "GET", path: "/api/v1/folders/folder-1", authorization: "Bearer token-1", body: null },
				{ method: "GET", path: "/api/v1/folders/", authorization: "Bearer token-1", body: null },
				{
					method: "POST",
					path: "/api/v1/folders/",
					authorization: "Bearer token-1",
					body: {
						name: "Owner 1 folder",
						meta: { gjc_adapter: { project_id: "project-1" } },
					},
				},
				{
					method: "POST",
					path: "/api/v1/folders/folder-1/update",
					authorization: "Bearer token-1",
					body: {
						name: "Owner 1 folder",
						meta: { gjc_adapter: { project_id: "project-1" } },
					},
				},
				{ method: "GET", path: "/api/v1/chats/chat-1", authorization: "Bearer token-1", body: null },
				{
					method: "POST",
					path: "/api/v1/chats/import",
					authorization: "Bearer token-1",
					body: {
						chats: [
							{
								chat: {
									title: "Adapter title",
									metadata: { gjc_adapter: { operation_id: "upsert-chat" } },
									meta: { gjc_adapter: { operation_id: "upsert-chat" } },
									history: { messages: {}, currentId: null },
								},
								folder_id: "folder-1",
								meta: { gjc_adapter: { operation_id: "upsert-chat" } },
							},
						],
					},
				},
				{
					method: "POST",
					path: "/api/v1/chats/chat-1/messages/message-1",
					authorization: "Bearer token-1",
					body: {
						role: "assistant",
						content: "hello",
						metadata: { gjc_adapter: { projected_message_id: "entry-1" } },
					},
				},
				{
					method: "POST",
					path: "/api/v1/chats/chat-1/messages/message-1/event",
					authorization: "Bearer token-1",
					body: {
						type: "status",
						data: { description: "Running GJC", done: false },
					},
				},
				{
					method: "POST",
					path: "/api/v1/chats/chat-1/messages/message-1",
					authorization: "Bearer token-1",
					body: { content: "final assistant content" },
				},
			]);
		} finally {
			fixture.stop();
		}
	});
});
