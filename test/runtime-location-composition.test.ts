import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResolvedAdapterServerOptions } from "../src/adapter-server-options";
import { runCli } from "../src/cli";
import { loadInstalledAdapterConfig } from "../src/config";
import { type DeploymentArtifacts, stageDeploymentArtifacts } from "../src/configure/deployment-artifacts";
import { renderManagedCompose, renderResolvedManagedCompose } from "../src/configure/managed-compose";
import { type InstalledConfig, writeInstalledConfig } from "../src/configure/private-config";
import { resolveGjcRuntimeLocations } from "../src/configure/runtime-locations";
import {
	renderExistingSystemdUnit,
	renderResolvedExistingSystemdUnit,
	renderResolvedSystemdComposeUnit,
} from "../src/configure/systemd";
import { buildResolvedInstalledAdapterServerOptions } from "../src/installed-adapter-server-options";

const { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } = fs;
const { readdirSync, rmSync, symlinkSync, writeFileSync } = fs;

function managedConfig(): InstalledConfig {
	return {
		version: 1,
		mode: "managed",
		installationId: "installation",
		adapterToken: "adapter-token",
		readinessToken: "readiness-token",
		openWebUIApiUrl: "http://localhost:8080",
		adapterProviderUrl: "http://adapter:8765/v1",
		bindHost: "0.0.0.0",
		bindPort: 8765,
	};
}

function artifacts(root: string): DeploymentArtifacts {
	return {
		path: join(root, "config.json"),
		directory: root,
		composeFile: join(root, "config.json.compose.yml"),
		unitFile: join(root, "config.json.service"),
		userUnitDirectory: join(root, "systemd"),
		sourceRoot: join(root, "src"),
	};
}

const docker = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

function stage(paths: DeploymentArtifacts, config: InstalledConfig = managedConfig()): void {
	stageDeploymentArtifacts({ artifacts: paths, config, uiPort: 8080, managedDocker: docker });
}

function recorded<T>(calls: string[], name: string, result: T): T {
	calls.push(name);
	return result;
}

