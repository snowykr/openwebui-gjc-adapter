import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstalledAdapterServerOptions, runCli } from "../src/cli";
import type { AdapterConfig } from "../src/config";
import { type BootstrapState, INITIAL_BOOTSTRAP_STATE, parseBootstrapState } from "../src/configure/bootstrap-state";
import { openSecretFile } from "../src/configure/credentials";
import { CliUsageError, parseCliArguments } from "../src/configure/grammar";
import { configureOpenWebUI } from "../src/configure/openwebui-setup";
import { runPhaseAwareDeployment } from "../src/configure/orchestrator";
import {
	DEFAULT_EXISTING_PROJECT_ROOT,
	defaultExistingProjectRoot,
	type InstalledConfig,
	readInstalledConfig,
	writeInstalledConfig,
} from "../src/configure/private-config";
import { renderExistingSystemdUnit } from "../src/configure/systemd";
import type { AdapterServerOptions } from "../src/server";

function tempPath(): { directory: string; config: string; cleanup: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "gjc-configure-cli-"));
	return {
		directory,
		config: join(directory, "config.json"),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}
function secretFd(directory: string, name: string, value: string): number {
	const path = join(directory, name);
	writeFileSync(path, `${value}\n`);
	return openSecretFile(path);
}
function sink(): { values: string[]; write: (value: string) => boolean } {
	const values: string[] = [];
	return {
		values,
		write(value: string) {
			values.push(value);
			return true;
		},
	};
}
function successfulManagedDependencies() {
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

describe("configure CLI grammar and acknowledgements", () => {
	test("resolves existing-mode roots under persistent XDG state/data storage", () => {
		expect(defaultExistingProjectRoot({ HOME: "/home/tester" })).toBe(
			"/home/tester/.local/state/openwebui-gjc-adapter/workspace",
		);
		expect(defaultExistingProjectRoot({ HOME: "/home/tester", XDG_DATA_HOME: "/data/tester" })).toBe(
			"/data/tester/openwebui-gjc-adapter/workspace",
		);
		expect(
			defaultExistingProjectRoot({
				HOME: "/home/tester",
				XDG_DATA_HOME: "/data/tester",
				XDG_STATE_HOME: "/state/tester",
			}),
		).toBe("/state/tester/openwebui-gjc-adapter/workspace");
	});
	test("enforces managed/existing route credential exclusivity", () => {
		expect(() => parseCliArguments(["configure", "managed", "--openwebui-api-token-fd=3"])).toThrow(
			"managed configuration does not accept existing-route credentials",
		);
		expect(() => parseCliArguments(["configure", "existing", "--admin-email-fd=3"])).toThrow(
			"existing configuration does not accept managed admin credentials",
		);
		expect(parseCliArguments(["configure", "managed", "--admin-email-fd", "3", "--admin-password-fd", "4"])).toEqual({
			kind: "configure",
			mode: "managed",
			options: { "admin-email-fd": "3", "admin-password-fd": "4" },
		});
		expect(() => parseCliArguments(["configure", "managed", "--admin-email-fd"])).toThrow(CliUsageError);
	});
	test("rejects managed OpenWebUI URL overrides because managed runtime uses its Compose peer", () => {
		expect(() => parseCliArguments(["configure", "managed", "--openwebui-url=https://other.example"])).toThrow(
			"managed configuration does not accept openwebui-url",
		);
	});
	test("rejects bind-host customization because ingress remains mode-controlled", async () => {
		const error = sink();
		expect(() => parseCliArguments(["configure", "existing", "--bind-host=0.0.0.0"])).toThrow(
			"--bind-host is not supported; the adapter bind host is selected by deployment mode",
		);
		expect(await runCli(["configure", "existing", "--bind-host=0.0.0.0"], { stderr: error })).toBe(2);
		expect(error.values).toEqual([
			"--bind-host is not supported; the adapter bind host is selected by deployment mode\n",
		]);
	});
	test("accepts the documented custom-config readiness probe", () => {
		expect(parseCliArguments(["probe-ready", "--config", "/tmp/custom-config.json"])).toEqual({
			kind: "probe-ready",
			options: { config: "/tmp/custom-config.json" },
		});
	});
	test("routes serve --config through the installed lifecycle and escapes each systemd argument", async () => {
		const t = tempPath();
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () =>
				new Response(JSON.stringify({ id: "gjc-project-default", name: "default", items: [] }), {
					status: 200,
				})) as unknown as typeof fetch;
			mkdirSync(join(t.directory, "workspace"));
			writeInstalledConfig(
				{
					version: 1,
					mode: "existing",
					installationId: "install",
					adapterToken: "adapter",
					readinessToken: "ready",
					openWebUIApiToken: "openwebui-api-token",
					openWebUIApiUrl: "http://localhost:8080",
					adapterProviderUrl: "http://adapter:8765/v1",
					bindHost: "127.0.0.1",
					bindPort: 8765,
					projectRoot: join(t.directory, "workspace"),
				},
				t.config,
			);
			const output = sink();
			let captured: AdapterServerOptions | undefined;
			const result = await runCli(["serve", "--config", t.config], {
				stdout: output,
				startConfiguredServer: options => {
					captured = options;
					return { url: "http://127.0.0.1:8765", stop: async () => {} };
				},
			});
			expect(result).toBe(0);
			expect(output.values).toEqual(["http://127.0.0.1:8765\n"]);
			expect(captured).toMatchObject({
				runtime: {
					adapterToken: "adapter",
					readinessToken: "ready",
					readiness: {
						openWebUIAuthenticated: false,
						promptHintsSeeded: false,
						mode: "existing",
						generation: "install",
					},
					openWebUIBaseUrl: "http://localhost:8080",
					openWebUIApiToken: "openwebui-api-token",
				},
				routes: {
					requireAdapterApiToken: true,
					adapterApiToken: "adapter",
				},
			});
			expect(captured?.routes?.projectContextRepository).toBeDefined();
			expect(captured?.routes?.eventSink).toBeDefined();
			expect(captured?.routes?.messageSink).toBeDefined();
			expect(captured?.routes?.fileContextResolver).toBeDefined();
			expect(
				renderExistingSystemdUnit({
					workingDirectory: "/srv/adapter files",
					adapterCommand: [
						"/usr/bin/bun",
						"/srv/adapter files/src/cli.ts",
						"serve",
						"--config",
						"/tmp/config file.json",
					],
				}),
			).toContain('ExecStart=/usr/bin/bun "/srv/adapter files/src/cli.ts" serve --config "/tmp/config file.json"');
			expect(
				renderExistingSystemdUnit({
					workingDirectory: "/srv/adapter",
					adapterCommand: ["adapter%name", "$HOME", "tab\tvalue", 'quote"value', "back\\slash", ""],
				}),
			).toContain('ExecStart="adapter%%name" "$$HOME" "tab\tvalue" "quote\\"value" "back\\\\slash" ""');
			for (const lineBreak of ["bad\0value", "bad\rvalue", "bad\nvalue"]) {
				expect(() =>
					renderExistingSystemdUnit({ workingDirectory: "/srv/adapter", adapterCommand: ["adapter", lineBreak] }),
				).toThrow("systemd unit values must not contain NUL, CR, or LF");
			}
		} finally {
			globalThis.fetch = originalFetch;
			t.cleanup();
		}
	});
	test("builds installed server options without contacting a temporarily unavailable OpenWebUI", async () => {
		const t = tempPath();
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = (async () => {
				throw new Error("OpenWebUI is still starting");
			}) as unknown as typeof fetch;
			const options = await buildInstalledAdapterServerOptions({
				bindHost: "127.0.0.1",
				bindPort: 8765,
				adapterApiToken: "adapter-token",
				adapterToken: "adapter-token",
				readinessToken: "readiness-token",
				mode: "existing",
				installationId: "installation-1",
				openWebUIBaseUrl: "http://openwebui.test",
				openWebUIApiToken: "openwebui-api-token",
				statePath: t.directory,
				gjcCommand: "gjc",
				turnTimeoutMs: 1_000,
				sessionRoot: t.directory,
				allowedProjectRoots: [t.directory],
				projects: [],
			} satisfies AdapterConfig);
			expect(options.runtime).toMatchObject({
				adapterToken: "adapter-token",
				readinessToken: "readiness-token",
				readiness: {
					openWebUIAuthenticated: false,
					promptHintsSeeded: false,
					mode: "existing",
					generation: "installation-1",
					reason: "OpenWebUI runtime initialization is pending",
				},
				openWebUIBaseUrl: "http://openwebui.test",
				openWebUIApiToken: "openwebui-api-token",
			});
			expect(options.runtime?.initialize).toBeFunction();
		} finally {
			globalThis.fetch = originalFetch;
			t.cleanup();
		}
	});
	test("generates the existing-mode systemd unit through production deployment", async () => {
		const t = tempPath();
		const originalEnvironment = {
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			XDG_STATE_HOME: process.env.XDG_STATE_HOME,
		};
		const originalFetch = globalThis.fetch;
		try {
			process.env.HOME = t.directory;
			process.env.XDG_CONFIG_HOME = join(t.directory, "xdg-config");
			process.env.XDG_STATE_HOME = join(t.directory, "xdg-state");
			globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://openwebui.test",
					"--adapter-ingress-url=http://adapter.test",
					"--project-root",
					join(t.directory, "workspace"),
					`--openwebui-api-token-fd=${secretFd(t.directory, "existing-api-token", "openwebui-api-token")}`,
				],
				{
					systemctl: args =>
						args[2] === "is-enabled" ? "disabled" : args[2] === "is-active" ? "inactive" : undefined,
					configureOpenWebUI: async () =>
						({
							state: INITIAL_BOOTSTRAP_STATE,
							apiKey: "openwebui-api-token",
							openAIConnections: [],
							ownerUserId: "owner",
						}) as never,
				},
			);

			expect(result).toBe(0);
			const unit = readFileSync(
				join(t.directory, "xdg-config", "systemd", "user", "openwebui-gjc-adapter-existing.service"),
				"utf8",
			);
			const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
			expect(unit).toContain(
				`ExecStart=${process.execPath} ${join(sourceRoot, "src", "cli.ts")} serve --config ${t.config}`,
			);
		} finally {
			globalThis.fetch = originalFetch;
			for (const [name, value] of Object.entries(originalEnvironment)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			t.cleanup();
		}
	});
	test("builds the managed adapter from the package root", async () => {
		const t = tempPath();
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		try {
			const result = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "build-email", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "build-password", "password")}`,
				],
				{
					managedDocker: {
						run: async (command, args) => {
							calls.push({ command, args });
							return { exitCode: 0, stdout: '[] "/var/lib/docker"', stderr: "" };
						},
					},
					systemctl: args =>
						args[2] === "is-enabled" ? "disabled" : args[2] === "is-active" ? "inactive" : undefined,
					probeManagedAdapter: () => {},
					configureOpenWebUI: async input =>
						({
							state:
								input.stopAfter === "api-key"
									? {
											...INITIAL_BOOTSTRAP_STATE,
											phase: "api-key",
											bootstrapComplete: true,
											apiKeyCreated: true,
											ownerUserId: "owner",
											openWebUIApiToken: "api-token",
										}
									: {
											...INITIAL_BOOTSTRAP_STATE,
											phase: "openai",
											bootstrapComplete: true,
											apiKeyCreated: true,
											openAIConfigured: true,
											openAIConnectionIds: ["0"],
											ownerUserId: "owner",
											openWebUIApiToken: "api-token",
										},
							apiKey: "api-token",
							openAIConnections: [],
							ownerUserId: "owner",
						}) as never,
				},
			);
			expect(result).toBe(0);
			const build = calls.find(call => call.command === "docker" && call.args[0] === "build");
			const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
			expect(build?.args).toEqual([
				"build",
				"--file",
				join(packageRoot, "Dockerfile.adapter"),
				"--tag",
				"openwebui-gjc-adapter:local",
				packageRoot,
			]);
		} finally {
			t.cleanup();
		}
	});
	test("writes the Docker executable resolved during managed installation into the systemd unit", async () => {
		const t = tempPath();
		const originalEnvironment = {
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			PATH: process.env.PATH,
		};
		try {
			const dockerDirectory = join(t.directory, "docker-bin");
			const dockerBinary = join(dockerDirectory, "docker");
			mkdirSync(dockerDirectory);
			writeFileSync(dockerBinary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			chmodSync(dockerBinary, 0o700);
			process.env.HOME = t.directory;
			process.env.XDG_CONFIG_HOME = join(t.directory, "xdg-config");
			process.env.PATH = dockerDirectory;

			const result = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "docker-email", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "docker-password", "password")}`,
				],
				{
					managedDocker: { run: async () => ({ exitCode: 0, stdout: '[] "/var/lib/docker"', stderr: "" }) },
					systemctl: args =>
						args[2] === "is-enabled" ? "disabled" : args[2] === "is-active" ? "inactive" : undefined,
					probeManagedAdapter: () => {},
					configureOpenWebUI: async () =>
						({
							state: {
								...INITIAL_BOOTSTRAP_STATE,
								phase: "openai",
								bootstrapComplete: true,
								apiKeyCreated: true,
								openAIConfigured: true,
								openAIConnectionIds: ["0"],
								ownerUserId: "owner",
								openWebUIApiToken: "api-token",
							},
							apiKey: "api-token",
							openAIConnections: [],
							ownerUserId: "owner",
						}) as never,
				},
			);

			expect(result).toBe(0);
			expect(
				readFileSync(join(t.directory, "xdg-config", "systemd", "user", "openwebui-gjc-adapter.service"), "utf8"),
			).toContain(`ExecStart=${dockerBinary} compose`);
		} finally {
			for (const [name, value] of Object.entries(originalEnvironment)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			t.cleanup();
		}
	});
	test("does not journal a fresh existing installation until its OpenWebUI target validates", async () => {
		const t = tempPath();
		const projectRoot = join(t.directory, "workspace");
		try {
			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://unreachable.test",
						"--adapter-ingress-url=http://gateway.test",
						"--project-root",
						projectRoot,
						`--openwebui-api-token-fd=${secretFd(t.directory, "invalid-existing-token", "api-token")}`,
					],
					{
						configureOpenWebUI: async () => {
							throw new Error("OpenWebUI target is unreachable");
						},
						systemctl: args =>
							args[2] === "is-enabled" ? "disabled" : args[2] === "is-active" ? "inactive" : "",
					},
				),
			).toBe(1);
			expect(existsSync(t.config)).toBe(false);
			expect(existsSync(`${t.config}.bootstrap.json`)).toBe(false);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
			expect(existsSync(projectRoot)).toBe(false);

			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://corrected.test",
						"--adapter-ingress-url=http://gateway.test",
						"--project-root",
						projectRoot,
						`--openwebui-api-token-fd=${secretFd(t.directory, "corrected-existing-token", "api-token")}`,
					],
					{
						deployment: {
							managed: async () => ({ completed: true as const, mode: "managed" as const }),
							existing: async () => ({ completed: true as const, mode: "existing" as const }),
							reset: async () => ({ completed: true as const, mode: "reset" as const }),
						},
					},
				),
			).toBe(0);
		} finally {
			t.cleanup();
		}
	});

	test("configures managed route and preserves token on same-mode rerun", async () => {
		const t = tempPath();
		try {
			const first = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "email-1", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "password-1", "password")}`,
				],
				successfulManagedDependencies(),
			);
			expect(first).toBe(0);
			const initial = readInstalledConfig(t.config);
			expect(initial.mode).toBe("managed");
			expect(initial.adapterProviderUrl).toBe("http://adapter:8765/v1");
			expect(initial.openWebUIApiToken).toBeUndefined();
			const second = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "email-2", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "password-2", "password-2")}`,
				],
				successfulManagedDependencies(),
			);
			expect(second).toBe(0);
			expect(readInstalledConfig(t.config).adapterToken).toBe(initial.adapterToken);
		} finally {
			t.cleanup();
		}
	});
	test("fails managed Docker preflight before writing Compose or systemd artifacts", async () => {
		const t = tempPath();
		const calls: string[][] = [];
		try {
			const result = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "preflight-email", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "preflight-password", "password")}`,
				],
				{
					managedDocker: {
						run: async (command: string, args: readonly string[]) => {
							calls.push([command, ...args]);
							return { exitCode: 0, stdout: '["rootless","userns-remap"] "/var/lib/docker"', stderr: "" };
						},
					},
				},
			);
			expect(result).toBe(1);
			expect(calls).toEqual([["docker", "info", "--format", "{{json .SecurityOptions}} {{json .DockerRootDir}}"]]);
			expect(existsSync(t.config)).toBe(false);
			expect(existsSync(`${t.config}.bootstrap.json`)).toBe(false);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
			expect(existsSync(join(t.directory, "adapter-token"))).toBe(false);
			expect(existsSync(`${t.config}.compose.yml`)).toBe(false);
			expect(existsSync(`${t.config}.service`)).toBe(false);
		} finally {
			t.cleanup();
		}
	});
	test("rejects an OpenWebUI URL change without reset authorization", async () => {
		const t = tempPath();
		try {
			const dependencies = successfulManagedDependencies();
			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://adapter.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, "api-url-1", "api-token")}`,
					],
					dependencies,
				),
			).toBe(0);
			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://two.test",
						"--adapter-ingress-url=http://adapter.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, "api-url-2", "api-token")}`,
					],
					dependencies,
				),
			).toBe(1);
			expect(readInstalledConfig(t.config).openWebUIApiUrl).toBe("http://one.test");
		} finally {
			t.cleanup();
		}
	});
	test("persists replacement config before restarting the existing controller", async () => {
		const t = tempPath();
		try {
			const events: string[] = [];
			const deployment = {
				managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
				existing: async (input: { config: InstalledConfig }) => {
					if (input.config.openWebUIApiUrl === "http://two.test") expect(input.config.ownerUserId).toBeUndefined();
					events.push(`existing:${input.config.openWebUIApiUrl}:${input.config.openWebUIApiUrl}`);
					return { completed: true as const, mode: "existing" as const };
				},
				reset: async (input: {
					priorMode: "managed" | "existing";
					targetMode: "managed" | "existing";
					proof: string;
				}) => {
					expect(input.priorMode).toBe("existing");
					expect(input.targetMode).toBe("existing");
					events.push(`reset:${input.priorMode}`);
					return { completed: true as const, mode: "reset" as const };
				},
			};
			const first = [
				"configure",
				"existing",
				"--config",
				t.config,
				"--openwebui-url=http://one.test",
				"--adapter-ingress-url=http://gateway.test",
			] as string[];
			expect(
				await runCli([...first, `--openwebui-api-token-fd=${secretFd(t.directory, "api-existing-1", "token-1")}`], {
					deployment,
				}),
			).toBe(0);
			writeInstalledConfig({ ...readInstalledConfig(t.config), ownerUserId: "old-owner" }, t.config);
			const replacement = [
				"configure",
				"existing",
				"--config",
				t.config,
				"--openwebui-url=http://two.test",
				"--adapter-ingress-url=http://gateway.test",
				"--reset",
				"--reset-proof=route-change",
				`--openwebui-api-token-fd=${secretFd(t.directory, "api-existing-2", "token-2")}`,
			];
			expect(await runCli(replacement, { deployment, confirmReset: () => true })).toBe(0);
			expect(events).toEqual([
				"existing:http://one.test:http://one.test",
				"reset:existing",
				"existing:http://two.test:http://two.test",
			]);
		} finally {
			t.cleanup();
		}
	});
	test("reveals an adapter token from a custom config path", async () => {
		const t = tempPath();
		try {
			writeInstalledConfig(
				{
					version: 1,
					mode: "managed",
					installationId: "install",
					adapterToken: "custom-secret",
					readinessToken: "ready",
					openWebUIApiUrl: "http://localhost:8080",
					adapterProviderUrl: "http://adapter:8765/v1",
					bindHost: "0.0.0.0",
					bindPort: 8765,
				},
				t.config,
			);
			const output = sink();
			const result = await runCli(["credentials", "show", "adapter-token", "--config", t.config], {
				terminal: {
					input: { isTTY: true, fd: 0 } as unknown as NodeJS.ReadStream,
					output: { isTTY: true, fd: 0, write: output.write } as unknown as NodeJS.WriteStream,
				},
				confirmAdapterToken: () => true,
			});
			expect(result).toBe(0);
			expect(output.values).toEqual(["custom-secret\n"]);
		} finally {
			t.cleanup();
		}
	});
	test("existing route prepares the neutral default project root", async () => {
		const t = tempPath();
		const hadRoot = existsSync(DEFAULT_EXISTING_PROJECT_ROOT);
		try {
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://openwebui.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-token", "token")}`,
					"--adapter-ingress-url=http://gateway.test",
				],
				{
					deployment: {
						managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
						existing: async (_input: unknown) => ({ completed: true as const, mode: "existing" as const }),
						reset: async (_input: {
							priorMode: "managed" | "existing";
							targetMode: "managed" | "existing";
							proof: string;
						}) => ({ completed: true as const, mode: "reset" as const }),
					},
				},
			);
			expect(result).toBe(0);
			expect(existsSync(DEFAULT_EXISTING_PROJECT_ROOT)).toBe(true);
			expect(readInstalledConfig(t.config).projectRoot).toBe(DEFAULT_EXISTING_PROJECT_ROOT);
			expect(t.config.startsWith(DEFAULT_EXISTING_PROJECT_ROOT)).toBe(false);
		} finally {
			t.cleanup();
			if (!hadRoot) rmSync(DEFAULT_EXISTING_PROJECT_ROOT, { recursive: true, force: true });
		}
	});

	test("serving emits an HTTP acknowledgement through the injected server", async () => {
		const t = tempPath();
		try {
			const config: InstalledConfig = {
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
			writeInstalledConfig(config, t.config);
			const output = sink();
			const result = await runCli(["serve", "--config", t.config], {
				stdout: output,
				startServer: () => ({ url: "http://127.0.0.1:8765", stop: async () => {} }),
			});
			expect(result).toBe(0);
			expect(output.values).toEqual(["http://127.0.0.1:8765\n"]);
		} finally {
			t.cleanup();
		}
	});

	test("does not print secrets when configuration fails", async () => {
		const t = tempPath();
		try {
			const error = sink();
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					`--openwebui-api-token-fd=${openSync("/dev/null", "r")}`,
					"--adapter-ingress-url=http://gateway.test",
				],
				{ stderr: error },
			);
			expect(result).toBe(1);
			expect(error.values.join(" ")).not.toContain("api-token");
		} finally {
			t.cleanup();
		}
	});
	test("reset requires proof and retries the selected controller", async () => {
		const t = tempPath();
		try {
			const events: string[] = [];
			const dependencies = {
				confirmReset: (_mode: "managed" | "existing", proof: string) => {
					events.push(`confirm:${proof}`);
					return true;
				},
				deployment: {
					reset: async (input: {
						priorMode: "managed" | "existing";
						targetMode: "managed" | "existing";
						proof: { evidence: string };
					}) => {
						expect(input.targetMode).toBe("managed");
						events.push(`reset:${input.priorMode}:${input.proof.evidence}`);
						return { completed: true as const, mode: "reset" as const };
					},
					managed: async (_input: unknown) => {
						events.push("managed");
						return { completed: true as const, mode: "managed" as const };
					},
					existing: async (_input: unknown) => ({ completed: true as const, mode: "existing" as const }),
				},
			};
			const missing = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					"--reset",
					`--admin-email-fd=${secretFd(t.directory, "email", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "password", "password")}`,
				],
				dependencies,
			);
			expect(missing).toBe(1);
			expect(events).toEqual([]);
			expect(existsSync(t.config)).toBe(false);
			expect(existsSync(`${t.config}.bootstrap.json`)).toBe(false);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
			const rejected = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					"--reset",
					"--reset-proof=unverified",
					`--admin-email-fd=${secretFd(t.directory, "email-rejected", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "password-rejected", "password")}`,
				],
				{ ...dependencies, confirmReset: () => false },
			);
			expect(rejected).toBe(1);
			expect(events).toEqual([]);
			expect(existsSync(t.config)).toBe(false);
			expect(existsSync(`${t.config}.bootstrap.json`)).toBe(false);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
			const deniedExistingRoot = join(t.directory, "denied-existing-reset-root");
			const deniedExisting = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--reset",
					"--reset-proof=denied-existing-reset",
					"--project-root",
					deniedExistingRoot,
					"--openwebui-url=http://existing.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "existing-rejected", "token")}`,
				],
				{ ...dependencies, confirmReset: () => false },
			);
			expect(deniedExisting).toBe(1);
			expect(existsSync(deniedExistingRoot)).toBe(false);
			const result = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					"--reset",
					"--reset-proof=route-readiness-failed",
					`--admin-email-fd=${secretFd(t.directory, "email-2", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "password-2", "password")}`,
				],
				dependencies,
			);
			expect(result).toBe(0);
			expect(events).toEqual(["confirm:route-readiness-failed", "reset:managed:route-readiness-failed", "managed"]);
		} finally {
			t.cleanup();
		}
	});
	test("retires a self-consistent recovery snapshot orphaned before its journal", async () => {
		const t = tempPath();
		try {
			const first = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-1", "token-1")}`,
				],
				successfulManagedDependencies(),
			);
			expect(first).toBe(0);
			const original = readInstalledConfig(t.config);
			const failing = {
				managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
				existing: async (_input: unknown) => {
					throw new Error("forward retry failed");
				},
				reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
			};
			const failed = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-2", "token-2")}`,
				],
				{ deployment: failing },
			);
			expect(failed).toBe(1);
			expect(readInstalledConfig(t.config)).toEqual(original);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(true);
			expect(readFileSync(`${t.config}.recovery.json`, "utf8")).not.toContain("password");
			const bootstrapPath = `${t.config}.bootstrap.json`;
			const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8"));
			delete bootstrap.pendingRecovery;
			writeFileSync(bootstrapPath, JSON.stringify(bootstrap));
			const recovered = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-3", "token-3")}`,
				],
				successfulManagedDependencies(),
			);
			expect(recovered).toBe(0);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
		} finally {
			t.cleanup();
		}
	});
	test("fails closed on a torn recovery pair before writing configuration", async () => {
		const t = tempPath();
		const projectRoot = join(t.directory, "unique-nonexistent-project-root");
		try {
			const recoveryPath = `${t.config}.recovery.json`;
			writeFileSync(recoveryPath, JSON.stringify({ version: 1, transactionId: "orphan", snapshots: [] }));
			const beforeRecovery = readFileSync(recoveryPath, "utf8");
			const events: string[] = [];
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					`--project-root=${projectRoot}`,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-torn", "token")}`,
				],
				{
					deployment: {
						managed: async (_input: unknown) => {
							events.push("managed");
							return { completed: true as const, mode: "managed" as const };
						},
						existing: async (_input: unknown) => {
							events.push("existing");
							return { completed: true as const, mode: "existing" as const };
						},
						reset: async (_input: unknown) => {
							events.push("reset");
							return { completed: true as const, mode: "reset" as const };
						},
					},
				},
			);
			expect(result).toBe(1);
			expect(events).toEqual([]);
			expect(existsSync(projectRoot)).toBe(false);
			expect(existsSync(t.config)).toBe(false);
			expect(readFileSync(recoveryPath, "utf8")).toBe(beforeRecovery);
		} finally {
			t.cleanup();
		}
	});
	test("rejects malformed paired recovery snapshots before deployment", async () => {
		const cases: Array<{ name: string; mutate: (journal: any) => void }> = [
			{
				name: "extra typed key",
				mutate: journal => {
					journal.snapshots[0].extra = "unexpected";
				},
			},
			{
				name: "invalid mode",
				mutate: journal => {
					journal.snapshots[0].mode = 0o1000;
				},
			},
			{
				name: "invalid base64",
				mutate: journal => {
					journal.snapshots[0].content = "!!!!";
				},
			},
			{
				name: "noncanonical base64",
				mutate: journal => {
					journal.snapshots[0].content = "AB==";
				},
			},
			{
				name: "NUL symlink target",
				mutate: journal => {
					journal.snapshots[1] = { path: journal.snapshots[1].path, symlink: "bad\0target", mode: 0o600 };
				},
			},
			{
				name: "config symlink",
				mutate: journal => {
					journal.snapshots[0] = { path: journal.snapshots[0].path, symlink: "/tmp/config", mode: 0o600 };
				},
			},
			{
				name: "config directory",
				mutate: journal => {
					journal.snapshots[0] = { path: journal.snapshots[0].path, directory: true, mode: 0o700 };
				},
			},
			{
				name: "bad captured config mode",
				mutate: journal => {
					const config = JSON.parse(Buffer.from(journal.snapshots[0].content, "base64").toString("utf8"));
					config.mode = "managed";
					journal.snapshots[0].content = Buffer.from(JSON.stringify(config)).toString("base64");
				},
			},
			{
				name: "bad captured config identity",
				mutate: journal => {
					const config = JSON.parse(Buffer.from(journal.snapshots[0].content, "base64").toString("utf8"));
					config.installationId = "other-installation";
					journal.snapshots[0].content = Buffer.from(JSON.stringify(config)).toString("base64");
				},
			},
			{
				name: "unknown bootstrap top-level key",
				mutate: journal => {
					journal.extra = true;
				},
			},
			{
				name: "malformed captured bootstrap",
				mutate: journal => {
					const bootstrap = journal.snapshots.find((snapshot: any) => snapshot.path.endsWith(".bootstrap.json"));
					bootstrap.content = Buffer.from(JSON.stringify({ version: 1, phase: "unknown" })).toString("base64");
				},
			},
			{
				name: "directory artifact",
				mutate: journal => {
					journal.snapshots[1] = { path: journal.snapshots[1].path, directory: true, mode: 0o700 };
				},
			},
		];
		for (const variant of cases) {
			const t = tempPath();
			try {
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `${variant.name}-pair-1`, "token-1")}`,
					],
					successfulManagedDependencies(),
				);
				const failing = {
					managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
					existing: async (_input: unknown) => {
						throw new Error("forward retry failed");
					},
					reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
				};
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `${variant.name}-pair-2`, "token-2")}`,
					],
					{ deployment: failing },
				);
				const before = readFileSync(t.config, "utf8");
				const journal = JSON.parse(readFileSync(`${t.config}.recovery.json`, "utf8"));
				variant.mutate(journal);
				writeFileSync(`${t.config}.recovery.json`, JSON.stringify(journal));
				const beforeRecovery = readFileSync(`${t.config}.recovery.json`, "utf8");
				const events: string[] = [];
				const result = await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `${variant.name}-pair-3`, "token-3")}`,
					],
					{
						deployment: {
							managed: async (_input: unknown) => {
								events.push("managed");
								return { completed: true as const, mode: "managed" as const };
							},
							existing: async (_input: unknown) => {
								events.push("existing");
								return { completed: true as const, mode: "existing" as const };
							},
							reset: async (_input: unknown) => {
								events.push("reset");
								return { completed: true as const, mode: "reset" as const };
							},
						},
					},
				);
				expect(result, variant.name).toBe(1);
				expect(events, variant.name).toEqual([]);
				expect(readFileSync(t.config, "utf8"), variant.name).toBe(before);
				expect(readFileSync(`${t.config}.recovery.json`, "utf8"), variant.name).toBe(beforeRecovery);
			} finally {
				t.cleanup();
			}
		}
	});
	test("rejects malformed current bootstrap recovery state before mutation", async () => {
		const cases = [
			{
				name: "unknown phase",
				state: {
					version: 1,
					phase: "unknown",
					bootstrapComplete: false,
					apiKeyCreated: false,
					openAIConfigured: false,
					routeVerified: false,
					ownershipVerified: false,
					openAIConnectionIds: [],
				},
			},
			{
				name: "incoherent checkpoint",
				state: {
					version: 1,
					phase: "preflight",
					bootstrapComplete: true,
					apiKeyCreated: false,
					openAIConfigured: false,
					routeVerified: false,
					ownershipVerified: false,
					openAIConnectionIds: [],
				},
			},
		];
		for (const variant of cases) {
			const t = tempPath();
			try {
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `${variant.name}-pair-1`, "token-1")}`,
					],
					successfulManagedDependencies(),
				);
				const failing = {
					managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
					existing: async (_input: unknown) => {
						throw new Error("forward retry failed");
					},
					reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
				};
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `${variant.name}-pair-2`, "token-2")}`,
					],
					{ deployment: failing },
				);
				const beforeConfig = readFileSync(t.config, "utf8");
				const recoveryPath = `${t.config}.recovery.json`;
				const beforeRecovery = readFileSync(recoveryPath, "utf8");
				writeFileSync(`${t.config}.bootstrap.json`, JSON.stringify(variant.state));
				const beforeBootstrap = readFileSync(`${t.config}.bootstrap.json`, "utf8");
				const events: string[] = [];
				const result = await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `${variant.name}-pair-3`, "token-3")}`,
					],
					{
						deployment: {
							managed: async (_input: unknown) => {
								events.push("managed");
								return { completed: true as const, mode: "managed" as const };
							},
							existing: async (_input: unknown) => {
								events.push("existing");
								return { completed: true as const, mode: "existing" as const };
							},
							reset: async (_input: unknown) => {
								events.push("reset");
								return { completed: true as const, mode: "reset" as const };
							},
						},
					},
				);
				expect(result, variant.name).toBe(1);
				expect(events, variant.name).toEqual([]);
				expect(readFileSync(t.config, "utf8"), variant.name).toBe(beforeConfig);
				expect(readFileSync(recoveryPath, "utf8"), variant.name).toBe(beforeRecovery);
				expect(readFileSync(`${t.config}.bootstrap.json`, "utf8"), variant.name).toBe(beforeBootstrap);
			} finally {
				t.cleanup();
			}
		}
	});
	test("rejects a non-config artifact symlink before mutation", async () => {
		const t = tempPath();
		try {
			const artifact = `${t.config}.service`;
			const target = join(t.directory, "symlink-target");
			writeFileSync(target, "untouched");
			symlinkSync(target, artifact);
			const events: string[] = [];
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-artifact-symlink", "token")}`,
				],
				{
					deployment: {
						managed: async (_input: unknown) => {
							events.push("managed");
							return { completed: true as const, mode: "managed" as const };
						},
						existing: async (_input: unknown) => {
							events.push("existing");
							return { completed: true as const, mode: "existing" as const };
						},
						reset: async (_input: unknown) => {
							events.push("reset");
							return { completed: true as const, mode: "reset" as const };
						},
					},
				},
			);
			expect(result).toBe(1);
			expect(events).toEqual([]);
			expect(readFileSync(target, "utf8")).toBe("untouched");
			expect(readFileSync(artifact, "utf8")).toBe("untouched");
			expect(existsSync(t.config)).toBe(false);
		} finally {
			t.cleanup();
		}
	});
	test("rejects cross-route live config identity mismatch before mutation", async () => {
		const t = tempPath();
		const projectRoot = join(t.directory, "cross-route-project");
		try {
			await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					`--project-root=${projectRoot}`,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-cross-1", "token-1")}`,
				],
				successfulManagedDependencies(),
			);
			const failing = {
				managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
				existing: async (_input: unknown) => {
					throw new Error("forward retry failed");
				},
				reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
			};
			await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-cross-2", "token-2")}`,
				],
				{ deployment: failing },
			);
			const recoveryPath = `${t.config}.recovery.json`;
			const beforeRecovery = readFileSync(recoveryPath, "utf8");
			const live = readInstalledConfig(t.config);
			writeInstalledConfig({ ...live, installationId: "different-route-installation" }, t.config);
			const beforeConfig = readFileSync(t.config, "utf8");
			const events: string[] = [];
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-cross-3", "token-3")}`,
				],
				{
					deployment: {
						managed: async (_input: unknown) => {
							events.push("managed");
							return { completed: true as const, mode: "managed" as const };
						},
						existing: async (_input: unknown) => {
							events.push("existing");
							return { completed: true as const, mode: "existing" as const };
						},
						reset: async (_input: unknown) => {
							events.push("reset");
							return { completed: true as const, mode: "reset" as const };
						},
					},
				},
			);
			expect(result).toBe(1);
			expect(events).toEqual([]);
			expect(readFileSync(t.config, "utf8")).toBe(beforeConfig);
			expect(readFileSync(recoveryPath, "utf8")).toBe(beforeRecovery);
			expect(existsSync(projectRoot)).toBe(true);
		} finally {
			t.cleanup();
		}
	});
	test("rejects project roots that contain custom configuration artifacts", async () => {
		const t = tempPath();
		try {
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					`--project-root=${t.directory}`,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "api-overlap", "token")}`,
				],
				successfulManagedDependencies(),
			);
			expect(result).toBe(1);
			expect(existsSync(t.config)).toBe(false);
		} finally {
			t.cleanup();
		}
	});
	test("recovers a cross-route retry from the journaled prior mode", async () => {
		const t = tempPath();
		try {
			await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "cross-email-1", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "cross-password-1", "password")}`,
				],
				successfulManagedDependencies(),
			);
			writeInstalledConfig({ ...readInstalledConfig(t.config), ownerUserId: "managed-owner" }, t.config);
			let target: InstalledConfig | undefined;
			const events: string[] = [];
			const failing = {
				managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
				existing: async (input: { config: InstalledConfig }) => {
					expect(input.config.ownerUserId).toBe("managed-owner");
					target = input.config;
					throw new Error("cross-route deployment failed");
				},
				reset: async (input: {
					priorMode: "managed" | "existing";
					targetMode: "managed" | "existing";
					proof: string;
				}) => {
					events.push(`reset:${input.priorMode}:${input.targetMode}`);
					return { completed: true as const, mode: "reset" as const };
				},
			};
			await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--reset",
					"--reset-proof=route-change",
					"--openwebui-url=http://localhost:8080",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "cross-api-1", "token-1")}`,
				],
				{ deployment: failing, confirmReset: () => true },
			);
			expect(target).toBeDefined();
			const pending = JSON.parse(readFileSync(`${t.config}.bootstrap.json`, "utf8")).pendingRecovery;
			const journal = JSON.parse(readFileSync(`${t.config}.recovery.json`, "utf8"));
			expect(journal.transactionId).toBe(pending.transactionId);
			expect(pending.priorMode).toBe("managed");
			writeInstalledConfig(target!, t.config);
			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://localhost:8080",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, "cross-api-2", "token-2")}`,
					],
					{
						deployment: {
							managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
							existing: async (_input: { config: InstalledConfig }) => ({
								completed: true as const,
								mode: "existing" as const,
							}),
							reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
						},
					},
				),
			).toBe(0);
			expect(events).toEqual(["reset:managed:existing"]);
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
		} finally {
			t.cleanup();
		}
	});

	test("preserves paired recovery identity for a fresh-install retry", async () => {
		const t = tempPath();
		try {
			const failed = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "fresh-email-1", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "fresh-password-1", "password")}`,
				],
				{
					deployment: {
						managed: async (_input: unknown) => {
							throw new Error("fresh deployment failed");
						},
						existing: async (_input: unknown) => ({ completed: true as const, mode: "existing" as const }),
						reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
					},
				},
			);
			expect(failed).toBe(1);
			expect(existsSync(t.config)).toBe(false);
			const pending = JSON.parse(readFileSync(`${t.config}.bootstrap.json`, "utf8")).pendingRecovery;
			const journal = JSON.parse(readFileSync(`${t.config}.recovery.json`, "utf8"));
			expect(pending.transactionId).toBe(journal.transactionId);
			const adapterToken = pending.adapterToken;
			expect(
				await runCli(
					[
						"configure",
						"managed",
						"--config",
						t.config,
						`--admin-email-fd=${secretFd(t.directory, "fresh-email-2", "admin@example.test")}`,
						`--admin-password-fd=${secretFd(t.directory, "fresh-password-2", "password")}`,
					],
					{
						deployment: {
							managed: async (input: { config: InstalledConfig }) => {
								expect(input.config.adapterToken).toBe(adapterToken);
								return { completed: true as const, mode: "managed" as const };
							},
							existing: async (_input: unknown) => ({ completed: true as const, mode: "existing" as const }),
							reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
						},
					},
				),
			).toBe(0);
			expect(JSON.parse(readFileSync(`${t.config}.bootstrap.json`, "utf8")).pendingRecovery).toBeUndefined();
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
		} finally {
			t.cleanup();
		}
	});
	test("runs fresh production rollback with durable bootstrap checkpoint and retries exact identity", async () => {
		const t = tempPath();
		let readinessFailures = 10;
		const systemctl = (args: readonly string[]) =>
			args.includes("is-enabled") ? "disabled" : args.includes("is-active") ? "inactive" : "";
		const probeManagedAdapter = () => {
			if (readinessFailures > 0) {
				readinessFailures--;
				throw new Error("fresh readiness probe failed");
			}
		};
		const configureOpenWebUI = async (input: any) => {
			const current = await input.state.read();
			if (input.stopAfter !== "provider")
				await input.state.write({
					...current,
					phase: "api-key",
					bootstrapComplete: true,
					apiKeyCreated: true,
					ownerUserId: "bootstrap-owner",
					openWebUIApiToken: "bootstrap-api-key",
				});
			return {
				state: {
					...current,
					phase: input.stopAfter === "provider" ? "openai" : "api-key",
					bootstrapComplete: true,
					apiKeyCreated: true,
					openAIConfigured: input.stopAfter === "provider",
					ownerUserId: "bootstrap-owner",
					openWebUIApiToken: "bootstrap-api-key",
					openAIConnectionIds: input.stopAfter === "provider" ? ["0"] : [],
				},
				apiKey: "bootstrap-api-key",
				openAIConnections: [],
				ownerUserId: "bootstrap-owner",
			};
		};
		try {
			const dependencies = {
				configureOpenWebUI,
				confirmReset: () => true,
				systemctl,
				probeManagedAdapter,
				managedReadinessDelayMs: 0,
				managedDocker: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
			};
			const failed = await runCli(
				[
					"configure",
					"managed",
					"--config",
					t.config,
					`--admin-email-fd=${secretFd(t.directory, "fresh-email-1", "admin@example.test")}`,
					`--admin-password-fd=${secretFd(t.directory, "fresh-password-1", "password")}`,
				],
				dependencies,
			);
			expect(failed).toBe(1);
			expect(existsSync(t.config)).toBe(false);
			const bootstrap = JSON.parse(readFileSync(`${t.config}.bootstrap.json`, "utf8"));
			const pending = bootstrap.pendingRecovery;
			const journal = JSON.parse(readFileSync(`${t.config}.recovery.json`, "utf8"));
			expect(bootstrap).toMatchObject({
				phase: "route",
				bootstrapComplete: true,
				apiKeyCreated: true,
				ownerUserId: "bootstrap-owner",
				openWebUIApiToken: "bootstrap-api-key",
			});
			expect(pending).toMatchObject({
				installationId: pending.installationId,
				adapterToken: pending.adapterToken,
				readinessToken: pending.readinessToken,
				targetUrl: pending.targetUrl,
				providerUrl: pending.providerUrl,
				uiPort: pending.uiPort,
				linkage: pending.linkage,
			});
			expect(journal.transactionId).toBe(pending.transactionId);
			const { failedPhase: _failedPhase, failureEvidence: _failureEvidence, ...retryBootstrap } = bootstrap;
			writeFileSync(`${t.config}.bootstrap.json`, JSON.stringify(retryBootstrap));
			const expected = {
				installationId: pending.installationId,
				adapterToken: pending.adapterToken,
				readinessToken: pending.readinessToken,
				openWebUIApiUrl: pending.targetUrl,
				adapterProviderUrl: pending.providerUrl,
			};
			expect(
				await runCli(
					[
						"configure",
						"managed",
						"--config",
						t.config,
						"--reset",
						"--reset-proof=route-retry",
						`--admin-email-fd=${secretFd(t.directory, "fresh-email-2", "admin@example.test")}`,
						`--admin-password-fd=${secretFd(t.directory, "fresh-password-2", "password")}`,
					],
					dependencies,
				),
			).toBe(0);
			expect(readInstalledConfig(t.config)).toMatchObject({
				...expected,
				ownerUserId: "bootstrap-owner",
				openWebUIApiToken: "bootstrap-api-key",
			});
			expect(JSON.parse(readFileSync(`${t.config}.bootstrap.json`, "utf8")).pendingRecovery).toBeUndefined();
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
		} finally {
			t.cleanup();
		}
	});
	test("rejects terminal recovery checkpoints before deployment callbacks", async () => {
		for (const statePatch of [
			{ phase: "complete", bootstrapComplete: false },
			{ phase: "route", failedPhase: "complete", failureEvidence: "invalid terminal failure" },
		]) {
			const t = tempPath();
			try {
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, `terminal-${statePatch.phase}`, "token")}`,
					],
					{
						deployment: {
							managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
							existing: async (_input: unknown) => {
								throw new Error("deployment failed");
							},
							reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
						},
					},
				);
				const bootstrapPath = `${t.config}.bootstrap.json`;
				const state = JSON.parse(readFileSync(bootstrapPath, "utf8"));
				writeFileSync(bootstrapPath, JSON.stringify({ ...state, ...statePatch }));
				const events: string[] = [];
				expect(
					await runCli(
						[
							"configure",
							"existing",
							"--config",
							t.config,
							"--openwebui-url=http://one.test",
							"--adapter-ingress-url=http://gateway.test",
							`--openwebui-api-token-fd=${secretFd(t.directory, `terminal-retry-${statePatch.phase}`, "token")}`,
						],
						{
							deployment: {
								managed: async (_input: unknown) => {
									events.push("managed");
									return { completed: true as const, mode: "managed" as const };
								},
								existing: async (_input: unknown) => {
									events.push("existing");
									return { completed: true as const, mode: "existing" as const };
								},
								reset: async (_input: unknown) => {
									events.push("reset");
									return { completed: true as const, mode: "reset" as const };
								},
							},
						},
					),
				).toBe(1);
				expect(events).toEqual([]);
			} finally {
				t.cleanup();
			}
		}
	});
	test("restores the original controller after a reset recovery retry fails forward deployment", async () => {
		const t = tempPath();
		const projectRoot = join(t.directory, "workspace");
		let capturedBootstrap: string | undefined;
		let capturedRecovery: string | undefined;
		let invocation = 1;
		const systemctlCalls: string[] = [];
		try {
			mkdirSync(projectRoot);
			writeInstalledConfig(
				{
					version: 1,
					mode: "existing",
					installationId: "installed-existing",
					adapterToken: "adapter-token",
					readinessToken: "readiness-token",
					openWebUIApiToken: "api-token",
					openWebUIApiUrl: "http://one.test",
					adapterProviderUrl: "http://gateway.test/v1",
					bindHost: "127.0.0.1",
					bindPort: 8765,
					projectRoot,
				},
				t.config,
			);
			const result = await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://two.test",
					"--adapter-ingress-url=http://gateway.test",
					"--reset",
					"--reset-proof=route-change",
					`--openwebui-api-token-fd=${secretFd(t.directory, "reset-api-token-1", "api-token")}`,
				],
				{
					confirmReset: () => true,
					systemctl: args => {
						systemctlCalls.push(args.join(" "));
						if (args[2] === "is-enabled") return "enabled";
						if (args[2] === "is-active") return "active";
						return "";
					},
					configureOpenWebUI: async () => {
						capturedBootstrap = readFileSync(`${t.config}.bootstrap.json`, "utf8");
						capturedRecovery = readFileSync(`${t.config}.recovery.json`, "utf8");
						throw new Error("simulated interruption after reset quiescence");
					},
				},
			);
			expect(result).toBe(1);
			expect(JSON.parse(capturedBootstrap!).pendingRecovery).toMatchObject({
				priorControllerEnabled: true,
				priorControllerActive: true,
				controllerRecoveryRequired: true,
				controllerQuiesced: true,
			});
			const interruptedRecovery = JSON.parse(capturedBootstrap!);
			interruptedRecovery.pendingRecovery.controllerQuiesced = false;
			interruptedRecovery.pendingRecovery.linkage = interruptedRecovery.pendingRecovery.linkage.replace(
				":controller-quiesced",
				":controller-live",
			);
			capturedBootstrap = JSON.stringify(interruptedRecovery);

			// Preserve the durable artifacts written before the interruption as a process-boundary retry would.
			writeFileSync(`${t.config}.bootstrap.json`, capturedBootstrap!);
			writeFileSync(`${t.config}.recovery.json`, capturedRecovery!);
			systemctlCalls.length = 0;
			invocation = 2;

			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://two.test",
						"--adapter-ingress-url=http://gateway.test",
						"--reset",
						"--reset-proof=route-change",
						`--openwebui-api-token-fd=${secretFd(t.directory, "reset-api-token-2", "api-token")}`,
					],
					{
						confirmReset: () => true,
						systemctl: args => {
							systemctlCalls.push(args.join(" "));
							if (args[2] === "is-enabled") return "disabled";
							if (args[2] === "is-active") return "inactive";
							return "";
						},
						configureOpenWebUI: async () => {
							if (invocation === 2) throw new Error("forward deployment failed");
							throw new Error("unexpected invocation");
						},
					},
				),
			).toBe(1);
			expect(systemctlCalls).not.toContain("systemctl --user is-enabled openwebui-gjc-adapter-existing.service");
			expect(systemctlCalls).not.toContain("systemctl --user is-active openwebui-gjc-adapter-existing.service");
			expect(systemctlCalls).toEqual(
				expect.arrayContaining([
					"systemctl --user stop openwebui-gjc-adapter-existing.service",
					"systemctl --user disable openwebui-gjc-adapter-existing.service",
				]),
			);
			expect(systemctlCalls).toEqual(
				expect.arrayContaining([
					"systemctl --user enable openwebui-gjc-adapter-existing.service",
					"systemctl --user start openwebui-gjc-adapter-existing.service",
				]),
			);
		} finally {
			t.cleanup();
		}
	});
	test("keeps the restored bootstrap state when a replacement deployment rolls back", async () => {
		const t = tempPath();
		const projectRoot = join(t.directory, "workspace");
		const originalBootstrap = JSON.stringify({
			...INITIAL_BOOTSTRAP_STATE,
			phase: "complete",
			bootstrapComplete: true,
			apiKeyCreated: true,
			openAIConfigured: true,
			routeVerified: true,
			ownershipVerified: true,
			ownerUserId: "managed-owner",
			openWebUIApiToken: "managed-api-token",
			openAIConnectionIds: ["0"],
		});
		try {
			writeInstalledConfig(
				{
					version: 1,
					mode: "managed",
					installationId: "installed-managed",
					adapterToken: "adapter-token",
					readinessToken: "readiness-token",
					openWebUIApiToken: "managed-api-token",
					openWebUIApiUrl: "http://localhost:8080",
					adapterProviderUrl: "http://adapter:8765/v1",
					bindHost: "0.0.0.0",
					bindPort: 8765,
				},
				t.config,
			);
			writeFileSync(`${t.config}.bootstrap.json`, originalBootstrap);
			chmodSync(`${t.config}.bootstrap.json`, 0o600);

			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://replacement.test",
						"--adapter-ingress-url=http://gateway.test",
						"--project-root",
						projectRoot,
						"--reset",
						"--reset-proof=route-change",
						`--openwebui-api-token-fd=${secretFd(t.directory, "replacement-token", "api-token")}`,
					],
					{
						confirmReset: () => true,
						systemctl: args =>
							args[2] === "is-enabled" ? "disabled" : args[2] === "is-active" ? "inactive" : "",
						configureOpenWebUI: async () => {
							throw new Error("replacement setup failed");
						},
					},
				),
			).toBe(1);
			expect(JSON.parse(readFileSync(`${t.config}.bootstrap.json`, "utf8"))).toEqual(JSON.parse(originalBootstrap));
			expect(existsSync(`${t.config}.recovery.json`)).toBe(false);
		} finally {
			t.cleanup();
		}
	});

	test("rejects an in-range unsafe secret-bearing recovery snapshot mode", async () => {
		const t = tempPath();
		try {
			await runCli(
				[
					"configure",
					"existing",
					"--config",
					t.config,
					"--openwebui-url=http://one.test",
					"--adapter-ingress-url=http://gateway.test",
					`--openwebui-api-token-fd=${secretFd(t.directory, "unsafe-mode-1", "token")}`,
				],
				{
					deployment: {
						managed: async (_input: unknown) => ({ completed: true as const, mode: "managed" as const }),
						existing: async (_input: unknown) => {
							throw new Error("deployment failed");
						},
						reset: async (_input: unknown) => ({ completed: true as const, mode: "reset" as const }),
					},
				},
			);
			const recoveryPath = `${t.config}.recovery.json`;
			const journal = JSON.parse(readFileSync(recoveryPath, "utf8"));
			journal.snapshots.find((snapshot: { path: string }) => snapshot.path === t.config).mode = 0o644;
			writeFileSync(recoveryPath, JSON.stringify(journal));
			const events: string[] = [];
			expect(
				await runCli(
					[
						"configure",
						"existing",
						"--config",
						t.config,
						"--openwebui-url=http://one.test",
						"--adapter-ingress-url=http://gateway.test",
						`--openwebui-api-token-fd=${secretFd(t.directory, "unsafe-mode-2", "token")}`,
					],
					{
						deployment: {
							managed: async (_input: unknown) => {
								events.push("managed");
								return { completed: true as const, mode: "managed" as const };
							},
							existing: async (_input: unknown) => {
								events.push("existing");
								return { completed: true as const, mode: "existing" as const };
							},
							reset: async (_input: unknown) => {
								events.push("reset");
								return { completed: true as const, mode: "reset" as const };
							},
						},
					},
				),
			).toBe(1);
			expect(events).toEqual([]);
		} finally {
			t.cleanup();
		}
	});
	test("composes managed phases with fresh identity signup and provider setup", async () => {
		let state: BootstrapState = INITIAL_BOOTSTRAP_STATE;
		let config: Record<string, unknown> = {
			ENABLE_OPENAI_API: true,
			OPENAI_API_BASE_URLS: ["https://api.openai.com/v1"],
			OPENAI_API_KEYS: [""],
			OPENAI_API_CONFIGS: {},
		};
		const calls: Array<[string, string, unknown?, string?]> = [];
		let signupCalls = 0;
		let apiKeyCalls = 0;
		let providerUpdates = 0;
		let readinessCalls = 0;
		const http = {
			request: async <T>(method: string, path: string, body?: unknown, authorization?: string) => {
				calls.push([method, path, body, authorization]);
				if (path === "/api/version") return { version: "0.10.0" } as T;
				if (path === "/api/v1/auths/signup") {
					signupCalls++;
					return { token: "session" } as T;
				}
				if (path === "/api/v1/auths/api_key") {
					apiKeyCalls++;
					return { api_key: "key" } as T;
				}
				if (path === "/api/v1/auths/") return { id: "owner", role: "admin" } as T;
				if (path === "/openai/config" && method === "GET") return config as T;
				if (path === "/openai/config/update") {
					providerUpdates++;
					config = body as Record<string, unknown>;
					return undefined as T;
				}
				throw new Error(`unexpected setup request ${method} ${path}`);
			},
		};
		const store = {
			read: async () => parseBootstrapState(state),
			write: async (next: BootstrapState) => {
				state = parseBootstrapState(next);
			},
		};
		const result = await runPhaseAwareDeployment({
			state: store,
			phases: {
				preflight: async () => {},
				bootstrap: async () => {},
				apiKey: async () =>
					(
						await configureOpenWebUI({
							http,
							state: store,
							maintenance: { begin: async () => {}, end: async () => {} },
							adapterUrl: "http://adapter:8765/v1",
							adapterToken: "adapter-token",
							adminEmail: "admin@example.test",
							adminPassword: "password",
							installationId: "install-1",
							mode: "managed",
							stopAfter: "api-key",
						})
					).state,
				provider: async () =>
					(
						await configureOpenWebUI({
							http,
							state: store,
							maintenance: { begin: async () => {}, end: async () => {} },
							adapterUrl: "http://adapter:8765/v1",
							adapterToken: "adapter-token",
							adminEmail: "admin@example.test",
							adminPassword: "password",
							installationId: "install-1",
							mode: "managed",
							stopAfter: "provider",
						})
					).state,
				readiness: async () => {
					readinessCalls++;
					return {};
				},
			},
		});
		expect(result.completed).toBe(true);
		expect(state.phase).toBe("complete");
		expect(signupCalls).toBe(1);
		expect(apiKeyCalls).toBe(1);
		expect(providerUpdates).toBe(2);
		expect(readinessCalls).toBe(1);
		expect(
			calls.filter(call => call[1] === "/openai/config" && call[0] === "GET").every(call => call[3] === "key"),
		).toBe(true);
	});
});
