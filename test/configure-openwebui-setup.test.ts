import { describe, expect, test } from "bun:test";
import type { BootstrapState } from "../src/configure/bootstrap-state";
import { INITIAL_BOOTSTRAP_STATE } from "../src/configure/bootstrap-state";
import { configureOpenWebUI } from "../src/configure/openwebui-setup";

type Call = [string, string, unknown?, string?];
function setup(
	mode: "managed" | "existing" = "managed",
	initialConfig: unknown = {
		ENABLE_OPENAI_API: true,
		OPENAI_API_BASE_URLS: ["https://api.openai.com/v1"],
		OPENAI_API_KEYS: [""],
		OPENAI_API_CONFIGS: {},
	},
) {
	const calls: Call[] = [];
	let config = initialConfig;
	const http = {
		request: async <T>(method: string, path: string, body?: unknown, authorization?: string) => {
			calls.push([method, path, body, authorization]);
			if (path === "/api/version") return { version: "0.10.0" } as T;
			if (path === "/api/v1/auths/signup") return { token: "session" } as T;
			if (path === "/api/v1/auths/api_key") return { api_key: "key" } as T;
			if (path === "/api/v1/auths/") return { id: "owner", role: "admin" } as T;
			if (path === "/openai/config" && method === "GET") return config as T;
			if (path === "/openai/config/update" && method === "POST") {
				config = body;
				return undefined as T;
			}
			return undefined as T;
		},
	};
	return {
		calls,
		input: {
			http,
			state: {
				read: async () => INITIAL_BOOTSTRAP_STATE,
				write: async (_next: Partial<Omit<BootstrapState, "phase" | "version">>) => {},
			},
			maintenance: { begin: async () => {}, end: async () => {} },
			adapterUrl: "http://adapter:8765/v1",
			adapterToken: "adapter-token",
			adminEmail: "a@example.test",
			adminPassword: "password",
			installationId: "install-1",
			openWebUIApiToken: mode === "existing" ? "supplied" : undefined,
			mode,
		},
	};
}

