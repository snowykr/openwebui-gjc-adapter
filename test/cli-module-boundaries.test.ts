import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BuildAdapterServerOptionsDependencies,
	buildAdapterServerOptions,
	buildAdapterServerOptionsFromEnv,
	buildInstalledAdapterServerOptions,
	type RunCliDependencies,
	runCli,
	startAdapterServiceFromEnv,
} from "../src/cli";
import { buildStartupDiagnostics, loadAdapterConfig } from "../src/config";

const ROOT = process.cwd();
const CLI_MODULES = ["adapter-server-options.ts", "installed-adapter-server-options.ts"] as const;
const TOP_LEVEL_HELP = `Usage: openwebui-gjc-adapter [command]

Without a command, starts the adapter service from environment configuration.

Commands:
  configure managed   Configure a managed local OpenWebUI installation
  configure existing  Configure an adapter for an existing OpenWebUI installation
  serve --config PATH Start an installed adapter service
  probe-ready         Check an installed adapter service readiness
  credentials show adapter-token  Display an installed adapter token

Models:
  gjc/<encoded-provider>/<encoded-model>:<thinking>  Canonical GJC model id
  gjc  Input-only alias for the current machine-global default
`;
const EXISTING_HELP = `Usage: openwebui-gjc-adapter configure existing [options]

GJC runtime location options:
  --gjc-config-dir-name NAME   Set the persisted GJC config directory name
  --gjc-coding-agent-dir PATH  Set the persisted canonical coding-agent directory

Precedence: persisted CLI values, adapter-namespaced environment values, then derived defaults.
Pending recovery values are authoritative for retries.
`;
const MANAGED_HELP = `Usage: openwebui-gjc-adapter configure managed [options]

Managed GJC runtime locations are fixed; runtime location overrides are rejected.
`;

type Capture = { value: string };

function sink(capture: Capture): Pick<NodeJS.WriteStream, "write"> {
	return {
		write(chunk): boolean {
			capture.value += String(chunk);
			return true;
		},
	};
}

async function captureCli(
	argv: readonly string[],
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
	const stdout: Capture = { value: "" };
	const stderr: Capture = { value: "" };
	const dependencies: RunCliDependencies = { stdout: sink(stdout), stderr: sink(stderr) };
	const code = await runCli(argv, dependencies);
	return Object.freeze({
		code,
		stdout: stdout.value.replaceAll("\r\n", "\n"),
		stderr: stderr.value.replaceAll("\r\n", "\n"),
	});
}

function pureLines(source: string): number {
	return source.split("\n").filter(line => line.trim() !== "" && !line.trimStart().startsWith("//")).length;
}

function relativeImports(source: string): readonly string[] {
	return [...source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)].map(match => match[1] ?? "");
}

