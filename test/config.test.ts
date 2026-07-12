import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAdapterConfig } from "../src/adapter-server-options";
import { buildStartupDiagnostics, loadAdapterConfig, loadInstalledAdapterConfig } from "../src/config";
import {
	DEFAULT_EXISTING_PROJECT_ROOT,
	type InstalledConfig,
	writeInstalledConfig,
} from "../src/configure/private-config";
import {
	MIN_OPENWEBUI_VERSION,
	REQUIRED_OPENWEBUI_HEADER_NAMES,
	SUPPORTED_MESSAGE_EVENT_TYPES,
} from "../src/contracts";

describe("adapter config contracts", () => {
	test("exports phase 0 OpenWebUI contract constants", () => {
		expect(MIN_OPENWEBUI_VERSION).toBe("0.10.0");
		expect(REQUIRED_OPENWEBUI_HEADER_NAMES).toEqual([
			"X-OpenWebUI-Chat-Id",
			"X-OpenWebUI-Message-Id",
			"X-OpenWebUI-User-Message-Id",
			"X-OpenWebUI-User-Message-Parent-Id",
			"X-OpenWebUI-Task",
		]);
		expect(SUPPORTED_MESSAGE_EVENT_TYPES).toEqual(["status", "files", "source", "citation"]);
	});

	test("loads safe defaults without requiring an API token", () => {
		const config = loadAdapterConfig({});
		expect(config.bindHost).toBe("127.0.0.1");
		expect(config.bindPort).toBe(8765);
		expect(config.adapterApiToken).toBeUndefined();
		expect(config.openWebUIBaseUrl).toBe("http://localhost:8080");
		expect(config.openWebUIApiToken).toBeUndefined();
		expect(config.statePath).toBe(".gjc/openwebui-adapter");
		expect(config.gjcCommand).toBe("gjc");
		expect(config.turnTimeoutMs).toBe(180_000);
		expect(config.sessionRoot).toBe(process.cwd());
		expect(config.allowedProjectRoots).toEqual([process.cwd()]);
		expect(config.projects).toEqual([]);
	});

	test("retains resolved runtime fields as frozen enumerable configuration", () => {
		const config = loadAdapterConfig({});
		const spread = { ...config };
		const json = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(config, "gjcConfigDirName")).toMatchObject({
			enumerable: true,
			writable: false,
		});
		expect(Object.getOwnPropertyDescriptor(config, "gjcCodingAgentDir")).toMatchObject({
			enumerable: true,
			writable: false,
		});
		expect(Object.getOwnPropertyDescriptor(config, "runtimeLocations")).toMatchObject({
			enumerable: true,
			writable: false,
		});
		expect(spread.runtimeLocations).toBe(config.runtimeLocations);
		expect(resolveAdapterConfig(config)).toBe(config);
		expect(spread.gjcConfigDirName).toBe(config.gjcConfigDirName);
		expect(spread.gjcCodingAgentDir).toBe(config.gjcCodingAgentDir);
		expect(json.gjcConfigDirName).toBe(config.gjcConfigDirName);
		expect(json.gjcCodingAgentDir).toBe(config.gjcCodingAgentDir);
		expect(json.runtimeLocations).toEqual(config.runtimeLocations);
	});

	test("parses configured env values and colon-separated roots", () => {
		const config = loadAdapterConfig({
			GJC_OPENWEBUI_BIND_HOST: "0.0.0.0",
			GJC_OPENWEBUI_BIND_PORT: "4321",
			GJC_OPENWEBUI_ADAPTER_API_TOKEN: "adapter-token",
			GJC_OPENWEBUI_BASE_URL: "https://openwebui.example.test",
			GJC_OPENWEBUI_API_TOKEN: "token",
			GJC_OPENWEBUI_ADMIN_EMAIL: "admin@example.test",
			GJC_OPENWEBUI_ADMIN_PASSWORD: "secret",
			GJC_OPENWEBUI_OWNER_USER_ID: "owner-1",
			GJC_OPENWEBUI_STATE_PATH: "/tmp/state",
			GJC_OPENWEBUI_GJC_COMMAND: "/usr/local/bin/gjc",
			GJC_OPENWEBUI_TURN_TIMEOUT_MS: "240000",
			GJC_OPENWEBUI_SESSION_ROOT: "/tmp/sessions",
			GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: "/repo/a:/repo/b:",
			GJC_OPENWEBUI_ARTIFACT_BASE_URL: "https://artifacts.example.test/base",
			GJC_OPENWEBUI_PROJECTS: "/repo/a|Project A|folder-a|/sessions/a;/repo/b|Project B",
		});
		expect(config).toEqual({
			bindHost: "0.0.0.0",
			bindPort: 4321,
			adapterApiToken: "adapter-token",
			openWebUIBaseUrl: "https://openwebui.example.test",
			openWebUIApiToken: "token",
			openWebUIAdminEmail: "admin@example.test",
			openWebUIAdminPassword: "secret",
			ownerUserId: "owner-1",
			statePath: "/tmp/state",
			gjcCommand: "/usr/local/bin/gjc",
			gjcConfigDirName: ".gjc",
			gjcCodingAgentDir: config.runtimeLocations.agentDir,
			runtimeLocations: config.runtimeLocations,
			turnTimeoutMs: 240_000,
			sessionRoot: "/tmp/sessions",
			allowedProjectRoots: ["/repo/a", "/repo/b"],
			artifactBaseUrl: "https://artifacts.example.test/base",
			projects: [
				{ cwd: "/repo/a", name: "Project A", openWebUIFolderId: "folder-a", sessionRoot: "/sessions/a" },
				{ cwd: "/repo/b", name: "Project B" },
			],
		});
	});

	test("rejects malformed configured project entries", () => {
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_PROJECTS: "|" })).toThrow(
			"GJC_OPENWEBUI_PROJECTS entry 1 must include a non-empty cwd",
		);
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_PROJECTS: "/repo|Name|folder|session|extra" })).toThrow(
			"GJC_OPENWEBUI_PROJECTS entry 1 has too many fields",
		);
	});

	test("rejects invalid ports", () => {
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_BIND_PORT: "0" })).toThrow();
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_BIND_PORT: "65536" })).toThrow();
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_BIND_PORT: "12.5" })).toThrow();
	});

	test("rejects invalid GJC turn timeouts", () => {
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_TURN_TIMEOUT_MS: "0" })).toThrow(
			"GJC_OPENWEBUI_TURN_TIMEOUT_MS must be a positive integer",
		);
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_TURN_TIMEOUT_MS: "12.5" })).toThrow(
			"GJC_OPENWEBUI_TURN_TIMEOUT_MS must be a positive integer",
		);
	});

	test("builds startup diagnostics without throwing for missing auth", () => {
		const diagnostic = buildStartupDiagnostics(loadAdapterConfig({}));
		expect(diagnostic.status).toBe("degraded");
		expect(diagnostic.missingAuth).toBe(true);
		expect(diagnostic.missingAdapterApiToken).toBe(true);
		expect(diagnostic.missingAllowedProjectRoots).toBe(false);
		expect(diagnostic.expectedHeaderNames).toEqual([...REQUIRED_OPENWEBUI_HEADER_NAMES]);
		expect(diagnostic.messages).toContain(
			"GJC_OPENWEBUI_API_TOKEN is not set; OpenWebUI API calls are not authenticated.",
		);
		expect(diagnostic.messages).toContain(
			"GJC_OPENWEBUI_ADAPTER_API_TOKEN is not set; inbound OpenAI-compatible calls are not authenticated.",
		);
	});
	test("keeps the managed installed session root within allowed roots", () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "gjc-installed-config-")));
		const file = join(directory, "config.json");
		const base: InstalledConfig = {
			version: 1,
			mode: "managed",
			installationId: "install",
			adapterToken: "adapter",
			readinessToken: "ready",
			openWebUIApiUrl: "http://localhost:8080",
			adapterProviderUrl: "http://adapter:8765/v1",
			bindHost: "0.0.0.0",
			bindPort: 8765,
		};
		try {
			writeInstalledConfig({ ...base, mode: "managed" }, file);
			const managed = loadInstalledAdapterConfig(file);
			expect(managed).toMatchObject({
				statePath: "/var/lib/gjc",
				sessionRoot: "/run/gjc-session",
				allowedProjectRoots: ["/workspace", "/run/gjc-session"],
				adapterApiToken: "adapter",
				gjcCommand: "gjc",
			});
			expect(Object.isFrozen(managed)).toBe(true);
			expect(Object.keys(managed)).toEqual(
				expect.arrayContaining(["gjcConfigDirName", "gjcCodingAgentDir", "runtimeLocations"]),
			);
			expect({ ...managed }.runtimeLocations).toBe(managed.runtimeLocations);
			writeInstalledConfig({ ...base, mode: "existing", bindHost: "127.0.0.1", ownerUserId: "owner-test" }, file);
			const existing = loadInstalledAdapterConfig(file);
			expect(existing.statePath).toBe(".gjc/openwebui-adapter");
			expect(existing.sessionRoot).toBe(join(DEFAULT_EXISTING_PROJECT_ROOT, ".gjc", "sessions"));
			expect(existing.allowedProjectRoots).toEqual([DEFAULT_EXISTING_PROJECT_ROOT]);
			expect(existing.gjcCommand).toBe("gjc");
			expect(existing.ownerUserId).toBe("owner-test");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
