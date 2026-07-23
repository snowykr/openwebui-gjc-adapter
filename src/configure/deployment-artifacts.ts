import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { DeploymentRuntime } from "./deployment-runtime";
import type { FileSnapshot } from "./file-snapshots";
import type { CliDependencies } from "./installed-cli-contracts";
import { renderResolvedManagedCompose } from "./managed-compose";
import type { InstalledConfig } from "./private-config";
import { resolveGjcRuntimeLocations } from "./runtime-locations";
import {
	renderResolvedExistingSystemdUnit,
	renderResolvedSystemdComposeUnit,
	routeControllerUnitName,
} from "./systemd";

const MAX_PLATFORM_ID = 4_294_967_294;

class ManagedOwnershipError extends Error {
	readonly name = "ManagedOwnershipError";
}

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
	const runtimeLocations =
		config.mode === "managed"
			? resolveGjcRuntimeLocations({ mode: "managed" })
			: resolveGjcRuntimeLocations({ mode: "existing", installedConfig: config });
	const ownership =
		config.mode === "managed" ? managedOwnership(readManagedCompose(artifacts.composeFile)) : undefined;
	mkdirSync(artifacts.directory, { recursive: true, mode: 0o700 });
	writeFileSync(`${artifacts.directory}/adapter-token`, `${config.adapterToken}\n`, { mode: 0o600 });
	chmodSync(`${artifacts.directory}/adapter-token`, 0o600);
	if (config.mode === "managed") {
		const dockerBinary = Bun.which("docker", { PATH: process.env.PATH });
		if (!dockerBinary && input.managedDocker === undefined)
			throw new Error("Docker executable is not available on PATH");
		for (const runtimePath of ["state", "session", "workspace"])
			mkdirSync(join(artifacts.directory, runtimePath), { recursive: true, mode: 0o700 });
		for (const runtimePath of [
			runtimeLocations.agentDir,
			runtimeLocations.readerWorkspace,
			runtimeLocations.readerSessionRoot,
		])
			mkdirSync(join(artifacts.directory, "state", relative("/var/lib/gjc", runtimePath)), {
				recursive: true,
				mode: 0o700,
			});
		const selectedOwnership =
			ownership ??
			validatedOwnership(
				typeof process.getuid === "function" ? process.getuid() : 1000,
				typeof process.getgid === "function" ? process.getgid() : 1000,
			);
		const compose = renderResolvedManagedCompose({
			openWebUIImage: process.env.GJC_OPENWEBUI_IMAGE ?? "ghcr.io/open-webui/open-webui:v0.10.0",
			adapterImage: process.env.GJC_ADAPTER_IMAGE ?? "openwebui-gjc-adapter:local",
			openWebUIPort: input.uiPort,
			configDirectory: artifacts.directory,
			configFile: artifacts.path,
			uid: selectedOwnership.uid,
			gid: selectedOwnership.gid,
			projectName: "openwebui-gjc-adapter",
			runtimeLocations,
		});
		writeManagedCompose(artifacts.composeFile, compose);
		writeFileSync(
			artifacts.unitFile,
			renderResolvedSystemdComposeUnit({
				workingDirectory: artifacts.directory,
				composeFile: artifacts.composeFile,
				name: "openwebui-gjc-adapter",
				dockerBinary: dockerBinary ?? "docker",
				runtimeLocations,
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
		renderResolvedExistingSystemdUnit({
			workingDirectory: artifacts.directory,
			name: "openwebui-gjc-adapter-existing",
			adapterCommand: [process.execPath, join(artifacts.sourceRoot, "cli.ts"), "serve", "--config", artifacts.path],
			gjcCommand: join(dirname(artifacts.sourceRoot), "node_modules", ".bin", "gjc"),
			executableSearchPath: [
				dirname(process.execPath),
				process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			].join(":"),
			runtimeLocations,
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

function readManagedCompose(composeFile: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(composeFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		if (isErrno(error, "ELOOP"))
			throw new ManagedOwnershipError("managed Compose artifact must be a regular file or absent");
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile())
			throw new ManagedOwnershipError("managed Compose artifact must be a regular file or absent");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

function managedOwnership(compose: string | undefined): { readonly uid: number; readonly gid: number } | undefined {
	if (compose === undefined) return undefined;
	let servicesSections = 0;
	let adapterSections = 0;
	let inServices = false;
	let currentService: string | undefined;
	const adapterUsers: string[] = [];
	for (const line of compose.split("\n")) {
		if (line === "services:") {
			servicesSections += 1;
			inServices = true;
			currentService = undefined;
			continue;
		}
		if (/^[^\s]/.test(line)) {
			inServices = false;
			currentService = undefined;
		}
		const service = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
		if (inServices && servicesSections === 1 && service !== undefined) {
			currentService = service;
			if (service === "adapter") adapterSections += 1;
			continue;
		}
		const user = /^ {4}user:\s*(.*?)\s*$/.exec(line)?.[1];
		if (currentService === "adapter" && user !== undefined) adapterUsers.push(user);
	}
	const adapterUser = adapterUsers.length === 1 ? adapterUsers[0] : undefined;
	const match = adapterUser === undefined ? null : /^"(0|[1-9][0-9]*):(0|[1-9][0-9]*)"$/.exec(adapterUser);
	if (servicesSections !== 1 || adapterSections !== 1 || match?.[1] === undefined || match[2] === undefined)
		throw new ManagedOwnershipError("managed adapter ownership must be exactly one numeric UID:GID pair");
	return validatedOwnership(Number(match[1]), Number(match[2]));
}

function validatedOwnership(uid: number, gid: number): { readonly uid: number; readonly gid: number } {
	if (
		!Number.isSafeInteger(uid) ||
		!Number.isSafeInteger(gid) ||
		uid < 0 ||
		gid < 0 ||
		uid > MAX_PLATFORM_ID ||
		gid > MAX_PLATFORM_ID
	)
		throw new ManagedOwnershipError("managed adapter ownership must use supported numeric UID:GID values");
	return { uid, gid };
}

function writeManagedCompose(path: string, value: string): void {
	const temporary = join(dirname(path), `.compose.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let created = false;
	let renamed = false;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		created = true;
		try {
			writeFileSync(fd, value);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		renamed = true;
	} finally {
		if (created && !renamed) rmSync(temporary, { force: true });
	}
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
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
