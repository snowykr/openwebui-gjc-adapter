import { describe, expect, test } from "bun:test";
import type { OpenWebUIOwnerContext } from "../src/openwebui/auth";
import type { RegisteredProject } from "../src/projects/registry";
import { createAdapterRequestHandler } from "../src/server";

describe("createAdapterRequestHandler streaming", () => {
	test("returns event-stream chat completions for streaming requests", async () => {
		const handler = createAdapterRequestHandler({
			routes: {
				projects: [project],
				owner,
				runner: { run: () => ({ chunks: ["a", "b"], model: "gjc/anthropic/claude-sonnet-4:low" }) },
			},
		});

		const response = await handler(
			chatRequest({ model: "gjc", stream: true, messages: [{ role: "user", content: "hello" }] }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toStartWith("text/event-stream");
		expect(await response.text()).toContain("data: [DONE]");
	});
});

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

function chatRequest(body: unknown): Request {
	return new Request("http://adapter.test/v1/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-OpenWebUI-Chat-Id": "chat-1",
			"X-OpenWebUI-Message-Id": "assistant-1",
			"X-OpenWebUI-User-Message-Id": "user-1",
			"X-OpenWebUI-User-Message-Parent-Id": "",
			"X-OpenWebUI-User-Id": "owner-1",
		},
		body: JSON.stringify(body),
	});
}