describe("OpenWebUI v0.10 setup contract", () => {
	test("uses session authentication only for key creation, then verifies the durable key and provider readback", async () => {
		const t = setup();
		const result = await configureOpenWebUI(t.input);
		expect(result.apiKey).toBe("key");
		expect(t.calls.find(call => call[1] === "/api/v1/auths/signup")?.[2]).toMatchObject({ profile_image_url: "" });
		expect(t.calls.find(call => call[1] === "/api/v1/auths/api_key")?.[3]).toBe("session");
		expect(t.calls.filter(call => call[1] === "/api/v1/auths/")).toEqual([
			["GET", "/api/v1/auths/", undefined, "key"],
		]);
		expect(t.calls.filter(call => call[1] === "/openai/config").every(call => call[3] === "key")).toBe(true);
		expect(t.calls.find(call => call[1] === "/openai/config/update")?.[2]).toMatchObject({
			ENABLE_OPENAI_API: true,
			OPENAI_API_BASE_URLS: ["http://adapter:8765/v1"],
			OPENAI_API_KEYS: ["adapter-token"],
			OPENAI_API_CONFIGS: {
				"0": {
					enable: true,
					model_ids: ["gjc"],
					headers: {
						"X-OpenWebUI-Chat-Id": "{{CHAT_ID}}",
						"X-OpenWebUI-Message-Id": "{{MESSAGE_ID}}",
						"X-OpenWebUI-User-Message-Id": "{{USER_MESSAGE_ID}}",
						"X-OpenWebUI-User-Message-Parent-Id": "{{USER_MESSAGE_PARENT_ID}}",
						"X-OpenWebUI-Task": "{{TASK}}",
						"X-OpenWebUI-User-Id": "{{USER_ID}}",
					},
					openwebui_gjc_adapter: { schema: 1, installationId: "install-1" },
				},
			},
		});
		expect(JSON.stringify(t.calls.find(call => call[1] === "/openai/config/update")?.[2])).not.toContain("prefix_id");
	});
	test("persists bootstrap completion across the managed api-key and provider invocations", async () => {
		const t = setup();
		let persisted = INITIAL_BOOTSTRAP_STATE;
		t.input.state = {
			read: async () => persisted,
			write: async next => {
				persisted = { ...persisted, ...next };
			},
		};
		const first = await configureOpenWebUI({ ...t.input, stopAfter: "api-key" });
		const second = await configureOpenWebUI(t.input);
		expect(first.state).toMatchObject({
			bootstrapComplete: true,
			apiKeyCreated: true,
			ownerUserId: "owner",
			openWebUIApiToken: "key",
		});
		expect(second.openAIConnections).toHaveLength(1);
		expect(t.calls.filter(call => call[1] === "/api/v1/auths/signup")).toHaveLength(1);
		expect(t.calls.filter(call => call[1] === "/api/v1/auths/api_key")).toHaveLength(1);
		expect(t.calls.filter(call => call[1] === "/openai/config/update")).toHaveLength(1);
		expect(persisted).toMatchObject({
			bootstrapComplete: true,
			apiKeyCreated: true,
			ownerUserId: "owner",
			openWebUIApiToken: "key",
			openAIConfigured: true,
		});
		expect(JSON.stringify(persisted)).not.toContain("password");
	});
	test("existing mode only validates supplied owner token", async () => {
		const t = setup("existing");
		const result = await configureOpenWebUI(t.input);
		expect(result.apiKey).toBe("supplied");
		expect(t.calls).toEqual([
			["GET", "/api/version", undefined, undefined],
			["GET", "/api/v1/auths/", undefined, "supplied"],
		]);
	});
	test("rejects existing mode against an unsupported OpenWebUI version before token validation", async () => {
		const t = setup("existing");
		const original = t.input.http.request;
		t.input.http.request = async <T>(method: string, path: string, body?: unknown, authorization?: string) => {
			if (path === "/api/version") {
				t.calls.push([method, path, body, authorization]);
				return { version: "0.9.9" } as T;
			}
			return original(method, path, body, authorization);
		};
		await expect(configureOpenWebUI(t.input)).rejects.toThrow("below required v0.10.0");
		expect(t.calls).toEqual([["GET", "/api/version", undefined, undefined]]);
	});
	test("rejects a foreign nonempty provider list", async () => {
		const t = setup("managed", {
			ENABLE_OPENAI_API: true,
			OPENAI_API_BASE_URLS: ["https://foreign/v1"],
			OPENAI_API_KEYS: ["x"],
			OPENAI_API_CONFIGS: { "0": { prefix_id: "other" } },
		});
		await expect(configureOpenWebUI(t.input)).rejects.toThrow("foreign");
	});
	test("rejects signup without a session token", async () => {
		const t = setup();
		t.calls.length = 0;
		const original = t.input.http.request;
		t.input.http.request = async <T>(method: string, path: string, body?: unknown, authorization?: string) => {
			if (path === "/api/v1/auths/signup") return {} as T;
			return original(method, path, body, authorization);
		};
		await expect(configureOpenWebUI(t.input)).rejects.toThrow("session token");
	});
	test("recovers an interrupted signup before API-key persistence without re-signing up", async () => {
		const t = setup();
		let persisted = INITIAL_BOOTSTRAP_STATE;
		t.input.state = {
			read: async () => persisted,
			write: async next => {
				persisted = { ...persisted, ...next };
			},
		};
		const original = t.input.http.request;
		let signupCalls = 0;
		let apiKeyCalls = 0;
		const apiKeyAuthorizations: string[] = [];
		t.input.http.request = async <_T>(method: string, path: string, body?: unknown, authorization?: string) => {
			if (path === "/api/v1/auths/signup") signupCalls++;
			if (path === "/api/v1/auths/api_key") {
				apiKeyAuthorizations.push(authorization ?? "");
				if (apiKeyCalls++ === 0) throw new Error("simulated interruption");
			}
			return original(method, path, body, authorization);
		};
		await expect(configureOpenWebUI(t.input)).rejects.toThrow("simulated interruption");
		expect(signupCalls).toBe(1);
		expect(persisted).toMatchObject({ phase: "bootstrap", bootstrapComplete: false, openWebUIApiToken: "session" });
		expect(JSON.stringify(persisted)).not.toContain("password");

		const result = await configureOpenWebUI(t.input);
		expect(result.apiKey).toBe("key");
		expect(signupCalls).toBe(1);
		expect(apiKeyAuthorizations).toEqual(["session", "session"]);
	});
	test("recovers a signup that completed before its session checkpoint was persisted", async () => {
		const t = setup();
		let persisted = INITIAL_BOOTSTRAP_STATE;
		let checkpointAttempts = 0;
		t.input.state = {
			read: async () => persisted,
			write: async next => {
				if (checkpointAttempts++ === 0) throw new Error("simulated process termination before checkpoint");
				persisted = { ...persisted, ...next };
			},
		};
		const original = t.input.http.request;
		let signupCalls = 0;
		const apiKeyAuthorizations: string[] = [];
		t.input.http.request = async <_T>(method: string, path: string, body?: unknown, authorization?: string) => {
			if (path === "/api/v1/auths/signup") {
				signupCalls++;
				if (signupCalls === 2) throw new Error("administrator account already exists");
			}
			if (path === "/api/v1/auths/signin") {
				t.calls.push([method, path, body, authorization]);
				return { token: "recovered-session" } as _T;
			}
			if (path === "/api/v1/auths/api_key") apiKeyAuthorizations.push(authorization ?? "");
			return original(method, path, body, authorization);
		};

		await expect(configureOpenWebUI(t.input)).rejects.toThrow("simulated process termination before checkpoint");
		expect(persisted.openWebUIApiToken).toBeUndefined();

		const result = await configureOpenWebUI(t.input);
		expect(result.apiKey).toBe("key");
		expect(signupCalls).toBe(2);
		expect(t.calls.filter(call => call[1] === "/api/v1/auths/signin")).toHaveLength(1);
		expect(apiKeyAuthorizations).toEqual(["recovered-session"]);
		expect(persisted.openWebUIApiToken).toBe("key");
		expect(JSON.stringify(persisted)).not.toContain("password");
	});
	test("recovers controller bootstrap completion with no API key by signing up once", async () => {
		const t = setup();
		let persisted: BootstrapState = { ...INITIAL_BOOTSTRAP_STATE, phase: "bootstrap", bootstrapComplete: true };
		t.input.state = {
			read: async () => persisted,
			write: async next => {
				persisted = { ...persisted, ...next };
			},
		};
		const result = await configureOpenWebUI({ ...t.input, stopAfter: "api-key" });
		expect(result.apiKey).toBe("key");
		expect(t.calls.filter(call => call[1] === "/api/v1/auths/signup")).toHaveLength(1);
		expect(t.calls.filter(call => call[1] === "/api/v1/auths/api_key")).toHaveLength(1);
		expect(t.calls.find(call => call[1] === "/api/v1/auths/api_key")?.[3]).toBe("session");
		expect(persisted).toMatchObject({
			phase: "api-key",
			bootstrapComplete: true,
			apiKeyCreated: true,
			openWebUIApiToken: "key",
		});
	});
});
test("refuses non-admin existing token before lifecycle mutation", async () => {
	const t = setup("existing");
	let begins = 0;
	t.input.maintenance.begin = async () => {
		begins++;
	};
	const original = t.input.http.request;
	t.input.http.request = async <T>(method: string, path: string, body?: unknown, authorization?: string) => {
		if (path === "/api/v1/auths/") return { id: "owner", role: "user" } as T;
		return original(method, path, body, authorization);
	};
	await expect(configureOpenWebUI(t.input)).rejects.toThrow("administrator");
	expect(begins).toBe(0);
});
