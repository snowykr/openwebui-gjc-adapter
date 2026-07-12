import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentRuntime } from "./deployment-runtime";
import type { FileSnapshot } from "./file-snapshots";
import type { CliDependencies } from "./installed-cli-contracts";
import { renderManagedCompose } from "./managed-compose";
import type { InstalledConfig } from "./private-config";
import { renderExistingSystemdUnit, renderSystemdComposeUnit, routeControllerUnitName } from "./systemd";

export interface DeploymentArtifacts {
	readonly path: string;
	readonly directory: string;
	readonly composeFile: string;
	readonly unitFile: string;
	readonly userUnitDirectory: string;
	readonly sourceRoot: string;
	readonly snapshots?: readonly FileSnapshot[];
}

type StageInput = {
	readonly artifacts: DeploymentArtifacts;
	readonly config: InstalledConfig;
	readonly uiPort: number;
	readonly managedDocker: CliDependencies["managedDocker"];
};

export function stageDeploymentArtifacts(input: StageInput): void {
	const { artifacts, config } = input;
	mkdirSync(artifacts.directory, { recursive: true, mode: 0o700 });
	writeFileSync(`${artifacts.directory}/adapter-token`, `${config.adapterToken}\n`, { mode: 0o600 });
	chmodSync(`${artifacts.directory}/adapter-token`, 0o600);
	if (config.mode === "managed") {
		const dockerBinary = Bun.which("docker", { PATH: process.env.PATH });
		if (!dockerBinary && input.managedDocker === undefined)
			throw new Error("Docker executable is not available on PATH");
		for (const runtimePath of ["state", "session", "workspace"])
			mkdirSync(join(artifacts.directory, runtimePath), { recursive: true, mode: 0o700 });
		const compose = renderManagedCompose({
			openWebUIImage: process.env.GJC_OPENWEBUI_IMAGE ?? "ghcr.io/open-webui/open-webui:v0.10.0",
			adapterImage: process.env.GJC_ADAPTER_IMAGE ?? "openwebui-gjc-adapter:local",
			openWebUIPort: input.uiPort,
			configDirectory: artifacts.directory,
			configFile: artifacts.path,
			uid: typeof process.getuid === "function" ? process.getuid() : 1000,
			gid: typeof process.getgid === "function" ? process.getgid() : 1000,
			projectName: "openwebui-gjc-adapter",
		});
		writeFileSync(artifacts.composeFile, compose, { mode: 0o600 });
		writeFileSync(
			artifacts.unitFile,
			renderSystemdComposeUnit({
				workingDirectory: artifacts.directory,
				composeFile: artifacts.composeFile,
				name: "openwebui-gjc-adapter",
				dockerBinary: dockerBinary ?? "docker",
			}),
			{ mode: 0o600 },
		);
		mkdirSync(artifacts.userUnitDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(artifacts.userUnitDirectory, "openwebui-gjc-adapter.service"),
			readFileSync(artifacts.unitFile),
			{ mode: 0o600 },
		);
		return;
	}
	writeFileSync(
		artifacts.unitFile,
		renderExistingSystemdUnit({
			workingDirectory: artifacts.directory,
			name: "openwebui-gjc-adapter-existing",
			adapterCommand: [process.execPath, join(artifacts.sourceRoot, "cli.ts"), "serve", "--config", artifacts.path],
		}),
		{ mode: 0o600 },
	);
	mkdirSync(artifacts.userUnitDirectory, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(artifacts.userUnitDirectory, "openwebui-gjc-adapter-existing.service"),
		readFileSync(artifacts.unitFile),
		{ mode: 0o600 },
	);
}

export function commitDeploymentArtifacts(input: {
	readonly artifacts: DeploymentArtifacts;
	readonly runtime: DeploymentRuntime;
	readonly priorMode: "managed" | "existing";
	readonly targetMode: "managed" | "existing";
}): void {
	if (input.priorMode === input.targetMode) return;
	const failures: Error[] = [];
	for (const action of ["stop", "disable"] as const) {
		try {
			input.runtime.run(["systemctl", "--user", action, routeControllerUnitName(input.priorMode)]);
		} catch (error) {
			failures.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (failures.length > 0)
		throw new Error(
			`failed to retire prior ${input.priorMode} controller: ${failures.map(error => error.message).join("; ")}`,
		);
	rmSync(join(input.artifacts.userUnitDirectory, routeControllerUnitName(input.priorMode)), { force: true });
	if (input.priorMode === "managed") rmSync(input.artifacts.composeFile, { force: true });
}

export function rollbackDeploymentArtifacts(input: {
	readonly snapshots: readonly FileSnapshot[];
	readonly restore: (snapshots: readonly FileSnapshot[]) => void;
}): void {
	input.restore(input.snapshots);
}
