import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		expect(config.openWebUIBaseUrl).toBe("http://localhost:8080");
		expect(config.openWebUIApiToken).toBeUndefined();
		expect(config.statePath).toBe(".gjc/openwebui-adapter");
		expect(config.gjcCommand).toBe("gjc");
		expect(config.sessionRoot).toBe(process.cwd());
		expect(config.allowedProjectRoots).toEqual([process.cwd()]);
	});

	test("parses configured env values and colon-separated roots", () => {
		const config = loadAdapterConfig({
			GJC_OPENWEBUI_BIND_HOST: "0.0.0.0",
			GJC_OPENWEBUI_BIND_PORT: "4321",
			GJC_OPENWEBUI_BASE_URL: "https://openwebui.example.test",
			GJC_OPENWEBUI_API_TOKEN: "token",
			GJC_OPENWEBUI_ADMIN_EMAIL: "admin@example.test",
			GJC_OPENWEBUI_ADMIN_PASSWORD: "secret",
			GJC_OPENWEBUI_OWNER_USER_ID: "owner-1",
			GJC_OPENWEBUI_STATE_PATH: "/tmp/state",
			GJC_OPENWEBUI_GJC_COMMAND: "/usr/local/bin/gjc",
			GJC_OPENWEBUI_SESSION_ROOT: "/tmp/sessions",
			GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: "/repo/a:/repo/b:",
			GJC_OPENWEBUI_ARTIFACT_BASE_URL: "https://artifacts.example.test/base",
		});
		expect(config).toEqual({
			bindHost: "0.0.0.0",
			bindPort: 4321,
			openWebUIBaseUrl: "https://openwebui.example.test",
			openWebUIApiToken: "token",
			openWebUIAdminEmail: "admin@example.test",
			openWebUIAdminPassword: "secret",
			ownerUserId: "owner-1",
			statePath: "/tmp/state",
			gjcCommand: "/usr/local/bin/gjc",
			sessionRoot: "/tmp/sessions",
			allowedProjectRoots: ["/repo/a", "/repo/b"],
			artifactBaseUrl: "https://artifacts.example.test/base",
		});
	});

	test("rejects invalid ports", () => {
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_BIND_PORT: "0" })).toThrow();
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_BIND_PORT: "65536" })).toThrow();
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_BIND_PORT: "12.5" })).toThrow();
	});

	test("builds startup diagnostics without throwing for missing auth", () => {
		const diagnostic = buildStartupDiagnostics(loadAdapterConfig({}));
		expect(diagnostic.status).toBe("degraded");
		expect(diagnostic.missingAuth).toBe(true);
		expect(diagnostic.missingAllowedProjectRoots).toBe(false);
		expect(diagnostic.expectedHeaderNames).toEqual([...REQUIRED_OPENWEBUI_HEADER_NAMES]);
		expect(diagnostic.messages).toContain(
			"GJC_OPENWEBUI_API_TOKEN is not set; OpenWebUI API calls are not authenticated.",
		);
	});
	test("uses container runtime paths only for managed installed configurations", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-installed-config-"));
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
			expect(loadInstalledAdapterConfig(file)).toMatchObject({
				statePath: "/var/lib/gjc",
				sessionRoot: "/run/gjc-session",
				allowedProjectRoots: ["/workspace"],
				gjcCommand: "/opt/openwebui-gjc-adapter/node_modules/.bin/gjc",
			});
			writeInstalledConfig({ ...base, mode: "existing", bindHost: "127.0.0.1" }, file);
			const existing = loadInstalledAdapterConfig(file);
			expect(existing.statePath).toBe(".gjc/openwebui-adapter");
			expect(existing.sessionRoot).toBe(join(DEFAULT_EXISTING_PROJECT_ROOT, ".gjc", "sessions"));
			expect(existing.allowedProjectRoots).toEqual([DEFAULT_EXISTING_PROJECT_ROOT]);
			expect(existing.gjcCommand).toBe("gjc");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
