import { describe, expect, it } from "bun:test";
import { handleChatCompletions, LiveGatewayUnavailableError } from "../src/live/chat-completions";
import type { OpenAIChatCompletionRequest } from "../src/live/openai-types";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	allowedRoot: "/work",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};

const owner: OpenWebUIOwnerContext = {
	ownerUserId: "owner-1",
	singleOwnerLocalMode: false,
};

const chatHeaders = {
	"X-OpenWebUI-Chat-Id": "chat-1",
	"X-OpenWebUI-Message-Id": "assistant-1",
	"X-OpenWebUI-User-Message-Id": "user-1",
	"X-OpenWebUI-User-Message-Parent-Id": "parent-1",
	"X-OpenWebUI-User-Id": "owner-1",
};

const request: OpenAIChatCompletionRequest = {
	model: "gjc",
	messages: [{ role: "user", content: "Build it" }],
};

describe("live OpenAI-compatible chat completion errors", () => {
	it("encodes streaming chunks and final DONE sentinel", async () => {
		const result = await handleChatCompletions({
			request: { ...request, stream: true },
			headers: chatHeaders,
			projects: [project],
			owner,
			runner: {
				run: () => ({ chunks: ["hello", " world"], model: "gjc/anthropic/claude-sonnet-4:low" }),
			},
			now: new Date("2026-07-08T00:00:00.000Z"),
			idFactory: () => "chatcmpl-stream",
		});

		expect(result.ok).toBe(true);
		if (!("stream" in result)) throw new Error("expected stream result");
		const chunks: string[] = [];
		for await (const chunk of result.stream) chunks.push(chunk);

		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toStartWith("data: ");
		expect(chunks[0]).toEndWith("\n\n");
		expect(JSON.parse(chunks[0]?.slice(6).trim() ?? "{}")).toMatchObject({
			object: "chat.completion.chunk",
			model: "gjc/anthropic/claude-sonnet-4:low",
			choices: [{ delta: { role: "assistant", content: "hello" }, finish_reason: null }],
		});
		expect(chunks[2]).toBe("data: [DONE]\n\n");
	});

	it("fails closed before sinks when the runner omits canonical model metadata", async () => {
		const effects: string[] = [];
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [project],
			owner,
			runner: { run: () => ({ content: "must not escape" }) },
			eventSink: () => {
				effects.push("event");
			},
			messageSink: () => {
				effects.push("message");
			},
		});
		expect(result).toMatchObject({
			ok: false,
			status: 503,
			body: { error: { code: "live_runner_error", type: "server_error" } },
		});
		expect(effects).toEqual([]);
	});

	it.each(["gjc", "gjc/noncanonical"])("fails closed before sinks for runner model %s", async model => {
		const effects: string[] = [];
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [project],
			owner,
			runner: { run: () => ({ content: "must not escape", model }) },
			eventSink: () => {
				effects.push("event");
			},
			messageSink: () => {
				effects.push("message");
			},
		});
		expect(result).toMatchObject({
			ok: false,
			status: 503,
			body: { error: { code: "live_runner_error", type: "server_error" } },
		});
		expect(effects).toEqual([]);
	});

	it("returns OpenAI-style unavailable errors when no concrete live runner is wired", async () => {
		const result = await handleChatCompletions({
			request,
			headers: chatHeaders,
			projects: [project],
			owner,
			runner: {
				run() {
					throw new LiveGatewayUnavailableError("GJC live runner is not configured for this service.");
				},
			},
		});

		expect(result).toEqual({
			ok: false,
			status: 503,
			body: {
				error: {
					message: "GJC live runner is not configured for this service.",
					type: "server_error",
					code: "live_runner_unavailable",
				},
			},
		});
	});
});
