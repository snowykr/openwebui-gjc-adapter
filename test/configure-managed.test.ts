import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	checkManagedComposePrerequisites,
	managedAdapterImagePlan,
	renderManagedCompose,
} from "../src/configure/managed-compose";
import { renderSystemdComposeUnit } from "../src/configure/systemd";

describe("managed installation rendering and preflight", () => {
	test("ships every Docker build input in the packed package whitelist", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files?: string[] };
		expect(pkg.files).toEqual(expect.arrayContaining(["src", "bin", "Dockerfile.adapter", "bun.lock"]));
		expect(pkg.files).not.toContain("patches");
	});
	test("keeps the adapter private and loopback-only UI publishing", () => {
		const compose = renderManagedCompose({
			openWebUIImage: "ghcr.io/open-webui/open-webui:main",
			adapterImage: "adapter:test",
		});
		expect(compose).toContain('expose:\n      - "8765"');
		expect(compose).toContain('ports:\n      - "127.0.0.1:8080:8080"');
		expect(compose).toContain("GJC_OPENWEBUI_BIND_HOST: 0.0.0.0");
		expect(compose).toContain("GJC_OPENWEBUI_ADAPTER_API_TOKEN_FILE: /run/secrets/adapter-token");
		expect(compose).toContain("GJC_OPENWEBUI_STATE_PATH: /var/lib/gjc");
		expect(compose).toContain("GJC_OPENWEBUI_SESSION_ROOT: /run/gjc-session");
		expect(compose).toContain("GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: /workspace");
		expect(compose).toContain('command: ["serve", "--config", "/run/openwebui-gjc-adapter/config.json"]');
		expect(compose).toContain("./config/config.json:/run/openwebui-gjc-adapter/config.json:ro");
		expect(compose).toContain("./config/state:/var/lib/gjc");
		expect(compose).toContain("./config/session:/run/gjc-session");
		expect(compose).toContain("./config/workspace:/workspace");
		expect(compose).toContain("adapter-token:\n    file: ./config/adapter-token");
		expect(compose).toContain('      ENABLE_API_KEYS: "true"');
		expect(compose).toContain('      ENABLE_OLLAMA_API: "false"');
		expect(compose).not.toContain("ENABLE_API_KEY: ");
		expect(compose).not.toContain('"0.0.0.0:');
		expect(compose).not.toContain("ADAPTER_TOKEN=");
		expect(compose.slice(0, compose.indexOf("  openwebui:"))).not.toContain("\n    ports:");
	});
	test("allows an explicit valid UI port", () => {
		expect(
			renderManagedCompose({ openWebUIImage: "webui:test", adapterImage: "adapter:test", openWebUIPort: 9090 }),
		).toContain("127.0.0.1:9090:8080");
	});
	test("provisions the adapter from the checked-in Dockerfile", () => {
		expect(managedAdapterImagePlan("adapter:test", "Dockerfile.adapter", ".").build).toEqual([
			"docker",
			["build", "--file", "Dockerfile.adapter", "--tag", "adapter:test", "."],
		]);
	});
	test("Dockerfile uses the package root as its build context and published runtime dependencies", () => {
		const dockerfile = readFileSync(new URL("../Dockerfile.adapter", import.meta.url), "utf8");
		expect(dockerfile).toContain("COPY package.json bun.lock ./");
		expect(dockerfile).toContain("bun install --frozen-lockfile --production");
		expect(dockerfile).toContain("GJC_OPENWEBUI_GJC_COMMAND=/opt/openwebui-gjc-adapter/node_modules/.bin/gjc");
		expect(dockerfile).not.toContain("COPY patches");
		expect(dockerfile).not.toContain("gjc-builder");
		expect(dockerfile).toContain("COPY src ./src");
		expect(dockerfile).toContain("COPY bin ./bin");
		expect(dockerfile).toContain("USER adapter:adapter");
		expect(dockerfile).not.toContain("/app/bin");
	});

	test("checks rootful and no-remap requirements through an injected docker runner", async () => {
		const calls: string[][] = [];
		const docker = {
			run: async (command: string, args: readonly string[]) => {
				calls.push([command, ...args]);
				return { exitCode: 0, stdout: '["name=seccomp","cgroupns"] "/var/lib/docker"', stderr: "" };
			},
		};
		await expect(checkManagedComposePrerequisites({ docker })).resolves.toEqual({
			rootful: true,
			usernsRemapDisabled: true,
			passed: true,
			failures: [],
		});
		expect(calls).toEqual([["docker", "info", "--format", "{{json .SecurityOptions}} {{json .DockerRootDir}}"]]);
	});

	test("reports Docker's named rootless and userns security options", async () => {
		const docker = {
			run: async () => ({
				exitCode: 0,
				stdout: '["name=rootless","name=userns"] "/var/lib/docker"',
				stderr: "",
			}),
		};
		await expect(checkManagedComposePrerequisites({ docker })).resolves.toMatchObject({
			rootful: false,
			usernsRemapDisabled: false,
			passed: false,
			failures: ["Docker rootless mode is not supported", "Docker user namespace remapping is not supported"],
		});
	});

	test("places systemd lifecycle directives on the compose controller unit", () => {
		const unit = renderSystemdComposeUnit({
			workingDirectory: "/srv/openwebui",
			composeFile: "/srv/openwebui/compose.yml",
		});
		expect(unit).toContain("StartLimitIntervalSec=5min");
		expect(unit).toContain("Type=simple");
		expect(unit).toContain(
			"ExecStart=/usr/bin/docker compose -f /srv/openwebui/compose.yml -p openwebui-gjc-adapter up",
		);
		expect(unit).toContain(
			"ExecStop=/usr/bin/docker compose -f /srv/openwebui/compose.yml -p openwebui-gjc-adapter down",
		);
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("RestartSec=5s");
		expect(unit.indexOf("Restart=always")).toBeGreaterThan(unit.indexOf("[Service]"));
		expect(unit.indexOf("Restart=always")).toBeLessThan(unit.indexOf("[Install]"));
	});
});
