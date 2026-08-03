import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeIngressId, legacyCloseIngressId, type SessionCloseIngress } from "../src/gjc/session-router";
import type { LiveGatewayRunner } from "../src/live/chat-completions";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";
import { createAdapterRequestHandler, startAdapterServer } from "../src/server";
import { CANONICAL_MODEL_IDS, LOW_MODEL_ID, staticModelReaderFactory } from "./model-selection-fixtures";

describe("createAdapterRequestHandler", () => {
	test("returns health status", async () => {
		const handler = createAdapterRequestHandler([{ name: "config", status: "ok" }]);
		const response = await handler(new Request("http://adapter.test/healthz"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "openwebui-gjc-adapter",
			checks: [{ name: "config", status: "ok" }],
		});
	});

	test("returns 404 for unknown routes", async () => {
		const handler = createAdapterRequestHandler();
		const response = await handler(new Request("http://adapter.test/unknown"));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});

	test("returns model list from optional route dependencies", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("unused"), modelReaderFactory },
		});

		const response = await handler(new Request("http://adapter.test/v1/models"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: CANONICAL_MODEL_IDS.map(id => ({
				id,
				name: id.slice("gjc/".length),
				object: "model",
				created: 1783468800,
				owned_by: "gjc",
			})),
		});
	});
	test("advertises the Codex display name without changing its canonical model ID", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: fixedRunner("unused"),
				modelReaderFactory: codexModelReaderFactory,
			},
		});

		const response = await handler(new Request("http://adapter.test/v1/models"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: "list",
			data: [
				{
					id: "gjc/openai-codex/gpt-5.6-luna:off",
					name: "codex/gpt-5.6-luna:off",
					object: "model",
					created: 1783468800,
					owned_by: "gjc",
				},
				{
					id: "gjc/openai-codex/gpt-5.6-luna:low",
					name: "codex/gpt-5.6-luna:low",
					object: "model",
					created: 1783468800,
					owned_by: "gjc",
				},
			],
		});
	});

	test("requires configured adapter bearer tokens for OpenAI-compatible routes", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: fixedRunner("unused"),
				modelReaderFactory,
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
			},
		});

		const unauthorized = await handler(new Request("http://adapter.test/v1/models"));
		const authorized = await handler(
			new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer adapter-token" } }),
		);

		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toMatchObject({ error: { code: "invalid_api_key" } });
		expect(authorized.status).toBe(200);
	});

	test("fails closed when CLI service requires but lacks an adapter API token", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: fixedRunner("unused"),
				modelReaderFactory,
				requireAdapterApiToken: true,
			},
		});

		const response = await handler(new Request("http://adapter.test/v1/models"));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "adapter_api_token_unconfigured" } });
	});
	test("protects runtime readiness separately from the provider bearer token", async () => {
		const handler = createAdapterRequestHandler({
			routes: { projects: [project], owner, runner: fixedRunner("unused"), modelReaderFactory },
			runtime: {
				adapterToken: "provider-token",
				readinessToken: "readiness-token",
				readiness: { openWebUIAuthenticated: true, promptHintsSeeded: true, mode: "managed" },
			},
		});

		const unauthorized = await handler(new Request("http://adapter.test/readyz"));
		const ready = await handler(
			new Request("http://adapter.test/readyz", { headers: { authorization: "Bearer readiness-token" } }),
		);
		const providerOnReadiness = await handler(
			new Request("http://adapter.test/readyz", { headers: { authorization: "Bearer provider-token" } }),
		);
		const provider = await handler(
			new Request("http://adapter.test/v1/models", { headers: { authorization: "Bearer provider-token" } }),
		);

		expect(unauthorized.status).toBe(401);
		expect(ready.status).toBe(200);
		expect(providerOnReadiness.status).toBe(401);
		expect(await ready.json()).toMatchObject({ status: "ready", identity: { mode: "managed" } });
		expect(provider.status).toBe(200);
	});

	test("routes a canonical Codex ID without using its display name as authority", async () => {
		let receivedModelId: string | undefined;
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: {
					run: input => {
						receivedModelId = input.requestedModelId;
						return { content: "handled", model: input.requestedModelId };
					},
				},
				modelReaderFactory,
			},
		});

		const response = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-OpenWebUI-Chat-Id": "chat-1",
					"X-OpenWebUI-Message-Id": "assistant-1",
					"X-OpenWebUI-User-Message-Id": "user-1",
					"X-OpenWebUI-User-Message-Parent-Id": "",
					"X-OpenWebUI-User-Id": "owner-1",
				},
				body: JSON.stringify({
					model: "gjc/openai-codex/gpt-5.6-luna:low",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("application/json");
		expect(await response.json()).toMatchObject({
			object: "chat.completion",
			choices: [{ message: { role: "assistant", content: "handled" } }],
		});
		expect(receivedModelId).toBe("gjc/openai-codex/gpt-5.6-luna:low");
	});
	test("rejects a Codex display label as a model authority", async () => {
		let runnerCalls = 0;
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: {
					run: () => {
						runnerCalls += 1;
						return { content: "unexpected", model: "gjc/openai-codex/gpt-5.6-luna:low" };
					},
				},
				modelReaderFactory,
			},
		});

		const response = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-OpenWebUI-Chat-Id": "chat-1",
					"X-OpenWebUI-Message-Id": "assistant-1",
					"X-OpenWebUI-User-Message-Id": "user-1",
					"X-OpenWebUI-User-Message-Parent-Id": "",
					"X-OpenWebUI-User-Id": "owner-1",
				},
				body: JSON.stringify({
					model: "codex/gpt-5.6-luna:low",
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "model_not_found" } });
		expect(runnerCalls).toBe(0);
	});
	test("keeps malformed JSON errors and streaming responses on the current chat route", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: { run: () => ({ chunks: ["a", "b"], model: LOW_MODEL_ID }) },
				modelReaderFactory,
			},
		});
		const malformed = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		);
		const streaming = await handler(
			new Request("http://adapter.test/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-OpenWebUI-Chat-Id": "chat-1",
					"X-OpenWebUI-Message-Id": "assistant-1",
					"X-OpenWebUI-User-Message-Id": "user-1",
					"X-OpenWebUI-User-Message-Parent-Id": "",
					"X-OpenWebUI-User-Id": "owner-1",
				},
				body: JSON.stringify({ model: "gjc", stream: true, messages: [{ role: "user", content: "hello" }] }),
			}),
		);

		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: { code: "invalid_json" } });
		expect(streaming.headers.get("content-type")).toStartWith("text/event-stream");
		expect(await streaming.text()).toContain("data: [DONE]");
	});
	test("uses a client operation ID for close responses without persisting the bearer token", async () => {
		const mapping = {
			chatId: "chat-1",
			projectId: "demo",
			sessionId: "session-1",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "turn-1",
		};
		const ingresses: SessionCloseIngress[] = [];
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: fixedRunner("unused"),
				adapterApiToken: "adapter-token",
				requireAdapterApiToken: true,
				mappings: { get: chatId => (chatId === mapping.chatId ? mapping : undefined) },
				closeSession: async (_mapping, ingress) => {
					ingresses.push(ingress);
					return { status: "closed" };
				},
			},
		});

		const response = await handler(
			new Request("http://adapter.test/v1/chats/chat-1/close", {
				method: "POST",
				headers: { authorization: "Bearer adapter-token", "idempotency-key": "close-operation-1" },
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "closed", operationId: "close-operation-1" });
		expect(ingresses).toHaveLength(1);
		expect(ingresses[0]?.ingressId).not.toContain("adapter-token");
		expect(ingresses[0]?.ingressId).toBe(closeIngressId("http:close-operation-1", mapping));
		expect(ingresses[0]?.legacyIngress).toEqual({
			ingressId: legacyCloseIngressId("close-operation-1", mapping),
			ingressHash: legacyCloseIngressId("close-operation-1", mapping),
		});
	});
});
describe("Bun transport configuration", () => {
	test("sets a bounded idle timeout above Bun's default", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const serve = spyOn(Bun, "serve");
		let handle: Awaited<ReturnType<typeof startAdapterServer>> | undefined;

		try {
			handle = await startAdapterServer({
				host: "127.0.0.1",
				port: 0,
				runtimeRoot,
				runtimeLock: await RuntimeSingletonLock.acquire(runtimeRoot),
				turnTimeoutMs: 180_000,
			});
			const serverOptions = serve.mock.calls[0]?.[0];

			expect(serverOptions).toMatchObject({ idleTimeout: 181 });
		} finally {
			await handle?.stop();
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});
	test("starts server and runner shutdown concurrently, then releases the lock", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const events: string[] = [];
		let releaseServer!: () => void;
		let releaseRunner!: () => void;
		const serverReady = new Promise<void>(resolve => {
			releaseServer = resolve;
		});
		const runnerReady = new Promise<void>(resolve => {
			releaseRunner = resolve;
		});
		const serve = spyOn(Bun, "serve").mockImplementation(
			() =>
				({
					url: new URL("http://adapter.test/"),
					stop: async () => {
						events.push("server-start");
						await serverReady;
						events.push("server-end");
					},
				}) as never,
		);
		const lock = await RuntimeSingletonLock.acquire(runtimeRoot);
		const originalRelease = lock.release.bind(lock);
		const release = spyOn(lock, "release").mockImplementation(async () => {
			events.push("lock");
			await originalRelease();
		});
		try {
			const handle = await startAdapterServer({
				host: "127.0.0.1",
				port: 0,
				runtimeRoot,
				runtimeLock: lock,
				turnTimeoutMs: 180_000,
				routes: {
					projects: [project],
					owner,
					runner: {
						run: () => ({ content: "unused", model: LOW_MODEL_ID }),
						stop: async () => {
							events.push("runner-start");
							await runnerReady;
							events.push("runner-end");
						},
					},
				},
			});
			const stopping = handle.stop();
			const concurrentStopping = handle.stop();
			expect(concurrentStopping).toBe(stopping);
			await Promise.resolve();
			await Promise.resolve();
			expect(events).toEqual(["server-start", "runner-start"]);
			expect(events).not.toContain("lock");
			releaseRunner();
			releaseServer();
			await Promise.all([stopping, concurrentStopping]);
			expect(events).toEqual(["server-start", "runner-start", "runner-end", "server-end", "lock"]);
		} finally {
			release.mockRestore();
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});
	test("runs optional shutdown cleanup before releasing the lock and skips it when absent", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const events: string[] = [];
		let cleanupCalls = 0;
		const serve = spyOn(Bun, "serve").mockImplementation(
			() =>
				({
					url: new URL("http://adapter.test/"),
					stop: async () => {
						events.push("server");
					},
				}) as never,
		);
		const lock = await RuntimeSingletonLock.acquire(runtimeRoot);
		const originalRelease = lock.release.bind(lock);
		const release = spyOn(lock, "release").mockImplementation(async () => {
			events.push("lock");
			await originalRelease();
		});
		try {
			const handle = await startAdapterServer({
				host: "127.0.0.1",
				port: 0,
				runtimeRoot,
				runtimeLock: lock,
				turnTimeoutMs: 180_000,
				routes: {
					projects: [project],
					owner,
					runner: {
						run: () => ({ content: "unused", model: LOW_MODEL_ID }),
						stop: () => {
							events.push("runner");
						},
					},
				},
				shutdownCleanup: () => {
					cleanupCalls += 1;
					events.push("cleanup");
				},
			});
			await handle.stop();

			expect(events).toEqual(["server", "runner", "cleanup", "lock"]);
			expect(cleanupCalls).toBe(1);

			const nextHandle = await startAdapterServer({
				host: "127.0.0.1",
				port: 0,
				runtimeRoot,
				runtimeLock: await RuntimeSingletonLock.acquire(runtimeRoot),
				turnTimeoutMs: 180_000,
			});
			await nextHandle.stop();
			expect(cleanupCalls).toBe(1);
		} finally {
			release.mockRestore();
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});
	test("rounds configured turn timeouts up, with headroom, and disables idle timeout above Bun's limit", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const serve = spyOn(Bun, "serve");
		const timeouts = [240_000, 240_001, 255_000];

		try {
			for (const turnTimeoutMs of timeouts) {
				const handle = await startAdapterServer({
					host: "127.0.0.1",
					port: 0,
					runtimeRoot,
					runtimeLock: await RuntimeSingletonLock.acquire(runtimeRoot),
					turnTimeoutMs,
				});
				await handle.stop();
			}
			expect(serve.mock.calls.map(([options]) => options.idleTimeout)).toEqual([241, 242, 0]);
		} finally {
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});
	test("stops the route runner and releases the lock when Bun.serve initialization fails", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const failure = new Error("serve initialization failed");
		const serve = spyOn(Bun, "serve").mockImplementation(() => {
			throw failure;
		});
		let stopCalls = 0;
		try {
			await expect(
				startAdapterServer({
					host: "127.0.0.1",
					port: 0,
					runtimeRoot,
					runtimeLock: await RuntimeSingletonLock.acquire(runtimeRoot),
					turnTimeoutMs: 180_000,
					routes: {
						projects: [project],
						owner,
						runner: {
							run: () => ({ content: "unused", model: LOW_MODEL_ID }),
							stop: () => {
								stopCalls += 1;
							},
						},
					},
				}),
			).rejects.toThrow(failure);
			expect(stopCalls).toBe(1);
			const reacquired = await RuntimeSingletonLock.acquire(runtimeRoot);
			await reacquired.release();
		} finally {
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});

	test("aggregates startup and cleanup failures, including lock release", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const startupFailure = new Error("serve initialization failed");
		const runnerFailure = new Error("runner cleanup failed");
		const cleanupFailure = new Error("owned cleanup failed");
		const releaseFailure = new Error("lock release failed");
		const serve = spyOn(Bun, "serve").mockImplementation(() => {
			throw startupFailure;
		});
		const lock = await RuntimeSingletonLock.acquire(runtimeRoot);
		const release = spyOn(lock, "release").mockRejectedValue(releaseFailure);
		let stopCalls = 0;
		try {
			const failure = await startAdapterServer({
				host: "127.0.0.1",
				port: 0,
				runtimeRoot,
				runtimeLock: lock,
				turnTimeoutMs: 180_000,
				routes: {
					projects: [project],
					owner,
					runner: {
						run: () => ({ content: "unused", model: LOW_MODEL_ID }),
						stop: () => {
							stopCalls += 1;
							throw runnerFailure;
						},
					},
				},
				shutdownCleanup: () => {
					throw cleanupFailure;
				},
			}).then(
				() => undefined,
				error => error,
			);
			expect(failure).toBeInstanceOf(AggregateError);
			if (!(failure instanceof AggregateError)) throw new TypeError("expected aggregate startup cleanup failure");
			expect(failure.errors).toEqual([startupFailure, runnerFailure, cleanupFailure, releaseFailure]);
			expect(stopCalls).toBe(1);
		} finally {
			release.mockRestore();
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});
	test("rejects invalid turn timeout values before serving", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "openwebui-gjc-adapter-server-"));
		const serve = spyOn(Bun, "serve");

		try {
			for (const turnTimeoutMs of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
				await expect(
					startAdapterServer({
						host: "127.0.0.1",
						port: 0,
						runtimeRoot,
						runtimeLock: await RuntimeSingletonLock.acquire(runtimeRoot),
						turnTimeoutMs,
					}),
				).rejects.toThrow("turnTimeoutMs must be a positive finite integer");
			}
			expect(serve).not.toHaveBeenCalled();
		} finally {
			serve.mockRestore();
			await rm(runtimeRoot, { force: true, recursive: true });
		}
	});
});

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	allowedRoot: "/work",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const owner: OpenWebUIOwnerContext = { ownerUserId: "owner-1", singleOwnerLocalMode: false };

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content, model: LOW_MODEL_ID }) };
}

const modelReaderFactory = staticModelReaderFactory();
const codexModelReaderFactory = async () => ({
	async getAvailableModels() {
		return [
			{
				provider: "openai-codex",
				id: "gpt-5.6-luna",
				reasoning: true,
				thinking: { validLevels: ["off", "low"] },
			},
		];
	},
	async getActiveProviders() {
		return [{ provider: "openai-codex", connectionKind: "credential" }];
	},
	async getState() {
		return { model: { provider: "openai-codex", id: "gpt-5.6-luna" }, thinkingLevel: "low" };
	},
	stop() {},
});
