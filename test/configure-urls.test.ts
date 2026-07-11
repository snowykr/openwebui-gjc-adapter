import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { openSecretFile } from "../src/configure/credentials";
import {
	acquireConfigLock,
	canonicalizeUrl,
	type InstalledConfig,
	readInstalledConfig,
	writeInstalledConfig,
} from "../src/configure/private-config";

function setup(): { directory: string; config: string; cleanup: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "gjc-configure-urls-"));
	return {
		directory,
		config: join(directory, "nested", "config.json"),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}
function fd(directory: string, name: string, value: string): number {
	const path = join(directory, name);
	writeFileSync(path, `${value}\n`);
	return openSecretFile(path);
}
function successfulExistingDependencies() {
	const tty = { isTTY: true, write: (_value: string) => true };
	return {
		stdin: tty as unknown as NodeJS.ReadStream,
		stdout: tty,
		confirmAdapterToken: () => true,
		deployment: {
			managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
			existing: async (_input: unknown) => ({ completed: true as const, mode: "existing" as const }),
			reset: async (_input: {
				priorMode: "managed" | "existing";
				targetMode: "managed" | "existing";
				proof: string;
			}) => ({ completed: true as const, mode: "reset" as const }),
		},
	};
}

describe("configure URL and persistence contracts", () => {
	test("canonicalizes ingress and appends exactly one /v1", async () => {
		const t = setup();
		try {
			expect(canonicalizeUrl("HTTPS://Gateway.TEST:443/base///")).toBe("https://gateway.test/base");
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					`--openwebui-api-token-fd=${fd(t.directory, "token-1", "api-token")}`,
					"--adapter-ingress-url=https://Gateway.TEST/base/v1/",
					"--openwebui-url=https://openwebui.test",
				],
				successfulExistingDependencies(),
			);
			expect(result).toBe(0);
			expect(readInstalledConfig(t.config).adapterProviderUrl).toBe("https://gateway.test/base/v1");
		} finally {
			t.cleanup();
		}
	});

	test("keeps the adapter token stable when the existing route is rerun", async () => {
		const t = setup();
		try {
			let tokenFile = 0;
			const args = () =>
				[
					"configure",
					"existing",
					"--config",
					t.config,
					`--openwebui-api-token-fd=${fd(t.directory, `token-${tokenFile++}`, "api-token")}`,
					"--adapter-ingress-url=http://gateway.test/v1",
					"--openwebui-url=http://openwebui.test",
				] as string[];
			expect(await runCli(args(), successfulExistingDependencies())).toBe(0);
			const first = readInstalledConfig(t.config);
			expect(await runCli(args(), successfulExistingDependencies())).toBe(0);
			expect(readInstalledConfig(t.config).adapterToken).toBe(first.adapterToken);
		} finally {
			t.cleanup();
		}
	});

	test("persists config and lock with restrictive permissions", () => {
		const t = setup();
		try {
			const config: InstalledConfig = {
				version: 1,
				mode: "existing",
				installationId: "install",
				adapterToken: "adapter",
				readinessToken: "ready",
				openWebUIApiToken: "api-token",
				openWebUIApiUrl: "http://localhost:8080",
				adapterProviderUrl: "http://gateway.test/v1",
				bindHost: "127.0.0.1",
				bindPort: 8765,
			};
			writeInstalledConfig(config, t.config);
			expect(statSync(t.config).mode & 0o777).toBe(0o600);
			expect(statSync(join(t.directory, "nested")).mode & 0o777).toBe(0o700);
			const release = acquireConfigLock(t.config);
			try {
				expect(statSync(`${t.config}.lock`).mode & 0o777).toBe(0o600);
				expect(() => acquireConfigLock(t.config)).toThrow("already being modified");
			} finally {
				release();
			}
			expect(() => statSync(`${t.config}.lock`)).toThrow();
		} finally {
			t.cleanup();
		}
	});
});
