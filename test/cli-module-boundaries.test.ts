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

First-install route:
  Shared: managed and existing both require user systemd and OpenWebUI >=0.10.0.
  managed   Requires rootful Docker with userns-remap disabled.
  existing  Uses an externally owned OpenWebUI deployment and provider setup;
            choose it for rootless Docker or Docker userns-remap incompatibilities.

Readiness:
  probe-ready checks adapter/OpenWebUI readiness only. It does not prove GJC
  provider authentication, usable models, or a successful first turn. Complete
  GJC provider/model onboarding separately; see route help and README.

Models:
  gjc/<encoded-provider>/<encoded-model>:<thinking>  Canonical GJC model id
  gjc  Input-only alias for the current machine-global default
`;
const EXISTING_HELP = `Usage: openwebui-gjc-adapter configure existing [options]

Prerequisites before this command:
  Shared by managed and existing: user systemd and OpenWebUI >=0.10.0.
  For rootless Docker or Docker userns-remap incompatibilities, choose existing
  instead of managed; shared prerequisites still apply.
Required existing-route inputs:
  --openwebui-url URL          Existing OpenWebUI base URL
  --adapter-ingress-url URL    Adapter URL reachable from OpenWebUI
  --openwebui-api-token-fd FD  Distinct inherited decimal FD for the admin token

Project link locations:
  --project-root PATH          Allowed parent for linkable project directories
  Project directories must be readable/searchable. Existing session roots need
  read/write/search access; prospective roots need write/search access on the
  nearest existing ancestor.

Ownership:
  Provider connection, custom headers, ingress, and their operation remain
  manual and externally owned. The adapter validates the supplied OpenWebUI
  administration token; it does not configure that provider.

GJC runtime location options:
  --gjc-config-dir-name NAME   Set the persisted GJC config directory name
  --gjc-coding-agent-dir PATH  Set the persisted canonical coding-agent directory

FD safety: pass inherited descriptor numbers, never secret values. Keep setup
descriptors distinct and open for this process.

Precedence: persisted CLI values, adapter-namespaced environment values, then derived defaults.
Pending recovery values are authoritative for retries.
`;
const MANAGED_HELP = `Usage: openwebui-gjc-adapter configure managed [options]

Prerequisites before this command:
  Shared by managed and existing: user systemd and OpenWebUI >=0.10.0.
  Managed additionally requires rootful Docker with Docker userns-remap disabled.
  Use configure existing for rootless Docker or Docker userns-remap
  incompatibilities only; shared prerequisites still apply.
Managed GJC runtime locations are fixed; runtime location overrides are rejected.
Required managed-route inputs:
  --admin-email-fd FD           Distinct inherited decimal FD for admin email
  --admin-password-fd FD        Distinct inherited decimal FD for admin password

