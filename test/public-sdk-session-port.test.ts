import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachmentFromPublishedSdkEndpoint,
	PublicSdkSessionClient,
	withPublicSdkSessionMutationCoordinator,
} from "../src/gjc/public-sdk-session-port";
import { startSdkFixtureServer } from "./gjc-sdk-v3-server-fixture";

describe("published SDK endpoint attachment", () => {
	test("authorizes only the descriptor bytes held after discovery", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-sdk-endpoint-"));
		const path = join(root, "session-1.json");
		try {
			writeFileSync(path, JSON.stringify({ version: 1, url: "ws://127.0.0.1:3111", token: "discovery-token" }));
			writeFileSync(path, JSON.stringify({ version: 1, url: "ws://127.0.0.1:4123", token: "held-token" }));
			const attachment = attachmentFromPublishedSdkEndpoint("/workspace", "session-1", {
				sessionId: "session-1",
				path,
				url: "ws://attacker.invalid:4123",
				token: "discovery-token",
			});
			expect(attachment.endpoint).toEqual({ url: "ws://127.0.0.1:4123", token: "held-token" });
			expect(attachment.authority?.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("reads held descriptor payloads positionally across repeated authority checks", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-sdk-endpoint-"));
		const path = join(root, "sdk-session-created.json");
		const server = startSdkFixtureServer("turn_complete");
		const client = new PublicSdkSessionClient();
		try {
			writeFileSync(path, JSON.stringify({ version: 1, url: server.url, token: server.token }));
			const attachment = attachmentFromPublishedSdkEndpoint("/workspace", "sdk-session-created", {
				sessionId: "sdk-session-created",
				path,
				url: server.url,
				token: server.token,
			});
			await client.attach(attachment);

			await expect(client.prompt("first", 500)).resolves.toMatchObject({ events: expect.any(Array) });

			writeFileSync(path, JSON.stringify({ version: 1, url: server.url, token: "sdk-fixture-tokem" }));
			const authority = attachment.authority;
			if (authority === undefined) throw new TypeError("expected descriptor authority");
			utimesSync(path, authority.descriptorStat.mtimeMs / 1_000, authority.descriptorStat.mtimeMs / 1_000);
			expect(statSync(path)).toMatchObject(authority.descriptorStat);
			await expect(client.prompt("second", 500)).rejects.toMatchObject({ code: "endpoint_stale" });
		} finally {
			client.detach();
			server.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("rejects missing or noncanonical payload digests at attach while coordinator entry uses session scope", async () => {
		const attachment = {
			sessionId: "session-1",
			cwd: "/workspace",
			endpoint: { url: "ws://127.0.0.1:1", token: "token" },
			authority: {
				descriptorPath: "/unused",
				descriptorStat: { dev: 1, ino: 1, size: 0, mtimeMs: 1 },
				payloadDigest: "A".repeat(64),
				generation: 1,
				expectedSessionId: "session-1",
				expectedCwd: "/workspace",
			},
		};
		const client = new PublicSdkSessionClient();
		await expect(client.attach(attachment)).rejects.toMatchObject({ code: "endpoint_stale" });
		Reflect.deleteProperty(attachment.authority, "payloadDigest");
		await expect(client.attach(attachment)).rejects.toMatchObject({ code: "endpoint_stale" });
		await expect(
			withPublicSdkSessionMutationCoordinator(
				{ cwd: attachment.cwd, sessionId: attachment.sessionId },
				{},
				async () => undefined,
			),
		).resolves.toBeUndefined();
	});

	test("rejects malformed and non-local endpoint descriptors", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-sdk-endpoint-"));
		const path = join(root, "session-1.json");
		try {
			for (const descriptor of [
				"{",
				JSON.stringify({ version: 1, url: "wss://127.0.0.1:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://remote.example:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://localhost:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.1:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.1:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://0177.0.0.1:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://0x7f000001:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://token@127.0.0.1:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:0", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:65536", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:04123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:4123/", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:4123/path", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:4123?query", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://127.0.0.1:4123#fragment", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://[::1]:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://[::ffff:127.0.0.1]:4123", token: "token" }),
				JSON.stringify({ version: 1, url: "ws://2130706433:4123", token: "token" }),
			]) {
				writeFileSync(path, descriptor);
				expect(() =>
					attachmentFromPublishedSdkEndpoint("/workspace", "session-1", {
						sessionId: "session-1",
						path,
						url: "ws://127.0.0.1:1",
						token: "discovery-token",
					}),
				).toThrow();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("rejects FIFO and oversized sparse descriptors before parsing or allocation", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-sdk-endpoint-"));
		const fifoPath = join(root, "session-1.json");
		const sparsePath = join(root, "session-2.json");
		try {
			execFileSync("mkfifo", [fifoPath]);
			expect(() =>
				attachmentFromPublishedSdkEndpoint("/workspace", "session-1", {
					sessionId: "session-1",
					path: fifoPath,
					url: "ws://127.0.0.1:1",
					token: "token",
				}),
			).toThrow();
			writeFileSync(sparsePath, "");
			truncateSync(sparsePath, 16 * 1024 + 1);
			expect(() =>
				attachmentFromPublishedSdkEndpoint("/workspace", "session-2", {
					sessionId: "session-2",
					path: sparsePath,
					url: "ws://127.0.0.1:1",
					token: "token",
				}),
			).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
