import { describe, expect, test } from "bun:test";
import { INITIAL_BOOTSTRAP_STATE } from "../src/configure/bootstrap-state";
import { configureOpenWebUI } from "../src/configure/openwebui-setup";
import { MIN_OPENWEBUI_VERSION, OPENWEBUI_HEADER_DESCRIPTORS } from "../src/contracts";
import { parseOpenWebUIHeaders } from "../src/openwebui/headers";

describe("public configuration contracts", () => {
	test("declares v0.10 minimum and descriptor requiredness", () => {
		expect(MIN_OPENWEBUI_VERSION).toBe("0.10.0");
		expect(OPENWEBUI_HEADER_DESCRIPTORS).toEqual([
			{ name: "X-OpenWebUI-Chat-Id", field: "chatId", requiredFor: "normal-chat" },
			{ name: "X-OpenWebUI-Message-Id", field: "messageId", requiredFor: "normal-chat" },
			{ name: "X-OpenWebUI-User-Message-Id", field: "userMessageId", requiredFor: "normal-chat" },
			{ name: "X-OpenWebUI-User-Message-Parent-Id", field: "userMessageParentId", requiredFor: "normal-chat" },
			{ name: "X-OpenWebUI-Task", field: "task", requiredFor: "background-task" },
			{ name: "X-OpenWebUI-User-Id", field: "userId", requiredFor: "optional" },
		]);
	});

	test("parses normal and background header semantics", () => {
		const normal = parseOpenWebUIHeaders({
			"x-openwebui-chat-id": "chat",
			"X-OpenWebUI-Message-Id": "message",
			"X-OpenWebUI-User-Message-Id": "user-message",
			"X-OpenWebUI-User-Message-Parent-Id": "",
		});
		expect(normal.ok).toBe(true);
		expect(normal.userMessageParentId).toBeNull();
		const task = parseOpenWebUIHeaders({ "X-OpenWebUI-Task": "title" });
		expect(task.ok).toBe(true);
		expect(task.isBackgroundTask).toBe(true);
	});

	test("refuses a managed provider configuration that is not exclusively owned", async () => {
		const http = {
			request: async <T>(method: string, path: string) => {
				if (path === "/api/version") return { version: "0.10.2" } as T;
				if (path === "/api/v1/auths/signup") return { token: "session" } as T;
				if (path === "/api/v1/auths/api_key") return { api_key: "openwebui-key" } as T;
				if (path === "/api/v1/auths/") return { id: "owner" } as T;
				if (method === "GET" && path === "/openai/config")
					return {
						ENABLE_OPENAI_API: true,
						OPENAI_API_BASE_URLS: ["https://foreign.test/v1"],
						OPENAI_API_KEYS: ["foreign"],
						OPENAI_API_CONFIGS: { "0": { prefix_id: "foreign" } },
					} as T;
				return undefined as T;
			},
		};
		await expect(
			configureOpenWebUI({
				http,
				state: { read: async () => INITIAL_BOOTSTRAP_STATE, write: async () => {} },
				maintenance: { begin: async () => {}, end: async () => {} },
				adapterUrl: "http://adapter:8765/v1",
				adapterToken: "adapter-token",
				adminEmail: "a@example.test",
				adminPassword: "password",
				installationId: "installation-1",
			}),
		).rejects.toThrow("foreign");
	});

	test("rejects OpenWebUI below v0.10 while still ending maintenance", async () => {
		let ended = false;
		const http = { request: async <T>() => ({ version: "0.9.9" }) as T };
		await expect(
			configureOpenWebUI({
				http,
				state: { read: async () => INITIAL_BOOTSTRAP_STATE, write: async () => {} },
				maintenance: {
					begin: async () => {},
					end: async () => {
						ended = true;
					},
				},
				adapterUrl: "http://adapter:8765/v1",
				adapterToken: "token",
				adminEmail: "a",
				adminPassword: "b",
				installationId: "installation-1",
			}),
		).rejects.toThrow("below required v0.10.0");
		expect(ended).toBe(true);
	});
});