describe("CLI module boundaries", () => {
	test("exposes the pinned facade runtime manifest and function arities", async () => {
		// Given: compile-time consumers of both public dependency interfaces.
		const buildDependencies: BuildAdapterServerOptionsDependencies = {};
		const runDependencies: RunCliDependencies = {};
		void buildDependencies;
		void runDependencies;
		const facade = await import("../src/cli");

		// When: consumers inspect the CLI facade.
		const runtimeExports = Object.keys(facade).sort();

		// Then: the compatibility surface and JavaScript call arities remain exact.
		expect(runtimeExports).toEqual([
			"buildAdapterServerOptions",
			"buildAdapterServerOptionsFromEnv",
			"buildInstalledAdapterServerOptions",
			"runCli",
			"startAdapterServiceFromEnv",
		]);
		expect([
			buildAdapterServerOptionsFromEnv.length,
			buildAdapterServerOptions.length,
			buildInstalledAdapterServerOptions.length,
			startAdapterServiceFromEnv.length,
			runCli.length,
		]).toEqual([0, 1, 1, 0, 0]);
	});

	test("preserves normalized top-level existing and managed help output", async () => {
		// Given: the three supported help-shaped invocations.
		const invocations = [
			["--help"],
			["configure", "existing", "--help"],
			["configure", "managed", "--help"],
		] as const;

		// When: each invocation passes through the public CLI facade.
		const results = await Promise.all(invocations.map(captureCli));

		// Then: output bytes and exits remain pinned.
		expect(results).toEqual([
			{ code: 0, stdout: TOP_LEVEL_HELP, stderr: "" },
			{ code: 0, stdout: EXISTING_HELP, stderr: "" },
			{ code: 0, stdout: MANAGED_HELP, stderr: "" },
		]);
		expect(results[1]?.stdout.match(/--gjc-[a-z-]+/g)).toEqual(["--gjc-config-dir-name", "--gjc-coding-agent-dir"]);
		expect(results[2]?.stdout).not.toContain("--gjc-");
	});

	test("pins config outputs diagnostics and validation message order", () => {
		// Given: stable environment inputs spanning project and artifact parsing.
		const config = loadAdapterConfig({
			GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: "/allowed",
			GJC_OPENWEBUI_ARTIFACT_BASE_URL: "https://artifacts.test/base/",
			GJC_OPENWEBUI_PROJECTS: "/repo|Demo|folder-1|/sessions",
			GJC_OPENWEBUI_SESSION_ROOT: "/session-root",
		});

		// When: the public config and diagnostic surfaces are evaluated.
		const diagnostic = buildStartupDiagnostics(config);

		// Then: defaults, parsed bytes, diagnostics, and errors remain exact.
		expect(config).toEqual({
			bindHost: "127.0.0.1",
			bindPort: 8765,
			openWebUIBaseUrl: "http://localhost:8080",
			statePath: ".gjc/openwebui-adapter",
			gjcCommand: "gjc",
			gjcConfigDirName: ".gjc",
			gjcCodingAgentDir: config.runtimeLocations.agentDir,
			runtimeLocations: config.runtimeLocations,
			turnTimeoutMs: 180_000,
			sessionRoot: "/session-root",
			allowedProjectRoots: ["/allowed"],
			artifactBaseUrl: "https://artifacts.test/base",
			projects: [{ cwd: "/repo", name: "Demo", openWebUIFolderId: "folder-1", sessionRoot: "/sessions" }],
		});
		expect(diagnostic).toEqual({
			status: "degraded",
			missingAuth: true,
			missingAdapterApiToken: true,
			missingAllowedProjectRoots: false,
			expectedHeaderNames: [
				"X-OpenWebUI-Chat-Id",
				"X-OpenWebUI-Message-Id",
				"X-OpenWebUI-User-Message-Id",
				"X-OpenWebUI-User-Message-Parent-Id",
				"X-OpenWebUI-Task",
			],
			messages: [
				"GJC_OPENWEBUI_ADAPTER_API_TOKEN is not set; inbound OpenAI-compatible calls are not authenticated.",
				"GJC_OPENWEBUI_API_TOKEN is not set; OpenWebUI API calls are not authenticated.",
			],
		});
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_PROJECTS: "|" })).toThrow(
			"GJC_OPENWEBUI_PROJECTS entry 1 must include a non-empty cwd",
		);
		expect(() => loadAdapterConfig({ GJC_OPENWEBUI_ARTIFACT_BASE_URL: "not-a-url" })).toThrow(
			"GJC_OPENWEBUI_ARTIFACT_BASE_URL must be a valid URL",
		);
	});

	test("requires exactly the two planned extraction modules", () => {
		// Given: the production source tree before extraction.
		const modulePresence = CLI_MODULES.map(file => existsSync(join(ROOT, "src", file)));
		const matchingModules = readdirSync(join(ROOT, "src"))
			.filter(file => file.endsWith("adapter-server-options.ts"))
			.sort();

		// When: the extraction-module manifest is measured.
		const architecture = { modulePresence, matchingModules };

		// Then: only the two named modules exist.
		expect(architecture).toEqual({ modulePresence: [true, true], matchingModules: [...CLI_MODULES].sort() });
	});

	test("keeps the CLI facade within the pure LOC law", () => {
		// Given: the public CLI facade source.
		const source = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");

		// When: pure production lines are counted.
		const cliLines = pureLines(source);

		// Then: the facade remains reviewable without compressed lines.
		expect(cliLines).toBeLessThanOrEqual(250);
	});

	test("enforces the exact acyclic CLI import graph", async () => {
		// Given: extraction modules that may not yet exist during architecture RED.
		if (CLI_MODULES.some(file => !existsSync(join(ROOT, "src", file)))) return;
		const base = await import("../src/adapter-server-options");
		const installed = await import("../src/installed-adapter-server-options");
		const cliSource = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
		const baseSource = readFileSync(join(ROOT, "src", CLI_MODULES[0]), "utf8");
		const installedSource = readFileSync(join(ROOT, "src", CLI_MODULES[1]), "utf8");
		const runnerSource = readFileSync(join(ROOT, "src/gjc/rpc-client-runner.ts"), "utf8");
		const transportSource = readFileSync(join(ROOT, "src/gjc/rpc-client-transport.ts"), "utf8");
		const deploymentSource = readFileSync(join(ROOT, "src/configure/deployment-artifacts.ts"), "utf8");
		const cliImports = relativeImports(cliSource);
		const baseImports = relativeImports(baseSource);
		const installedImports = relativeImports(installedSource);

		// When: runtime edges and forbidden reverse edges are inspected.
		const graph = {
			cliToBase: cliImports.includes("./adapter-server-options"),
			cliToInstalled: cliImports.includes("./installed-adapter-server-options"),
			installedToBase: installedImports.includes("./adapter-server-options"),
			baseToFacade: baseImports.includes("./cli"),
			baseToInstalled: baseImports.includes("./installed-adapter-server-options"),
			installedToFacade: installedImports.includes("./cli"),
			resolvedServerChain:
				baseSource.includes("buildResolvedAdapterServerOptions(loadAdapterConfig(env), dependencies)") &&
				cliSource.includes("buildResolvedInstalledAdapterServerOptions(config)") &&
				installedSource.includes("buildResolvedAdapterServerOptions(config") &&
				baseSource.includes("createResolvedGjcRpcTurnRunner({") &&
				runnerSource.includes("input.clientFactory ?? createDefaultRpcTransport") &&
				transportSource.includes("new RpcClient({"),
			resolvedDeploymentChain:
				deploymentSource.includes("renderResolvedManagedCompose({") &&
				deploymentSource.includes("renderResolvedSystemdComposeUnit({") &&
				deploymentSource.includes("renderResolvedExistingSystemdUnit({"),
			forbiddenProductionWrapperCalls:
				/\bcreateGjcRpcTurnRunner\(/.test(baseSource) ||
				/\bbuildAdapterServerOptions\(config/.test(installedSource) ||
				/await buildInstalledAdapterServerOptions\(config\)/.test(cliSource) ||
				/\brender(?:ManagedCompose|SystemdComposeUnit|ExistingSystemdUnit)\(\{/.test(deploymentSource),
			ownedRuntimeExports: [Object.keys(base).sort(), Object.keys(installed).sort()],
		};

		// Then: the sole topological chain is facade to installed to base.
		expect(graph).toEqual({
			cliToBase: true,
			cliToInstalled: true,
			installedToBase: true,
			baseToFacade: false,
			baseToInstalled: false,
			installedToFacade: false,
			resolvedServerChain: true,
			resolvedDeploymentChain: true,
			forbiddenProductionWrapperCalls: false,
			ownedRuntimeExports: [
				[
					"buildAdapterServerOptions",
					"buildAdapterServerOptionsFromEnv",
					"buildResolvedAdapterServerOptions",
					"resolveAdapterConfig",
					"startAdapterServiceFromEnv",
				],
				["buildInstalledAdapterServerOptions", "buildResolvedInstalledAdapterServerOptions"],
			],
		});
	});
});
