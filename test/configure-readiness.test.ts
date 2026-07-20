import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledConfig } from "../src/configure/private-config";
import type { GjcRuntimeLocations } from "../src/contracts";
import { buildHealthReport, buildReadinessReport } from "../src/health";

type RuntimeLocationInput =
	| { readonly mode: "managed" }
	| {
			readonly mode: "existing";
			readonly serviceHome: string;
			readonly installedConfig?: Readonly<Pick<InstalledConfig, "gjcConfigDirName" | "gjcCodingAgentDir">>;
			readonly environment?: Readonly<Record<string, string | undefined>>;
	  };

function isRuntimeLocationResolver(value: unknown): value is (input: RuntimeLocationInput) => GjcRuntimeLocations {
	return typeof value === "function";
}

async function resolveRuntimeLocations(input: RuntimeLocationInput): Promise<GjcRuntimeLocations> {
	const candidate = Reflect.get(await import("../src/config"), "resolveGjcRuntimeLocations");
	if (!isRuntimeLocationResolver(candidate)) throw new Error("runtime location resolver is not exported");
	return candidate(input);
}

describe("readiness behavior", () => {
	test("resolves and freezes managed runtime constants", async () => {
		// Given: managed mode, which owns fixed runtime locations.
		// When: the runtime locations are resolved.
		const locations = await resolveRuntimeLocations({ mode: "managed" });
		// Then: only the approved four paths are protected and every view is immutable.
		expect(locations).toEqual({
			home: "/var/lib/gjc/home",
			configDomain: "/var/lib/gjc/home/.gjc",
			agentDir: "/var/lib/gjc/home/.gjc/agent",
			readerWorkspace: "/var/lib/gjc/home/.gjc/openwebui/default-reader",
			readerSessionRoot: "/var/lib/gjc/home/.gjc/openwebui/default-reader/.gjc/sessions",
			protectedProjectPaths: [
				"/var/lib/gjc/home/.gjc",
				"/var/lib/gjc/home/.gjc/agent",
				"/var/lib/gjc/home/.gjc/openwebui/default-reader",
				"/var/lib/gjc/home/.gjc/openwebui/default-reader/.gjc/sessions",
			],
			childEnvironment: {
				HOME: "/var/lib/gjc/home",
				GJC_CONFIG_DIR: ".gjc",
				GJC_CODING_AGENT_DIR: "/var/lib/gjc/home/.gjc/agent",
			},
		});
		expect(Object.isFrozen(locations)).toBe(true);
		expect(Object.isFrozen(locations.protectedProjectPaths)).toBe(true);
		expect(Object.isFrozen(locations.childEnvironment)).toBe(true);
	});

	test("uses installed direct fields before adapter-namespaced environment values", async () => {
		// Given: valid installed fields and conflicting adapter-owned and ambient variables.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "gjc-runtime-precedence-")));
		const installedAgent = join(home, "installed-agent");
		const environmentAgent = join(home, "environment-agent");
		mkdirSync(installedAgent);
		mkdirSync(environmentAgent);
		try {
			// When: direct locations are resolved.
			const locations = await resolveRuntimeLocations({
				mode: "existing",
				serviceHome: home,
				installedConfig: { gjcConfigDirName: ".installed-gjc", gjcCodingAgentDir: installedAgent },
				environment: {
					GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME: ".environment-gjc",
					GJC_OPENWEBUI_GJC_CODING_AGENT_DIR: environmentAgent,
					GJC_CONFIG_DIR: ".ambient-gjc",
					PI_CONFIG_DIR: ".ambient-pi",
					GJC_CODING_AGENT_DIR: join(home, "ambient-agent"),
				},
			});
			// Then: installed values win and ambient values never enter the object.
			expect(locations.configDomain).toBe(join(home, ".installed-gjc"));
			expect(locations.agentDir).toBe(installedAgent);
			expect(JSON.stringify(locations)).not.toContain("ambient");
			expect(JSON.stringify(locations)).not.toContain("environment-gjc");
			expect(locations.protectedProjectPaths).toHaveLength(4);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("uses adapter-namespaced direct environment before direct defaults", async () => {
		// Given: no installed path fields and valid namespaced environment values.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "gjc-runtime-environment-")));
		const agent = join(home, "safe-agent-sibling");
		mkdirSync(agent);
		try {
			// When: direct locations are resolved.
			const locations = await resolveRuntimeLocations({
				mode: "existing",
				serviceHome: home,
				environment: {
					GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME: ".named-gjc",
					GJC_OPENWEBUI_GJC_CODING_AGENT_DIR: agent,
				},
			});
			// Then: namespaced values are selected and the safe explicit sibling remains untouched.
			expect(locations.configDomain).toBe(join(home, ".named-gjc"));
			expect(locations.agentDir).toBe(agent);
			expect(existsSync(agent)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("derives and provisions direct defaults only below the service home", async () => {
		// Given: an isolated canonical writable service HOME and no overrides.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "gjc-runtime-defaults-")));
		try {
			// When: direct defaults are resolved.
			const locations = await resolveRuntimeLocations({
				mode: "existing",
				serviceHome: home,
				environment: {
					GJC_CONFIG_DIR: ".ambient-gjc",
					PI_CONFIG_DIR: ".ambient-pi",
					GJC_CODING_AGENT_DIR: join(home, "ambient-agent"),
				},
			});
			// Then: every derived location is canonical, provisioned, and rooted below HOME.
			expect(locations.configDomain).toBe(join(home, ".gjc"));
			expect(locations.agentDir).toBe(join(home, ".gjc", "agent"));
			expect(locations.readerWorkspace).toBe(join(home, ".gjc", "openwebui", "default-reader"));
			expect(locations.readerSessionRoot).toBe(
				join(home, ".gjc", "openwebui", "default-reader", ".gjc", "sessions"),
			);
			for (const path of locations.protectedProjectPaths) expect(realpathSync(path)).toBe(path);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("rejects traversal, Unicode, symlink, and overlapping explicit runtime paths", async () => {
		// Given: isolated direct roots with a symlink and a config-domain directory.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "gjc-runtime-invalid-")));
		const target = join(home, "agent-target");
		const symlink = join(home, "agent-symlink");
		const configSymlink = join(home, ".linked-config");
		mkdirSync(target);
		symlinkSync(target, symlink);
		symlinkSync(target, configSymlink);
		try {
			// When/Then: malformed names and unsafe explicit paths are rejected deterministically.
			for (const name of ["../gjc", "a/b", ".", "..", "ＧＪＣ", "gjc\0name"]) {
				await expect(
					resolveRuntimeLocations({
						mode: "existing",
						serviceHome: home,
						installedConfig: { gjcConfigDirName: name },
					}),
				).rejects.toThrow("gjcConfigDirName must be a safe directory name");
			}
			await expect(
				resolveRuntimeLocations({
					mode: "existing",
					serviceHome: home,
					installedConfig: { gjcCodingAgentDir: symlink },
				}),
			).rejects.toThrow("gjcCodingAgentDir must be a canonical existing writable directory");
			await expect(
				resolveRuntimeLocations({
					mode: "existing",
					serviceHome: home,
					installedConfig: { gjcConfigDirName: ".linked-config" },
				}),
			).rejects.toThrow("configDomain must be a canonical existing writable directory");
			expect(existsSync(join(target, "agent"))).toBe(false);
			mkdirSync(join(home, ".gjc"));
			await expect(
				resolveRuntimeLocations({
					mode: "existing",
					serviceHome: home,
					installedConfig: { gjcCodingAgentDir: join(home, ".gjc") },
				}),
			).rejects.toThrow("gjcCodingAgentDir must not overlap derived GJC runtime locations");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("reports a typed lifecycle failure for a nonexistent explicit agent directory", async () => {
		// Given: a canonical service HOME and an explicit directory that does not exist.
		const home = realpathSync(mkdtempSync(join(tmpdir(), "gjc-runtime-readiness-")));
		try {
			const configModule = await import("../src/config");
			const candidate = Reflect.get(configModule, "resolveGjcRuntimeLocations");
			if (typeof candidate !== "function") throw new Error("runtime location resolver is not exported");
			const missingAgent = join(home, "missing-agent");
			// When: readiness resolves the explicit location.
			const run = () =>
				candidate({
					mode: "existing",
					serviceHome: home,
					installedConfig: { gjcCodingAgentDir: missingAgent },
				});
			// Then: it fails with the typed lifecycle error before creating that directory.
			expect(run).toThrow(
				expect.objectContaining({ name: "GjcRuntimeLocationError", code: "gjc_runtime_location_invalid" }),
			);
			expect(run).toThrow("gjcCodingAgentDir must be a canonical existing writable directory");
			expect(existsSync(missingAgent)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("is ready only when authentication and prompt seed are both complete", () => {
		expect(
			buildReadinessReport({
				openWebUIAuthenticated: true,
				promptHintsSeeded: true,
				mode: "managed",
				generation: "gen-1",
				model: "model-1",
			}),
		).toEqual({
			status: "ready",
			service: "openwebui-gjc-adapter",
			identity: { mode: "managed" },
			generation: "gen-1",
			model: "model-1",
			seed: { promptHints: "ready" },
		});
		expect(
			buildReadinessReport({ openWebUIAuthenticated: false, promptHintsSeeded: true, mode: "existing" }).status,
		).toBe("not_ready");
		expect(buildReadinessReport({ openWebUIAuthenticated: true, promptHintsSeeded: false }).seed).toEqual({
			promptHints: "pending",
		});
	});

	test("keeps optional readiness metadata null and health checks deterministic", () => {
		expect(buildReadinessReport({ openWebUIAuthenticated: false, promptHintsSeeded: false })).toMatchObject({
			identity: { mode: "unknown" },
			generation: null,
			model: null,
		});
		expect(buildHealthReport([{ name: "openwebui", status: "degraded", detail: "unavailable" }])).toEqual({
			status: "degraded",
			service: "openwebui-gjc-adapter",
			checks: [{ name: "openwebui", status: "degraded", detail: "unavailable" }],
		});
	});
});