FD safety: pass two distinct inherited decimal descriptor numbers, never secret
values. Managed configures only its owned OpenWebUI provider after adapter
readiness; GJC provider authentication and model onboarding remain GJC-owned.
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
const retiredRuntimeFactory = ["createGjc", "R" + "pc", "TurnRunner"].join("");

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
		expect(results[0]?.stdout).toContain("probe-ready checks adapter/OpenWebUI readiness only");
		expect(results[1]?.stdout).toContain("--openwebui-url URL");
		expect(results[1]?.stdout).toContain("Shared by managed and existing: user systemd and OpenWebUI >=0.10.0.");
		expect(results[1]?.stdout).toContain(
			"For rootless Docker or Docker userns-remap incompatibilities, choose existing",
		);
		expect(results[1]?.stdout).toContain("shared prerequisites still apply.");
		expect(results[1]?.stdout).not.toContain("Docker prerequisites do not hold");
		expect(results[1]?.stdout).toContain("--adapter-ingress-url URL");
		expect(results[1]?.stdout).toContain("--openwebui-api-token-fd FD");
		expect(results[1]?.stdout).toContain("--project-root PATH");
		expect(results[1]?.stdout).toContain("Project directories must be readable/searchable");
		expect(results[1]?.stdout).toContain("Existing session roots need");
		expect(results[1]?.stdout).toContain("prospective roots need write/search access");
		expect(results[1]?.stdout).toContain("nearest existing ancestor");
		expect(results[2]?.stdout).toContain("rootful Docker");
		expect(results[2]?.stdout).toContain("userns-remap disabled");
		expect(results[0]?.stdout).toContain(
			"Shared: managed and existing both require user systemd and OpenWebUI >=0.10.0.",
		);
		expect(results[0]?.stdout).toContain("rootless Docker or Docker userns-remap incompatibilities.");
		expect(results[2]?.stdout).toContain("Shared by managed and existing: user systemd and OpenWebUI >=0.10.0.");
		expect(results[2]?.stdout).toContain("Use configure existing for rootless Docker or Docker userns-remap");
		expect(results[2]?.stdout).not.toContain("those Docker prerequisites");
		expect(results[0]?.stdout).not.toContain("when those Docker prerequisites");
		expect(results[2]?.stdout).not.toContain("user systemd or OpenWebUI");
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		expect(readme).toContain("`--project-root`");
		expect(readme).toContain("`/home/me/src`");
		expect(readme).toContain(
			"route-specific help for first-install guidance. Route help documents required first-install inputs and prerequisites",
		);
		expect(readme).toContain("Both CLI-managed routes require user systemd and OpenWebUI >=0.10.0;");
		expect(readme).toContain("existing mode is not a fallback for missing shared prerequisites.");
		expect(readme).toContain("Choose existing mode for rootless or userns-remapped Docker");
		expect(readme).toContain("linked paths must be inside that configured root");
		expect(readme).toContain("default per-project session root (`<cwd>/.gjc/sessions`)");
		expect(readme).toContain("permissions are checked before project registration");
		expect(readme).toContain("An existing session root needs read/write/search access");
		expect(readme).toContain("needs write/search access on its nearest existing ancestor");
		expect(readme).not.toContain("Any managed Docker prerequisite does not hold");
		expect(readme).not.toContain("use existing when those Docker prerequisites fail");
		expect(readme).not.toContain("route-specific help for the complete accepted surface");
		expect(readme).toContain(
			"`/v1/models` emits canonical ids; OpenWebUI picker values may add one `<connection-id>.` prefix, which the adapter removes before validation.",
		);
		expect(readme).toContain("GJC applies the requested `task.agentModelOverrides`");
		expect(readme).toContain("No adapter restart or new GJC session is required for these role changes");
		expect(readme).not.toContain("/model <target>");
		for (const output of results.map(result => result.stdout))
			expect(output).not.toMatch(/--(?:provider-key|provider-credential|mpreset|profile|reload)\b/);
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
	test("pins explicit live package exports and blocks internal live modules", () => {
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			exports: Record<string, unknown>;
		};
		const supportedLivePaths = [
			"./live/chat-completions",
			"./live/gjc-routing-runner",
			"./live/models",
			"./live/openai-types",
		] as const;

		expect(
			Object.keys(manifest.exports)
				.filter(path => path.startsWith("./live/") && path !== "./live/*")
				.sort(),
		).toEqual([...supportedLivePaths].sort());
		expect(manifest.exports["./live/*"]).toBeNull();
		for (const path of supportedLivePaths)
			expect(manifest.exports[path]).toEqual({
				types: `./src/${path.slice(2)}.ts`,
				import: `./src/${path.slice(2)}.ts`,
			});
	});
	test("resolves supported live consumer paths but rejects internals", async () => {
		for (const path of [
			"openwebui-gjc-adapter/live/chat-completions",
			"openwebui-gjc-adapter/live/gjc-routing-runner",
			"openwebui-gjc-adapter/live/models",
			"openwebui-gjc-adapter/live/openai-types",
		])
			await expect(import(path)).resolves.toBeDefined();

		for (const path of [
			"openwebui-gjc-adapter/live/gjc-routing-control",
			"openwebui-gjc-adapter/live/gjc-routing-successor-recovery",
			"openwebui-gjc-adapter/live/gjc-routing-test-barrier",
		])
			await expect(import(path)).rejects.toThrow();
	});

	test("keeps the live routing type graph below the runner facade", () => {
		const selectionSource = readFileSync(join(ROOT, "src/live/gjc-routing-selection.ts"), "utf8");
		const gatewaySource = readFileSync(join(ROOT, "src/live/gjc-routing-gateway.ts"), "utf8");
		const facadeSource = readFileSync(join(ROOT, "src/live/gjc-routing-runner.ts"), "utf8");

		expect({
			selectionTypeEdgeToLowerRunner:
				/import\s+type\s+\{\s*GjcTurnRunner\s*\}\s+from\s+["']\.\.\/gjc\/turn-runner["']/.test(selectionSource),
			selectionToRunnerFacade: relativeImports(selectionSource).includes("./gjc-routing-runner"),
			gatewayToSelection: relativeImports(gatewaySource).includes("./gjc-routing-selection"),
			facadeToGateway: relativeImports(facadeSource).includes("./gjc-routing-gateway"),
		}).toEqual({
			selectionTypeEdgeToLowerRunner: true,
			selectionToRunnerFacade: false,
			gatewayToSelection: true,
			facadeToGateway: true,
		});
	});

	test("enforces the exact acyclic CLI import graph", async () => {
		// Given: extraction modules that may not yet exist during architecture RED.
		if (CLI_MODULES.some(file => !existsSync(join(ROOT, "src", file)))) return;
		const base = await import("../src/adapter-server-options");
		const installed = await import("../src/installed-adapter-server-options");
		const cliSource = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
		const baseSource = readFileSync(join(ROOT, "src", CLI_MODULES[0]), "utf8");
		const installedSource = readFileSync(join(ROOT, "src", CLI_MODULES[1]), "utf8");
		const serverSource = readFileSync(join(ROOT, "src", "server-bootstrap.ts"), "utf8");
		const runtimeSingletonLockSource = readFileSync(join(ROOT, "src", "runtime-singleton-lock.ts"), "utf8");
		const runnerSource = readFileSync(join(ROOT, "src/live/gjc-routing-runner.ts"), "utf8");
		const publicSdkRunnerSource = readFileSync(join(ROOT, "src/live/gjc-public-sdk-runner.ts"), "utf8");
		const publicSdkSessionAttachmentSource = readFileSync(
			join(ROOT, "src/live/gjc-public-sdk-session-attachment.ts"),
			"utf8",
		);
		const deploymentSource = readFileSync(join(ROOT, "src/configure/deployment-artifacts.ts"), "utf8");
		const cliImports = relativeImports(cliSource);
		const baseImports = relativeImports(baseSource);
		const installedImports = relativeImports(installedSource);
		const serverImports = relativeImports(serverSource);
		const runtimeSingletonLockImports = relativeImports(runtimeSingletonLockSource);

		// When: runtime edges and forbidden reverse edges are inspected.
		const graph = {
			cliToBase: cliImports.includes("./adapter-server-options"),
			cliToInstalled: cliImports.includes("./installed-adapter-server-options"),
			installedToBase: installedImports.includes("./adapter-server-options"),
			baseToFacade: baseImports.includes("./cli"),
			baseToInstalled: baseImports.includes("./installed-adapter-server-options"),
			installedToFacade: installedImports.includes("./cli"),
			serverToRuntimeSingletonLock: serverImports.includes("./runtime-singleton-lock"),
			serverToCliOrConfigurationInternals: serverImports.some(importPath =>
				[
					"./adapter-server-options",
					"./cli",
					"./config",
					"./config-env",
					"./installed-adapter-server-options",
				].includes(importPath),
			),
			runtimeSingletonLockToAdapterRouterOrCli: runtimeSingletonLockImports.some(importPath =>
				/\/?(?:adapter|router|cli)(?:[-/]|$)/.test(importPath),
			),
			resolvedServerChain:
				baseSource.includes("buildResolvedAdapterServerOptions(loadAdapterConfig(env), dependencies)") &&
				cliSource.includes("buildResolvedInstalledAdapterServerOptions(config)") &&
				installedSource.includes("buildResolvedAdapterServerOptions(config") &&
				baseSource.includes("createPublicSdkGjcTurnRunner({") &&
				runnerSource.includes('from "./gjc-public-sdk-runner"') &&
				publicSdkRunnerSource.includes('from "./gjc-public-sdk-session-ops"') &&
				publicSdkSessionAttachmentSource.includes("new CliLifecycleBackend(") &&
				publicSdkSessionAttachmentSource.includes("new PublicSdkSessionClient()"),
			resolvedDeploymentChain:
				deploymentSource.includes("renderResolvedManagedCompose({") &&
				deploymentSource.includes("renderResolvedSystemdComposeUnit({") &&
				deploymentSource.includes("renderResolvedExistingSystemdUnit({"),
			forbiddenProductionWrapperCalls:
				new RegExp(`\\b${retiredRuntimeFactory}\\(`).test(baseSource) ||
				/\bbuildAdapterServerOptions\(config/.test(installedSource) ||
				/await buildInstalledAdapterServerOptions\(config\)/.test(cliSource) ||
				/\brender(?:ManagedCompose|SystemdComposeUnit|ExistingSystemdUnit)\(\{/.test(deploymentSource),
			ownedRuntimeExports: [Object.keys(base).sort(), Object.keys(installed).sort()],
		};

		// Then: the CLI chain is facade to installed to base; server reaches the dedicated runtime lock without CLI/config internals.
		expect(graph).toEqual({
			cliToBase: true,
			cliToInstalled: true,
			installedToBase: true,
			baseToFacade: false,
			baseToInstalled: false,
			installedToFacade: false,
			serverToRuntimeSingletonLock: true,
			serverToCliOrConfigurationInternals: false,
			runtimeSingletonLockToAdapterRouterOrCli: false,
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
