export interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | null;
	readonly body: unknown;
}

export type RecordingServerOptions = Readonly<{
	failPath?: string;
	folders?: readonly {
		readonly id: string;
		readonly name: string;
		readonly meta?: Record<string, unknown>;
		readonly omitUserId?: boolean;
		readonly userId?: string;
	}[];
	notFoundPath?: string;
	responseBody?: unknown;
	binaryResponses?: readonly {
		readonly path: string;
		readonly body: Uint8Array;
		readonly contentType: string;
		readonly status?: number;
	}[];
	status?: number;
}>;

export function startRecordingServer(options: RecordingServerOptions = {}) {
	const requests: RecordedRequest[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body: unknown = request.method === "GET" ? null : await request.json();
			const requestBody = isRecord(body) ? body : {};
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
			const binaryResponse = options.binaryResponses?.find(response => response.path === url.pathname);
			if (request.method === "GET" && binaryResponse !== undefined) {
				return new Response(binaryResponse.body, {
					status: binaryResponse.status ?? 200,
					headers: { "content-type": binaryResponse.contentType },
				});
			}
			const configuredFolder = options.folders?.find(folder => `/api/v1/folders/${folder.id}` === url.pathname);
			if (request.method === "GET" && configuredFolder !== undefined) {
				return Response.json({
					id: configuredFolder.id,
					...(configuredFolder.omitUserId ? {} : { user_id: configuredFolder.userId ?? "owner-1" }),
					name: configuredFolder.name,
					meta: configuredFolder.meta ?? {},
				});
			}
			if (
				request.method === "GET" &&
				url.pathname.startsWith("/api/v1/folders/") &&
				url.pathname !== "/api/v1/folders/"
			) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			if (request.method === "GET" && url.pathname === "/api/v1/folders/") {
				return Response.json(options.folders?.map(folder => ({ id: folder.id, name: folder.name })) ?? []);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/v1/chats/chat-1" &&
				options.responseBody === undefined
			) {
				return Response.json({ detail: "not found" }, { status: 401 });
			}
			if (request.method === "POST" && url.pathname === "/api/v1/folders/") {
				return Response.json({
					id: "folder-1",
					user_id: "owner-1",
					name: "Owner 1 folder",
					meta: requestBody.meta ?? {},
				});
			}
			if (request.method === "POST" && url.pathname === "/api/v1/folders/folder-1/update") {
				return Response.json({
					id: "folder-1",
					user_id: "owner-1",
					name: "Owner 1 folder",
					meta: requestBody.meta ?? {},
				});
			}
			if (request.method === "POST" && url.pathname === "/api/v1/chats/import") {
				const chats = Array.isArray(requestBody.chats) ? requestBody.chats : [];
				const firstChat = isRecord(chats[0]) ? chats[0] : {};
				return Response.json([
					{
						id: "chat-1",
						user_id: "owner-1",
						title: "Adapter title",
						folder_id: firstChat.folder_id ?? null,
						meta: firstChat.meta ?? {},
						chat: firstChat.chat ?? {},
					},
				]);
			}
			if (request.method === "POST" && url.pathname === "/api/v1/chats/real-chat-1") {
				return Response.json({
					id: "real-chat-1",
					user_id: "owner-1",
					title: "Adapter title",
					folder_id: null,
					meta: requestBody.meta ?? {},
					chat: requestBody.chat ?? {},
				});
			}
			if (request.method === "POST" && url.pathname === "/api/v1/chats/real-chat-1/folder") {
				return Response.json({
					id: "real-chat-1",
					user_id: "owner-1",
					title: "Adapter title",
					folder_id: requestBody.folder_id ?? null,
					meta: requestBody.meta ?? {},
					chat: requestBody.chat ?? { title: "Adapter title", history: { messages: {}, currentId: null } },
				});
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
