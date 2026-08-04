import { describe, expect, test } from "bun:test";
import { buildOpenWebUIStatusEvent } from "../src/openwebui/events";
import { createOpenWebUIPrincipalClient, OpenWebUIHttpClient } from "../src/openwebui/http-client";
import { startRecordingServer } from "./openwebui-http-fixture";
import { baseChat } from "./openwebui-test-fixtures";

describe("OpenWebUIHttpClient projection writes", () => {
	test("upserts projection records and posts message events over authenticated HTTP", async () => {
		const fixtureOptions: { responseBody?: unknown } = {};
		const fixture = startRecordingServer(fixtureOptions);
		const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });

		try {
			await client.upsertFolder({
				id: "folder-1",
				owner_user_id: "owner-1",
				name: "Owner 1 folder",
				metadata: { gjc_adapter: { project_id: "project-1" } },
			});
			await client.upsertChat(baseChat);
			fixtureOptions.responseBody = {
				id: "chat-1",
				user_id: "owner-1",
				title: "Adapter title",
				folder_id: "folder-1",
				meta: { gjc_adapter: { operation_id: "upsert-chat" } },
				chat: {
					title: "Adapter title",
					history: { messages: {}, currentId: null },
				},
			};
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
			fixtureOptions.responseBody = true;
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
				{ method: "GET", path: "/api/v1/chats/chat-1", authorization: "Bearer token-1", body: null },
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
	test("requires a non-empty immutable normal principal user ID", () => {
		const fixture = startRecordingServer();
		try {
			const client = new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" });
			expect(() => createOpenWebUIPrincipalClient(client, "  ")).toThrow("non-empty user ID");
			const principal = createOpenWebUIPrincipalClient(client, "owner-1");
			expect(principal.userId).toBe("owner-1");
			expect(Object.isFrozen(principal)).toBe(true);
		} finally {
			fixture.stop();
		}
	});

	test("rejects a mismatched owner/chat proof before any message event network write", async () => {
		const fixtureOptions: { responseBody?: unknown } = {
			responseBody: {
				id: "chat-1",
				user_id: "owner-1",
				title: "Adapter title",
				folder_id: "folder-1",
				meta: baseChat.metadata,
				chat: { history: baseChat.history },
			},
		};
		const fixture = startRecordingServer(fixtureOptions);
		const client = createOpenWebUIPrincipalClient(
			new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" }),
			"owner-1",
		);
		try {
			const proof = await client.requireChatProof("chat-1");
			await expect(
				client.postMessageEvent({
					chatId: "foreign-chat",
					messageId: "message-1",
					event: buildOpenWebUIStatusEvent({ description: "must not write", done: false }),
					proof,
				}),
			).rejects.toThrow("proof does not match");
			expect(fixture.requests).toHaveLength(1);
			expect(fixture.requests[0]?.method).toBe("GET");
		} finally {
			fixture.stop();
		}
	});
	test("rejects an absent owner/chat proof before any message content network write", async () => {
		const fixture = startRecordingServer();
		const client = createOpenWebUIPrincipalClient(
			new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" }),
			"owner-1",
		);
		try {
			await expect(
				client.updateMessageContent({
					chatId: "chat-1",
					messageId: "message-1",
					content: "must not write",
					proof: undefined as never,
				}),
			).rejects.toThrow("requires an owner/chat proof");
			expect(fixture.requests).toHaveLength(0);
		} finally {
			fixture.stop();
		}
	});

	test("uses a successful owner/chat proof before posting a principal message event", async () => {
		const fixtureOptions: { responseBody?: unknown } = {
			responseBody: {
				id: "chat-1",
				user_id: "owner-1",
				title: "Adapter title",
				folder_id: "folder-1",
				meta: baseChat.metadata,
				chat: { history: baseChat.history },
			},
		};
		const fixture = startRecordingServer(fixtureOptions);
		const client = createOpenWebUIPrincipalClient(
			new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" }),
			"owner-1",
		);
		try {
			const proof = await client.requireChatProof("chat-1");
			fixtureOptions.responseBody = true;
			await client.postMessageEvent({
				chatId: "chat-1",
				messageId: "message-1",
				event: buildOpenWebUIStatusEvent({ description: "proven", done: false }),
				proof,
			});
			expect(fixture.requests.map(request => [request.method, request.path])).toEqual([
				["GET", "/api/v1/chats/chat-1"],
				["POST", "/api/v1/chats/chat-1/messages/message-1/event"],
			]);
		} finally {
			fixture.stop();
		}
	});
	test("rejects foreign file metadata before fetching or materializing file bytes", async () => {
		const fixture = startRecordingServer({
			responseBody: {
				id: "file-1",
				user_id: "owner-2",
				filename: "foreign.txt",
				data: { content: "foreign" },
			},
		});
		const client = createOpenWebUIPrincipalClient(
			new OpenWebUIHttpClient({ baseUrl: fixture.baseUrl, apiToken: "token-1" }),
			"owner-1",
		);
		try {
			await expect(client.getFileBytes("file-1")).rejects.toThrow("foreign file owner");
			expect(fixture.requests).toEqual([
				{ method: "GET", path: "/api/v1/files/file-1", authorization: "Bearer token-1", body: null },
			]);
		} finally {
			fixture.stop();
		}
	});
});
