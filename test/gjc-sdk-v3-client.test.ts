import { describe, expect, test } from "bun:test";
import { SdkV3Client } from "../src/gjc/sdk-v3-client";
import { SdkV3ProtocolError } from "../src/gjc/sdk-v3-protocol";

type TestFrame = Readonly<Record<string, unknown>>;

describe("SDK v3 client boundaries", () => {
	test.each([
		["malformed JSON", "{"],
		["wrong protocol version", JSON.stringify({ type: "server_hello", protocolVersion: 2 })],
		["error before hello", JSON.stringify({ type: "error", code: "unauthorized", message: "denied" })],
	])("Given %s before hello When reconnecting Then the released client retries until a hello is accepted", async (_caseName, firstFrame) => {
		// Given
		let connections = 0;
		let firstConnectionClosed = false;
		let firstSocket: Bun.ServerWebSocket<undefined> | undefined;
		const server = Bun.serve({
			port: 0,
			fetch(request, bunServer) {
				return bunServer.upgrade(request, { data: undefined })
					? undefined
					: new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					connections += 1;
					if (connections === 1) firstSocket = socket;
					socket.send(
						connections === 1
							? firstFrame
							: JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "valid" }),
					);
				},
				message(socket, message) {
					const frame = parseFrame(message);
					socket.send(
						JSON.stringify({
							type: "query_response",
							id: frame.id,
							ok: true,
							page: { items: ["reconnected"], complete: true },
						}),
					);
				},
				close(socket) {
					if (socket === firstSocket) firstConnectionClosed = true;
				},
			},
		});
		const client = new SdkV3Client({ url: `ws://127.0.0.1:${server.port}`, token: "test" });

		try {
			// When
			await client.connect(500);
			const items = await client.queryAll("models.list/current", {}, 200);

			// Then
			expect(items).toEqual(["reconnected"]);
			expect(connections).toBe(_caseName === "wrong protocol version" ? 1 : 2);
			expect(firstConnectionClosed).toBe(_caseName !== "wrong protocol version");
		} finally {
			client.detach();
			server.stop(true);
		}
	});

	test("Given a query repeats its continuation cursor When collecting all pages Then it fails after the repeated page", async () => {
		// Given
		let requests = 0;
		const server = startQueryServer(frame => {
			requests += 1;
			return {
				type: "query_response",
				id: frame.id,
				ok: true,
				page: { items: [requests], complete: false, continuationCursor: "same-cursor" },
			};
		});
		const client = new SdkV3Client({ url: server.url, token: "test" });

		try {
			await client.connect(200);
			// When
			const result = client.queryAll("models.list/current", {}, 200);

			// Then
			await expect(result).rejects.toBeInstanceOf(SdkV3ProtocolError);
			expect(requests).toBe(2);
		} finally {
			client.detach();
			server.stop();
		}
	});

	test("Given pagination never completes When the page bound is reached Then collection fails deterministically", async () => {
		// Given
		let requests = 0;
		const server = startQueryServer(frame => {
			requests += 1;
			return {
				type: "query_response",
				id: frame.id,
				ok: true,
				page: { items: [], complete: false, continuationCursor: `cursor-${requests}` },
			};
		});
		const client = new SdkV3Client({ url: server.url, token: "test" });

		try {
			await client.connect(2_000);
			// When
			const result = client.queryAll("models.list/current", {}, 2_000);

			// Then
			await expect(result).rejects.toBeInstanceOf(SdkV3ProtocolError);
			expect(requests).toBe(256);
		} finally {
			client.detach();
			server.stop();
		}
	});

	test("Given a page exceeds the item bound When collecting it Then collection fails without returning partial data", async () => {
		// Given
		const server = startQueryServer(frame => ({
			type: "query_response",
			id: frame.id,
			ok: true,
			page: { items: Array.from({ length: 100_001 }, (_, index) => index), complete: true },
		}));
		const client = new SdkV3Client({ url: server.url, token: "test" });

		try {
			await client.connect(2_000);
			// When
			const result = client.queryAll("models.list/current", {}, 2_000);

			// Then
			await expect(result).rejects.toBeInstanceOf(SdkV3ProtocolError);
		} finally {
			client.detach();
			server.stop();
		}
	});

	test("Given multiple slow pages When the original deadline expires Then later pages do not receive a fresh timeout", async () => {
		// Given
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch(request, bunServer) {
				return bunServer.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(socket) {
					socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test" }));
				},
				message(socket, message) {
					requests += 1;
					const frame = parseFrame(message);
					setTimeout(() => {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id: frame.id,
								ok: true,
								page:
									requests === 1
										? { items: [1], complete: false, continuationCursor: "next" }
										: { items: [2], complete: true },
							}),
						);
					}, 40);
				},
			},
		});
		const client = new SdkV3Client({ url: `ws://127.0.0.1:${server.port}`, token: "test" });

		try {
			await client.connect(60);
			// When
			const result = client.queryAll("models.list/current", {}, 60);

			// Then
			await expect(result).rejects.toMatchObject({ code: "timeout" });
			expect(requests).toBe(2);
		} finally {
			client.detach();
			server.stop(true);
		}
	});
});

function startQueryServer(response: (frame: TestFrame) => TestFrame): {
	readonly url: string;
	stop(): void;
} {
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "test" }));
			},
			message(socket, message) {
				socket.send(JSON.stringify(response(parseFrame(message))));
			},
		},
	});
	return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function parseFrame(message: string | Buffer): TestFrame {
	const value: unknown = JSON.parse(String(message));
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("frame must be an object");
	}
	return Object.fromEntries(Object.entries(value));
}