describe("runtime location composition", () => {
	test("required builder and renderer seams reject omitted resolved locations", async () => {
		const message = "resolved runtime locations are required";

		for (const builder of [buildResolvedAdapterServerOptions, buildResolvedInstalledAdapterServerOptions])
			await expect(Reflect.apply(builder, undefined, [{}])).rejects.toThrow(new TypeError(message));
		expect(() =>
			Reflect.apply(renderResolvedManagedCompose, undefined, [{ openWebUIImage: "webui", adapterImage: "adapter" }]),
		).toThrow(new TypeError(message));
		expect(() =>
			Reflect.apply(renderResolvedSystemdComposeUnit, undefined, [
				{ workingDirectory: "/srv", composeFile: "/srv/compose.yml" },
			]),
		).toThrow(new TypeError(message));
		expect(() => Reflect.apply(renderResolvedExistingSystemdUnit, undefined, [{ workingDirectory: "/srv" }])).toThrow(
			new TypeError(message),
		);
	});

	test("retains installed fields and resolves one frozen object", () => {
		// Given: an installed direct configuration with explicit runtime fields.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-installed-runtime-")));
		const home = join(root, "home");
		const agentDir = join(root, "agent");
		const paths = artifacts(root);
		mkdirSync(home);
		mkdirSync(agentDir);
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const installed: InstalledConfig = {
				...managedConfig(),
				mode: "existing",
				openWebUIApiUrl: "http://localhost:8080",
				adapterProviderUrl: "http://localhost:8765/v1",
				bindHost: "127.0.0.1",
				projectRoot: root,
				gjcConfigDirName: ".direct-gjc",
				gjcCodingAgentDir: agentDir,
			};
			writeInstalledConfig(installed, paths.path);

			// When: the installed adapter configuration is loaded.
			const config = loadInstalledAdapterConfig(paths.path);
			stage(paths, installed);
			const unit = readFileSync(paths.unitFile, "utf8");

			// Then: fields survive parsing and the owned resolver supplies the frozen locations.
			expect(config.gjcConfigDirName).toBe(".direct-gjc");
			expect(config.gjcCodingAgentDir).toBe(agentDir);
			expect(Object.isFrozen(config.runtimeLocations)).toBe(true);
			expect(unit).toContain("Environment=GJC_CONFIG_DIR=.direct-gjc");
			expect(unit).toContain(`Environment=GJC_CODING_AGENT_DIR=${agentDir}`);
			expect(unit).toContain("UnsetEnvironment=PI_CONFIG_DIR");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("renders managed and host child environments from resolved locations", () => {
		// Given: the single managed locations object.
		const locations = resolveGjcRuntimeLocations({ mode: "managed" });

		// When: both deployment renderers consume it.
		const compose = renderManagedCompose({
			openWebUIImage: "webui:test",
			adapterImage: "adapter:test",
			runtimeLocations: locations,
		});
		const unit = renderExistingSystemdUnit({
			workingDirectory: "/srv/adapter",
			adapterCommand: ["adapter", "serve"],
			runtimeLocations: locations,
		});

		// Then: the explicit overwrites and PI removal are rendered without suppressing XDG.
		expect(compose).toContain("HOME: /var/lib/gjc/home");
		expect(compose).toContain("GJC_CONFIG_DIR: .gjc");
		expect(compose).toContain("GJC_CODING_AGENT_DIR: /var/lib/gjc/home/.gjc/agent");
		expect(compose).toContain("com.gjc.reader-workspace: /var/lib/gjc/home/.gjc/openwebui/default-reader");
		expect(compose).toContain(
			"com.gjc.reader-session-root: /var/lib/gjc/home/.gjc/openwebui/default-reader/.gjc/sessions",
		);
		expect(unit).toContain("HOME=/var/lib/gjc/home");
		expect(unit).toContain("GJC_CONFIG_DIR=.gjc");
		expect(unit).toContain("GJC_CODING_AGENT_DIR=/var/lib/gjc/home/.gjc/agent");
		expect(compose).not.toContain("XDG_DATA_HOME");
		expect(unit).not.toContain("XDG_DATA_HOME");
		expect(unit).toContain("UnsetEnvironment=PI_CONFIG_DIR");
		expect(compose).not.toContain("PI_CONFIG_DIR");
	});

	test("stages the managed neutral reader workspace before catalog requests", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-managed-reader-workspace-")));
		try {
			stage(artifacts(root));

			for (const path of [
				"state/home/.gjc/agent",
				"state/home/.gjc/openwebui/default-reader",
				"state/home/.gjc/openwebui/default-reader/.gjc/sessions",
			])
				expect(lstatSync(join(root, path)).isDirectory()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("preserves literal dollars and spaces in systemd Environment values", () => {
		// Given: resolved locations containing systemd-significant whitespace and dollars.
		const base = resolveGjcRuntimeLocations({ mode: "managed" });
		const locations = {
			...base,
			childEnvironment: { ...base.childEnvironment, HOME: "/srv/gjc home/$literal" },
		};

		// When: a host unit renders environment and command values through their distinct grammars.
		const unit = renderExistingSystemdUnit({
			workingDirectory: "/srv/adapter",
			adapterCommand: ["/opt/$adapter bin", "serve"],
			runtimeLocations: locations,
		});

		// Then: Environment keeps one literal dollar while ExecStart retains its prior escaping.
		expect(unit).toContain('Environment="HOME=/srv/gjc home/$literal"');
		expect(unit).toContain('ExecStart="/opt/$$adapter bin" serve');
	});

	test.each([
		[4242, 4343],
		[0, 0],
	])("retains the first numeric managed adapter ownership %i:%i on rerender", (uid, gid) => {
		// Given: a first render under the original service identity.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-managed-owner-")));
		const paths = artifacts(root);
		const getuid = spyOn(process, "getuid").mockReturnValue(uid);
		const getgid = spyOn(process, "getgid").mockReturnValue(gid);
		try {
			stage(paths);
			writeFileSync(
				paths.composeFile,
				readFileSync(paths.composeFile, "utf8").replace(
					"  openwebui:\n    image:",
					'  openwebui:\n    user: "7777:8888"\n    image:',
				),
			);
			getuid.mockReturnValue(9998);
			getgid.mockReturnValue(9999);

			// When: staging runs again under a different caller.
			stage(paths);

			// Then: the persisted adapter identity wins.
			expect(readFileSync(paths.composeFile, "utf8")).toContain(`user: "${uid}:${gid}"`);
		} finally {
			getuid.mockRestore();
			getgid.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects malformed prior ownership before replacing artifacts", () => {
		// Given: malformed prior managed ownership shapes and an existing unit sentinel.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-managed-malformed-")));
		const paths = artifacts(root);
		try {
			for (const malformed of [
				'services:\n  adapter:\n    user: "root"\n',
				'services:\n  adapter:\n    user: "1234:1234"\n    user: "5678:5678"\n',
				'services:\n  adapter:\n    image: "adapter"\n  openwebui:\n    user: "1234:1234"\n',
				'services:\n  adapter:\n    user: "4294967295:1234"\n',
			]) {
				writeFileSync(paths.composeFile, malformed);
				writeFileSync(paths.unitFile, "unit-sentinel\n");
				// When/Then: staging fails closed before either existing artifact is replaced.
				expect(() => stage(paths)).toThrow("managed adapter ownership");
				expect(readFileSync(paths.composeFile, "utf8")).toBe(malformed);
				expect(readFileSync(paths.unitFile, "utf8")).toBe("unit-sentinel\n");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.each(["symlink", "FIFO"] as const)("rejects a managed Compose %s before touching sibling artifacts", kind => {
		// Given: a hostile non-regular Compose artifact and three byte-pinned sentinels.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-managed-compose-link-")));
		const paths = artifacts(root);
		const target = join(root, "outside-target.yml");
		writeFileSync(target, "outside-sentinel\n");
		if (kind === "symlink") symlinkSync(target, paths.composeFile);
		else expect(Bun.spawnSync(["mkfifo", paths.composeFile]).exitCode).toBe(0);
		writeFileSync(paths.unitFile, "unit-sentinel\n");
		writeFileSync(join(root, "adapter-token"), "token-sentinel\n");
		try {
			// When/Then: descriptor inspection rejects the link before any replacement.
			const started = performance.now();
			expect(() => stage(paths)).toThrow("managed Compose artifact must be a regular file or absent");
			expect(performance.now() - started).toBeLessThan(500);
			expect(
				kind === "symlink" ? lstatSync(paths.composeFile).isSymbolicLink() : lstatSync(paths.composeFile).isFIFO(),
			).toBe(true);
			expect([target, paths.unitFile, join(root, "adapter-token")].map(path => readFileSync(path, "utf8"))).toEqual([
				"outside-sentinel\n",
				"unit-sentinel\n",
				"token-sentinel\n",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("runCli rejects managed runtime overrides before deployment or artifact mutation", async () => {
		// Given: tracked and untracked sentinels plus every external deployment seam instrumented.
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gjc-managed-override-cli-")));
		const configPath = join(root, "config.json");
		const tracked = "tracked-config-sentinel\n";
		const untrackedPath = join(root, "untracked-sentinel");
		const calls: string[] = [];
		writeFileSync(configPath, tracked);
		writeFileSync(untrackedPath, "untracked-sentinel\n");

		try {
			// When: the shipped CLI receives a forbidden managed runtime override.
			const exitCode = await runCli(
				["configure", "managed", `--config=${configPath}`, "--gjc-config-dir-name=.hostile"],
				{
					stderr: { write: value => recorded(calls, `stderr:${value}`, true) },
					managedDocker: { run: async () => recorded(calls, "docker", { exitCode: 0, stdout: "", stderr: "" }) },
					systemctl: () => recorded(calls, "systemctl", undefined),
					deployment: {
						managed: () => recorded(calls, "deploy-managed", { completed: true, mode: "managed" as const }),
						existing: () => recorded(calls, "deploy-existing", { completed: true, mode: "existing" as const }),
						reset: () => recorded(calls, "deploy-reset", { completed: true, mode: "reset" as const }),
					},
				},
			);

			// Then: only the usage error is observed and both sentinels remain byte-identical.
			expect(exitCode).toBe(2);
			expect(calls).toEqual(["stderr:managed configuration does not accept GJC runtime location overrides\n"]);
			expect(readFileSync(configPath, "utf8")).toBe(tracked);
			expect(readFileSync(untrackedPath, "utf8")).toBe("untracked-sentinel\n");
			expect(readdirSync(root).sort()).toEqual(["config.json", "untracked-sentinel"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
