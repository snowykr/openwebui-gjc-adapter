import { describe, expect, test } from "bun:test";
import {
	InMemoryOpenWebUIProjectionRepository,
	OpenWebUIHttpClient,
	OpenWebUIHttpError,
} from "../src/openwebui/client";
import { buildOpenWebUIStatusEvent } from "../src/openwebui/events";

const baseChat = {
	id: "chat-1",
	owner_user_id: "owner-1",
	folder_id: "folder-1",
	title: "Adapter title",
	metadata: { gjc_adapter: { operation_id: "upsert-chat" } },
	history: { messages: {}, currentId: null },
};

describe("InMemoryOpenWebUIProjectionRepository", () => {
	test("scopes folders and chats by owner id", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();

		await repository.upsertFolder({
			id: "folder-1",
			owner_user_id: "owner-1",
			name: "Owner 1 folder",
			metadata: {},
		});
		await repository.upsertFolder({
			id: "folder-1",
			owner_user_id: "owner-2",
			name: "Owner 2 folder",
			metadata: {},
		});
		await repository.upsertChat(baseChat);
		await repository.upsertChat({ ...baseChat, owner_user_id: "owner-2", title: "Other owner title" });

		expect(await repository.getChat("owner-1", "chat-1")).toMatchObject({
			owner_user_id: "owner-1",
			title: "Adapter title",
		});
		expect(await repository.getChat("owner-2", "chat-1")).toMatchObject({
			owner_user_id: "owner-2",
			title: "Other owner title",
		});
		expect(await repository.getChat("owner-3", "chat-1")).toBeUndefined();
	});

	test("preserves non-adapter chat metadata, rating, and title on adapter upsert", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();

		await repository.upsertChat({
			...baseChat,
			title: "User renamed title",
			rating: 5,
			metadata: { user_note: "keep me", gjc_adapter: { operation_id: "old" } },
		});
		await repository.upsertChat({
			...baseChat,
			title: "Adapter replacement title",
			rating: 1,
			metadata: { gjc_adapter: { operation_id: "new" } },
		});

		expect(await repository.getChat("owner-1", "chat-1")).toMatchObject({
			title: "User renamed title",
			rating: 5,
			metadata: {
				user_note: "keep me",
				gjc_adapter: { operation_id: "new" },
			},
		});
	});
});

describe("OpenWebUIHttpClient", () => {
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

			expect(fixture.requests).toEqual([
				{
					method: "PUT",
					path: "/api/v1/folders/folder-1",
					authorization: "Bearer token-1",
					body: {
						id: "folder-1",
						owner_user_id: "owner-1",
						name: "Owner 1 folder",
						metadata: { gjc_adapter: { project_id: "project-1" } },
					},
				},
				{
					method: "PUT",
					path: "/api/v1/chats/chat-1",
					authorization: "Bearer token-1",
					body: baseChat,
				},
				{
					method: "PUT",
					path: "/api/v1/chats/chat-1/messages",
					authorization: "Bearer token-1",
					body: {
						owner_user_id: "owner-1",
						messages: [
							{
								id: "message-1",
								chat_id: "chat-1",
								owner_user_id: "owner-1",
								role: "assistant",
								content: "hello",
								metadata: { gjc_adapter: { projected_message_id: "entry-1" } },
							},
						],
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
			]);
		} finally {
			fixture.stop();
		}
	});

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
				method: "PUT",
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
					path: "/api/v1/chats/chat-1?owner_user_id=owner-1",
					authorization: "Bearer token-1",
					body: null,
				},
				{
					method: "GET",
					path: "/api/v1/chats/missing?owner_user_id=owner-1",
					authorization: "Bearer token-1",
					body: null,
				},
			]);
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
				path: "/api/v1/chats/chat-1?owner_user_id=owner-1",
				detail: "chat.owner_user_id must be a string",
			});
		} finally {
			fixture.stop();
		}
	});
});

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | null;
	readonly body: unknown;
}

type RecordingServerOptions = Readonly<{
	failPath?: string;
	notFoundPath?: string;
	responseBody?: unknown;
	status?: number;
}>;

function startRecordingServer(options: RecordingServerOptions = {}) {
	const requests: RecordedRequest[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body: unknown = request.method === "GET" ? null : await request.json();
			requests.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				authorization: request.headers.get("authorization"),
				body,
			});
			if (url.pathname === options.notFoundPath) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			if (url.pathname === options.failPath) {
				return Response.json({ error: "forced failure" }, { status: options.status ?? 500 });
			}
			return Response.json(options.responseBody ?? { ok: true });
		},
	});

	return {
		baseUrl: `http://${server.hostname}:${server.port}`,
		requests,
		stop: () => server.stop(true),
	};
}
