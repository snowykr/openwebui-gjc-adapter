import { describe, expect, it } from "bun:test";
import {
	handleChatCompletions,
	type LiveGatewayRunner,
	LiveGatewayUnavailableError,
} from "../src/live/chat-completions";
import type { OpenAIChatCompletionRequest } from "../src/live/openai-types";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";

const project: RegisteredProject = {
	id: "demo",
	name: "Demo",
	cwd: "/work/demo",
	modelId: "gjc/demo",
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
			runner: { run: () => ({ chunks: ["hello", " world"] }) },
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
			choices: [{ delta: { role: "assistant", content: "hello" }, finish_reason: null }],
		});
		expect(chunks[2]).toBe("data: [DONE]\n\n");
	});

	it("rejects unknown project models", async () => {
		const result = await handleChatCompletions({
			request: { ...request, model: "gjc/missing" },
			headers: chatHeaders,
			projects: [project],
			owner,
			runner: fixedRunner("unused"),
		});

		expect(result).toEqual({
			ok: false,
			status: 404,
			body: {
				error: {
					message: "Unknown GJC model: gjc/missing",
					type: "invalid_request_error",
					code: "model_not_found",
				},
			},
		});
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

function fixedRunner(content: string): LiveGatewayRunner {
	return { run: () => ({ content }) };
}
