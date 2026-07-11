import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { loadInstalledAdapterConfig } from "../config";
import type { AdapterServerHandle } from "../server";
import {
	type BootstrapPhase,
	type BootstrapState,
	type BootstrapStateStore,
	type PendingRecoveryRecord,
	parseBootstrapState,
	resetBootstrapState,
} from "./bootstrap-state";
import { canDisplaySecret, displayAdapterToken, generateAdapterToken, readSecretRecordFromFd } from "./credentials";
import { CliUsageError, parseCliArguments } from "./grammar";
import {
	type CommandRunner,
	checkManagedComposePrerequisites,
	managedAdapterImagePlan,
	renderManagedCompose,
} from "./managed-compose";
import { configureOpenWebUI } from "./openwebui-setup";
import { runPhaseAwareDeployment } from "./orchestrator";
import {
	acquireConfigLock,
	acquireRouteLock,
	canonicalizeUrl,
	DEFAULT_EXISTING_PROJECT_ROOT,
	defaultConfigPath,
	type InstalledConfig,
	prepareExistingProjectRoot,
	readInstalledConfig,
	rejectProjectRootArtifactOverlap,
	validateInstalledConfig,
	writeInstalledConfig,
} from "./private-config";
import { renderExistingSystemdUnit, renderSystemdComposeUnit, routeControllerUnitName } from "./systemd";

export interface DeploymentResult {
	readonly completed: true;
	readonly mode: "managed" | "existing" | "reset";
}
export interface ResetRequest {
	readonly priorMode: "managed" | "existing";
	readonly targetMode: "managed" | "existing";
	readonly proof: { readonly evidence: string; readonly failedPhase?: BootstrapPhase };
}
export interface DeploymentLifecycle {
	managed(input: {
		config: InstalledConfig;
		adminEmail: string;
		adminPassword: string;
		uiPort: number;
		recovery?: { readonly controllerRecoveryRequired: boolean; readonly controllerQuiesced?: boolean };
	}): Promise<DeploymentResult> | DeploymentResult;
	existing(input: {
		config: InstalledConfig;
		validation?: { readonly apiKey: string; readonly ownerUserId: string };
	}): Promise<DeploymentResult> | DeploymentResult;
	validateExisting?(input: {
		config: InstalledConfig;
	}):
		| Promise<{ readonly apiKey: string; readonly ownerUserId: string }>
		| { readonly apiKey: string; readonly ownerUserId: string };
	reset(input: ResetRequest): Promise<DeploymentResult> | DeploymentResult;
}
export interface CliDependencies {
	readonly stdout?: { write(value: string): boolean; isTTY?: boolean };
	readonly stderr?: { write(value: string): boolean };
	readonly stdin?: NodeJS.ReadStream;
	readonly terminal?: { readonly input: NodeJS.ReadStream; readonly output: NodeJS.WriteStream };
	readonly managedDocker?: CommandRunner;
	readonly startServer?: (
		config: ReturnType<typeof loadInstalledAdapterConfig>,
	) => AdapterServerHandle | Promise<AdapterServerHandle>;
	readonly deployment?: unknown;
	readonly systemctl?: (args: readonly string[]) => string | undefined;
	readonly probeManagedAdapter?: (composeFile: string) => void | Promise<void>;
	readonly managedReadinessDelayMs?: number;
	/** Used only by credentials show; the callback must implement the exact confirmation phrase. */
	readonly confirmAdapterToken?: (token: string) => Promise<boolean> | boolean;
	readonly confirmReset?: (mode: "managed" | "existing", proof: string) => Promise<boolean> | boolean;
	readonly configureOpenWebUI?: typeof configureOpenWebUI;
}
async function confirmOnControllingTty(
	phrase: string,
	input?: NodeJS.ReadStream,
	output?: NodeJS.WriteStream,
): Promise<boolean> {
	let ownsTerminal = false;
	if (!input || !output) {
		const inputFd = openSync("/dev/tty", "r");
		let outputFd: number;
		try {
			outputFd = openSync("/dev/tty", "w");
		} catch (error) {
			closeSync(inputFd);
			throw error;
		}
		input = new TtyReadStream(inputFd);
		output = new TtyWriteStream(outputFd);
		ownsTerminal = true;
	}
	try {
		if (!canDisplaySecret(input, output)) return false;
		const prompt = createInterface({ input, output });
		const answer = await prompt.question(`Type exactly "${phrase}" to continue: `);
		prompt.close();
		return answer === phrase;
	} catch {
		return false;
	} finally {
		if (ownsTerminal) {
			input.destroy();
			output.destroy();
		}
	}
}
async function probeAdapter(config: InstalledConfig): Promise<void> {
	const target = `http://${config.bindHost === "0.0.0.0" ? "127.0.0.1" : config.bindHost}:${config.bindPort}/readyz`;
	const response = await fetch(target, { headers: { authorization: `Bearer ${config.readinessToken}` } });
	if (!response.ok) throw new Error(`adapter is not ready (${response.status})`);
}
async function waitForAdapterReady(probe: () => void | Promise<void>, attempts = 10, delayMs = 250): Promise<void> {
	let failure: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await probe();
			return;
		} catch (error) {
			failure = error;
			if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
		}
	}
	throw failure;
}
function probeManagedAdapter(composeFile: string): void {
	const script =
		'const config = JSON.parse(await Bun.file("/run/openwebui-gjc-adapter/config.json").text()); const response = await fetch("http://127.0.0.1:8765/readyz", { headers: { authorization: `Bearer $' +
		"{config.readinessToken}` } }); if (!response.ok) process.exit(1);";
	try {
		execFileSync(
			"docker",
			["compose", "-f", composeFile, "-p", "openwebui-gjc-adapter", "exec", "-T", "adapter", "bun", "-e", script],
			{ stdio: "pipe" },
		);
	} catch (error) {
		const detail =
			error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
		throw new Error(`adapter is not ready${detail ? ` (${detail})` : ""}`);
	}
}
type FileSnapshot = {
	readonly path: string;
	readonly content?: Buffer;
	readonly mode?: number;
	readonly directory?: boolean;
	readonly symlink?: string;
};
function snapshotFiles(paths: readonly string[]): FileSnapshot[] {
	const snapshots: FileSnapshot[] = [];
	for (const filePath of paths) {
		try {
			const stat = lstatSync(filePath);
			if (stat.isSymbolicLink())
				throw new Error(`deployment artifact must be a regular file or absent: ${filePath}`);
			else if (stat.isDirectory())
				throw new Error(`deployment artifact must be a regular file or absent: ${filePath}`);
			else if (stat.isFile())
				snapshots.push({ path: filePath, content: readFileSync(filePath), mode: stat.mode & 0o777 });
			else throw new Error(`unsupported snapshot file type: ${filePath}`);
		} catch (error) {
			if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				snapshots.push({ path: filePath });
				continue;
			}
			throw error;
		}
	}
	return snapshots;
}
function restoreFiles(snapshots: readonly FileSnapshot[]): void {
	const roots = snapshots
		.filter(snapshot => snapshot.content === undefined && !snapshot.directory && snapshot.symlink === undefined)
		.map(snapshot => snapshot.path);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	const directories = snapshots
		.filter(value => value.directory)
		.filter(
			value =>
				!snapshots.some(
					parent => parent.directory && parent.path !== value.path && value.path.startsWith(`${parent.path}/`),
				),
		);
	for (const directory of directories) rmSync(directory.path, { recursive: true, force: true });
	for (const snapshot of snapshots.filter(value => value.symlink !== undefined || value.content !== undefined))
		rmSync(snapshot.path, { recursive: true, force: true });
	for (const snapshot of snapshots.filter(value => value.directory).sort((a, b) => a.path.length - b.path.length))
		mkdirSync(snapshot.path, { recursive: true, mode: snapshot.mode });
	for (const snapshot of snapshots.filter(value => value.symlink !== undefined)) {
		mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
		const temporary = `${snapshot.path}.${process.pid}.restore`;
		rmSync(temporary, { force: true });
		symlinkSync(snapshot.symlink!, temporary);
		renameSync(temporary, snapshot.path);
	}
	for (const snapshot of snapshots.filter(value => value.content !== undefined)) {
		mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
		const temporary = `${snapshot.path}.${process.pid}.restore`;
		const fd = openSync(temporary, "w", snapshot.mode ?? 0o600);
		try {
			writeFileSync(fd, snapshot.content!);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, snapshot.path);
	}
}
function deploymentSnapshot(path: string, userUnitDirectory: string): FileSnapshot[] {
	return snapshotFiles([
		path,
		`${path}.compose.yml`,
		`${path}.service`,
		`${path}.bootstrap.json`,
		join(dirname(path), "adapter-token"),
		join(userUnitDirectory, "openwebui-gjc-adapter.service"),
		join(userUnitDirectory, "openwebui-gjc-adapter-existing.service"),
	]);
}
const RECOVERY_SNAPSHOT_VERSION = 1;
type DurableSnapshotStatus = "prepared" | "complete";
type DurableSnapshotJournal = {
	readonly status: DurableSnapshotStatus;
	readonly version: 1;
	readonly transactionId: string;
	readonly snapshots: readonly {
		readonly path: string;
		readonly content?: string;
		readonly mode?: number;
		readonly directory?: boolean;
		readonly symlink?: string;
	}[];
};
function recoverySnapshotPath(path: string): string {
	return `${path}.recovery.json`;
}
function assertRecoverySnapshotMode(mode: number): void {
	if (mode !== 0o400 && mode !== 0o600) throw new Error("recovery snapshot file mode must be 0400 or 0600");
}
function assertDeploymentSnapshotSafe(path: string, snapshots: readonly FileSnapshot[]): void {
	const config = snapshots.find(snapshot => snapshot.path === path);
	if (config?.symlink !== undefined || config?.directory === true)
		throw new Error("config artifact must be a regular file or absent");
}
function writeDurableDeploymentSnapshot(path: string, userUnitDirectory: string, transactionId: string): void {
	const snapshots = deploymentSnapshot(path, userUnitDirectory);
	assertDeploymentSnapshotSafe(path, snapshots);
	for (const snapshot of snapshots)
		if (snapshot.content !== undefined && snapshot.mode !== undefined) assertRecoverySnapshotMode(snapshot.mode);
	const journal: DurableSnapshotJournal = {
		version: RECOVERY_SNAPSHOT_VERSION,
		transactionId,
		status: "prepared",
		snapshots: snapshots.map(snapshot => ({
			path: snapshot.path,
			...(snapshot.content === undefined ? {} : { content: snapshot.content.toString("base64") }),
			...(snapshot.symlink === undefined ? {} : { symlink: snapshot.symlink }),
			...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
			...(snapshot.directory === undefined ? {} : { directory: snapshot.directory }),
		})),
	};
	const target = recoverySnapshotPath(path),
		temporary = `${target}.${process.pid}.tmp`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(journal)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, target);
	const directoryFd = openSync(dirname(target), "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}
function readDurableDeploymentSnapshot(
	path: string,
):
	| { readonly transactionId: string; readonly status: DurableSnapshotStatus; readonly snapshots: FileSnapshot[] }
	| undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(recoverySnapshotPath(path), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("journal must be an object");
		const journal = value as Record<string, unknown>;
		if (
			journal.version !== RECOVERY_SNAPSHOT_VERSION ||
			typeof journal.transactionId !== "string" ||
			journal.transactionId.trim().length === 0 ||
			!Array.isArray(journal.snapshots) ||
			(journal.status !== undefined && journal.status !== "prepared" && journal.status !== "complete")
		)
			throw new Error("invalid recovery snapshot");
		const journalKeys = Object.keys(journal).sort().join(",");
		if (journalKeys !== "snapshots,transactionId,version" && journalKeys !== "snapshots,status,transactionId,version")
			throw new Error("recovery snapshot contains unknown fields");
		const userUnitDirectory = join(
			process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
			"systemd",
			"user",
		);
		const expectedPaths = [
			path,
			`${path}.compose.yml`,
			`${path}.service`,
			`${path}.bootstrap.json`,
			join(dirname(path), "adapter-token"),
			join(userUnitDirectory, "openwebui-gjc-adapter.service"),
			join(userUnitDirectory, "openwebui-gjc-adapter-existing.service"),
		];
		const entries = journal.snapshots as readonly unknown[];
		if (entries.length !== expectedPaths.length) throw new Error("recovery snapshot has incorrect entry count");
		const expected = new Set(expectedPaths);
		const seen = new Set<string>();
		const snapshots: FileSnapshot[] = [];
		for (const entry of entries) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry))
				throw new Error("invalid recovery snapshot entry");
			const record = entry as Record<string, unknown>;
			const keys = Object.keys(record);
			if (typeof record.path !== "string" || !expected.has(record.path) || seen.has(record.path))
				throw new Error("recovery snapshot has invalid or duplicate path");
			seen.add(record.path);
			const hasContent = Object.hasOwn(record, "content");
			const hasDirectory = Object.hasOwn(record, "directory");
			const hasSymlink = Object.hasOwn(record, "symlink");
			const type = hasContent ? "content" : hasDirectory ? "directory" : hasSymlink ? "symlink" : "absent";
			const allowedKeys =
				type === "content"
					? ["content", "mode", "path"]
					: type === "directory"
						? ["directory", "mode", "path"]
						: type === "symlink"
							? ["mode", "path", "symlink"]
							: ["path"];
			if (keys.sort().join(",") !== allowedKeys.join(","))
				throw new Error("recovery snapshot entry has unknown or missing fields");
			if ([hasContent, hasDirectory, hasSymlink].filter(Boolean).length > 1)
				throw new Error("recovery snapshot entry has conflicting types");
			if (hasDirectory && record.directory !== true) throw new Error("invalid directory marker");
			if (
				hasSymlink &&
				(typeof record.symlink !== "string" || record.symlink.length === 0 || record.symlink.includes("\0"))
			)
				throw new Error("invalid symlink target");
			if (
				type !== "absent" &&
				(typeof record.mode !== "number" ||
					!Number.isSafeInteger(record.mode) ||
					record.mode < 0 ||
					record.mode > 0o777)
			)
				throw new Error("invalid snapshot mode");
			if (hasContent) assertRecoverySnapshotMode(record.mode as number);
			if (hasDirectory || hasSymlink) throw new Error("deployment artifacts must be regular files or absent");
			if (hasContent) {
				if (
					typeof record.content !== "string" ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.content)
				)
					throw new Error("invalid base64 content");
				const content = Buffer.from(record.content, "base64");
				if (content.toString("base64") !== record.content) throw new Error("non-canonical base64 content");
				if (record.path === path) {
					try {
						validateInstalledConfig(JSON.parse(content.toString("utf8")));
					} catch (error) {
						throw new Error(`invalid captured config: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (record.path === `${path}.bootstrap.json`) {
					try {
						const capturedBootstrap = parseBootstrapState(JSON.parse(content.toString("utf8")));
						if (capturedBootstrap.pendingRecovery !== undefined)
							throw new Error("captured bootstrap state contains nested pending recovery");
					} catch (error) {
						throw new Error(
							`invalid captured bootstrap state: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				snapshots.push({ path: record.path, content, mode: record.mode as number });
			} else if (hasSymlink) {
				snapshots.push({ path: record.path, symlink: record.symlink as string, mode: record.mode as number });
			} else {
				snapshots.push({ path: record.path });
			}
		}
		if (seen.size !== expected.size) throw new Error("recovery snapshot path coverage is incomplete");
		return {
			transactionId: journal.transactionId,
			status: journal.status === "complete" ? "complete" : "prepared",
			snapshots,
		};
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
			return undefined;
		throw new Error(`Malformed recovery snapshot: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function clearDurableDeploymentSnapshot(path: string): void {
	rmSync(recoverySnapshotPath(path), { force: true });
}
function markDurableDeploymentSnapshotComplete(path: string, transactionId: string): void {
	const current = readDurableDeploymentSnapshot(path);
	if (current === undefined) throw new Error("recovery snapshot is missing");
	if (current.transactionId !== transactionId) throw new Error("recovery snapshot transaction IDs do not match");
	if (current.status === "complete") return;
	const value = JSON.parse(readFileSync(recoverySnapshotPath(path), "utf8")) as Record<string, unknown>;
	const target = recoverySnapshotPath(path);
	const temporary = `${target}.${process.pid}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify({ ...value, status: "complete" })}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, target);
	const directoryFd = openSync(dirname(target), "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}
function managedDockerRunner(managedDocker?: CommandRunner): CommandRunner {
	return (
		managedDocker ?? {
			run: async (command: string, args: readonly string[]) => {
				try {
					const stdout = execFileSync(command, [...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
					return { exitCode: 0, stdout, stderr: "" };
				} catch (error) {
					const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
					return {
						exitCode: failure.status ?? 1,
						stdout: String(failure.stdout ?? ""),
						stderr: String(failure.stderr ?? ""),
					};
				}
			},
		}
	);
}
function productionDeployment(
	path: string,
	setupOpenWebUI: typeof configureOpenWebUI = configureOpenWebUI,
	managedDocker?: CommandRunner,
	systemctl?: (args: readonly string[]) => string | undefined,
	managedProbe: (composeFile: string) => void | Promise<void> = probeManagedAdapter,
	managedReadinessDelayMs?: number,
): DeploymentLifecycle {
	const docker = managedDockerRunner(managedDocker);
	const directory = dirname(path),
		composeFile = `${path}.compose.yml`,
		unitFile = `${path}.service`,
		userUnitDirectory = join(
			process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
			"systemd",
			"user",
		);
	const run = (args: string[], env?: NodeJS.ProcessEnv) => {
		if (systemctl && args[0] === "systemctl") systemctl(args);
		else execFileSync(args[0], args.slice(1), { stdio: "inherit", env });
	};
	const runCapture = (args: string[]): string =>
		systemctl && args[0] === "systemctl"
			? String(systemctl(args) ?? "")
			: String(execFileSync(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] }));
	const state: BootstrapStateStore = {
		read: async () => {
			try {
				return parseBootstrapState(JSON.parse(readFileSync(`${path}.bootstrap.json`, "utf8")));
			} catch (error) {
				if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;
				throw new Error(`Malformed bootstrap state: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		write: async value => {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const target = `${path}.bootstrap.json`,
				temporary = `${target}.${process.pid}.tmp`;
			const fd = openSync(temporary, "w", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(value)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, target);
			const directoryFd = openSync(directory, "r");
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
		},
	};
	const http = (config: InstalledConfig) => ({
		request: async <T>(method: string, endpoint: string, body?: unknown, authorization?: string): Promise<T> => {
			const token = authorization ?? config.openWebUIApiToken;
			const attempts = endpoint === "/api/version" ? 10 : 1;
			let failure: unknown;
			for (let attempt = 0; attempt < attempts; attempt++) {
				try {
					const response = await fetch(`${config.openWebUIApiUrl}${endpoint}`, {
						method,
						headers: {
							...(token ? { authorization: `Bearer ${token}` } : {}),
							"content-type": "application/json",
						},
						body: body === undefined ? undefined : JSON.stringify(body),
					});
					if (!response.ok) throw new Error(`OpenWebUI request ${method} ${endpoint} failed (${response.status})`);
					return (await response.json()) as T;
				} catch (error) {
					failure = error;
					if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 500));
				}
			}
			throw failure;
		},
	});
	const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const packageRoot = dirname(sourceRoot);
	const installerUid = typeof process.getuid === "function" ? process.getuid() : 1000;
	const installerGid = typeof process.getgid === "function" ? process.getgid() : 1000;
	const installFiles = (config: InstalledConfig, uiPort: number) => {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(`${directory}/adapter-token`, `${config.adapterToken}\n`, { mode: 0o600 });
		chmodSync(`${directory}/adapter-token`, 0o600);
		if (config.mode === "managed") {
			const dockerBinary = Bun.which("docker", { PATH: process.env.PATH });
			if (!dockerBinary && managedDocker === undefined)
				throw new Error("Docker executable is not available on PATH");
			const adapterImage = process.env.GJC_ADAPTER_IMAGE ?? "openwebui-gjc-adapter:local";
			for (const runtimePath of ["state", "session", "workspace"])
				mkdirSync(join(directory, runtimePath), { recursive: true, mode: 0o700 });
			const compose = renderManagedCompose({
				openWebUIImage: process.env.GJC_OPENWEBUI_IMAGE ?? "ghcr.io/open-webui/open-webui:v0.10.0",
				adapterImage,
				openWebUIPort: uiPort,
				configDirectory: directory,
				configFile: path,
				uid: installerUid,
				gid: installerGid,
				projectName: "openwebui-gjc-adapter",
			});
			writeFileSync(composeFile, compose, { mode: 0o600 });
			writeFileSync(
				unitFile,
				renderSystemdComposeUnit({
					workingDirectory: directory,
					composeFile,
					name: "openwebui-gjc-adapter",
					dockerBinary: dockerBinary ?? "docker",
				}),
				{ mode: 0o600 },
			);
			mkdirSync(userUnitDirectory, { recursive: true, mode: 0o700 });
			writeFileSync(join(userUnitDirectory, "openwebui-gjc-adapter.service"), readFileSync(unitFile), {
				mode: 0o600,
			});
		} else {
			writeFileSync(
				unitFile,
				renderExistingSystemdUnit({
					workingDirectory: directory,
					name: "openwebui-gjc-adapter-existing",
					adapterCommand: [process.execPath, join(sourceRoot, "cli.ts"), "serve", "--config", path],
				}),
				{ mode: 0o600 },
			);
			mkdirSync(userUnitDirectory, { recursive: true, mode: 0o700 });
			writeFileSync(join(userUnitDirectory, "openwebui-gjc-adapter-existing.service"), readFileSync(unitFile), {
				mode: 0o600,
			});
		}
	};
	const runDeployment = async (
		config: InstalledConfig,
		email: string,
		password: string,
		uiPort: number,
		recovery?: { readonly controllerRecoveryRequired: boolean; readonly controllerQuiesced?: boolean },
		validation?: { readonly apiKey: string; readonly ownerUserId: string },
	) => {
		const client = http(config);
		if (config.mode === "managed") {
			installFiles(config, uiPort);
		}
		if (config.mode === "existing") {
			const setup = validation ?? (await validateExisting(config));
			config.ownerUserId = setup.ownerUserId;
			config.openWebUIApiToken = setup.apiKey;
			writeInstalledConfig(config, path);
			installFiles(config, uiPort);
			run(["systemctl", "--user", "daemon-reload"]);
			run(["systemctl", "--user", "enable", "openwebui-gjc-adapter-existing.service"]);
			run(["systemctl", "--user", "restart", "openwebui-gjc-adapter-existing.service"]);
			await waitForAdapterReady(() => probeAdapter(config));
			return;
		}
		installFiles(config, uiPort);
		await runPhaseAwareDeployment({
			state,
			recovery,
			phases: {
				preflight: async () => {
					const image = process.env.GJC_ADAPTER_IMAGE ?? "openwebui-gjc-adapter:local";
					const plan = managedAdapterImagePlan(image, join(packageRoot, "Dockerfile.adapter"), packageRoot);
					const result = await docker.run(plan.build[0], plan.build[1]);
					if (result.exitCode !== 0)
						throw new Error(`docker build failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
				},
				bootstrap: async () => {
					run(["systemctl", "--user", "daemon-reload"]);
					run(["systemctl", "--user", "enable", "--now", "openwebui-gjc-adapter.service"]);
				},
				apiKey: async () => {
					const setup = await setupOpenWebUI({
						http: client,
						state,
						writeCheckpoints: true,
						stopAfter: "api-key",
						maintenance: { begin: async () => {}, end: async () => {} },
						adapterUrl: config.adapterProviderUrl,
						adapterToken: config.adapterToken,
						adminEmail: email,
						adminPassword: password,
						installationId: config.installationId,
						openWebUIApiToken: config.openWebUIApiToken,
						mode: "managed",
					});
					await state.write(setup.state);
					if (config.ownerUserId !== undefined && config.ownerUserId !== setup.ownerUserId)
						throw new Error("OpenWebUI API token belongs to a different owner");
					config.openWebUIApiToken = setup.apiKey;
					config.ownerUserId = setup.ownerUserId;
					writeInstalledConfig(config, path);
					run(["systemctl", "--user", "restart", "openwebui-gjc-adapter.service"]);
					return {
						bootstrapComplete: setup.state.bootstrapComplete,
						apiKeyCreated: setup.state.apiKeyCreated,
						ownerUserId: setup.ownerUserId,
						openWebUIApiToken: setup.apiKey,
					};
				},
				readiness: async () => {
					await waitForAdapterReady(() => managedProbe(composeFile), 10, managedReadinessDelayMs);
				},
				provider: async () => {
					const setup = await setupOpenWebUI({
						http: client,
						state,
						writeCheckpoints: true,
						stopAfter: "provider",
						maintenance: { begin: async () => {}, end: async () => {} },
						adapterUrl: config.adapterProviderUrl,
						adapterToken: config.adapterToken,
						adminEmail: email,
						adminPassword: password,
						installationId: config.installationId,
						openWebUIApiToken: config.openWebUIApiToken,
						mode: "managed",
					});
					if (config.ownerUserId !== undefined && config.ownerUserId !== setup.ownerUserId)
						throw new Error("OpenWebUI API token belongs to a different owner");
					return {
						openAIConfigured: setup.state.openAIConfigured,
						openAIConnectionIds: setup.state.openAIConnectionIds,
						ownerUserId: setup.ownerUserId,
						openWebUIApiToken: setup.apiKey,
					};
				},
			},
		});
	};
	type ControllerState = { readonly enabled: boolean; readonly active: boolean };
	const controllerState = (mode: "managed" | "existing"): ControllerState => {
		const unit = routeControllerUnitName(mode);
		const probe = (action: "is-enabled" | "is-active"): boolean => {
			let output = "";
			try {
				output = runCapture(["systemctl", "--user", action, unit]);
			} catch (error) {
				const stdout =
					error instanceof Error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
				const stderr =
					error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
				output = stdout || stderr;
				if (stderr.trim().length > 0) throw new Error(`failed to probe ${unit} ${action}: ${stderr.trim()}`);
			}
			const state = output.trim();
			const accepted =
				action === "is-enabled"
					? ({
							enabled: true,
							disabled: false,
							static: false,
							indirect: false,
							masked: false,
							generated: false,
							transient: false,
							"not-found": false,
						} as Record<string, boolean>)
					: ({ active: true, inactive: false, failed: false, dead: false, unknown: false } as Record<
							string,
							boolean
						>);
			if (Object.hasOwn(accepted, state)) return accepted[state]!;
			throw new Error(`failed to probe ${unit} ${action}: invalid systemd state ${JSON.stringify(state)}`);
		};
		return { enabled: probe("is-enabled"), active: probe("is-active") };
	};
	let transaction:
		| {
				snapshots: readonly FileSnapshot[];
				previous?: InstalledConfig;
				priorMode: "managed" | "existing";
				controllers: ControllerState;
		  }
		| undefined;
	const transactionFromDisk = (): typeof transaction => {
		const pending = readPendingRecoveryJournal(path);
		const snapshotJournal = readDurableDeploymentSnapshot(path);
		if (pending === undefined && snapshotJournal === undefined) return undefined;
		if (pending === undefined || snapshotJournal === undefined)
			throw new Error("pending recovery and recovery snapshot must be present together");
		if (snapshotJournal.transactionId !== pending.transactionId)
			throw new Error("pending recovery and recovery snapshot transaction IDs do not match");
		const snapshots = snapshotJournal.snapshots;
		const priorConfigSnapshot = snapshots.find(snapshot => snapshot.path === path && snapshot.content !== undefined);
		const previous =
			priorConfigSnapshot?.content === undefined
				? undefined
				: (JSON.parse(priorConfigSnapshot.content.toString("utf8")) as InstalledConfig);
		if (
			previous !== undefined &&
			(previous.mode !== pending.priorMode || previous.installationId !== pending.installationId)
		)
			throw new Error("captured config identity does not match pending recovery");
		return {
			snapshots,
			...(previous === undefined ? {} : { previous }),
			priorMode: pending.priorMode,
			controllers: { enabled: pending.priorControllerEnabled, active: pending.priorControllerActive },
		};
	};
	const rollback = async (tx: typeof transaction, attemptedMode: "managed" | "existing"): Promise<Error[]> => {
		if (!tx) return [];
		const errors: Error[] = [];
		const checkpoint = await state.read();
		const pendingBeforeRollback = tx.previous ? readPendingRecoveryJournal(path) : undefined;
		const bootstrapPath = `${path}.bootstrap.json`;
		const bootstrapBeforeRollback = existsSync(bootstrapPath) ? readFileSync(bootstrapPath) : undefined;
		const attempt = (action: () => void) => {
			try {
				action();
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
		};
		attempt(() => run(["systemctl", "--user", "stop", routeControllerUnitName(attemptedMode)]));
		attempt(() => run(["systemctl", "--user", "disable", routeControllerUnitName(attemptedMode)]));
		// Fresh-install journals contain irreversible signup recovery and must survive.
		// Installed reset journals are part of the prior installation snapshot.
		attempt(() => {
			if (tx.previous) restoreFiles(tx.snapshots);
		});
		if (checkpoint !== undefined && !tx.previous) {
			try {
				await state.write(checkpoint);
			} catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (bootstrapBeforeRollback !== undefined && !tx.previous)
			attempt(() => writeFileSync(bootstrapPath, bootstrapBeforeRollback, { mode: 0o600 }));
		attempt(() => run(["systemctl", "--user", "daemon-reload"]));
		const unit = routeControllerUnitName(tx.priorMode);
		if (tx.controllers.enabled) attempt(() => run(["systemctl", "--user", "enable", unit]));
		if (tx.controllers.active) attempt(() => run(["systemctl", "--user", "start", unit]));
		if (errors.length === 0 && tx.previous) {
			attempt(() => {
				const pending = pendingBeforeRollback;
				if (pending === undefined) throw new Error("rollback recovery journal is missing");
				markDurableDeploymentSnapshotComplete(path, pending.transactionId);
				clearPendingRecoveryJournal(path);
				clearDurableDeploymentSnapshot(path);
			});
		}
		return errors;
	};
	const retirePriorMode = (priorMode: "managed" | "existing", targetMode: "managed" | "existing") => {
		if (priorMode === targetMode) return;
		const failures: Error[] = [];
		for (const action of [
			["stop", routeControllerUnitName(priorMode)],
			["disable", routeControllerUnitName(priorMode)],
		] as const) {
			try {
				run(["systemctl", "--user", action[0], action[1]]);
			} catch (error) {
				failures.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (failures.length)
			throw new Error(
				`failed to retire prior ${priorMode} controller: ${failures.map(error => error.message).join("; ")}`,
			);
		rmSync(join(userUnitDirectory, `${routeControllerUnitName(priorMode)}`), { force: true });
		if (priorMode === "managed") rmSync(composeFile, { force: true });
	};
	const validateExisting = async (config: InstalledConfig) => {
		const setup = await setupOpenWebUI({
			http: http(config),
			state,
			writeCheckpoints: false,
			maintenance: { begin: async () => {}, end: async () => {} },
			adapterUrl: config.adapterProviderUrl,
			adapterToken: config.adapterToken,
			adminEmail: "",
			adminPassword: "",
			installationId: config.installationId,
			openWebUIApiToken: config.openWebUIApiToken,
			mode: "existing",
		});
		if (config.ownerUserId !== undefined && config.ownerUserId !== setup.ownerUserId)
			throw new Error("OpenWebUI API token belongs to a different owner");
		return { apiKey: setup.apiKey, ownerUserId: setup.ownerUserId };
	};
	return {
		validateExisting: async input => validateExisting(input.config),
		managed: async input => {
			const pending = readPendingRecoveryJournal(path);
			const priorMode = pending?.priorMode ?? "managed";
			const controllers =
				pending === undefined || !pending.controllerRecoveryRequired
					? controllerState(priorMode)
					: { enabled: pending.priorControllerEnabled, active: pending.priorControllerActive };
			const tx = transaction ??
				transactionFromDisk() ?? {
					snapshots: deploymentSnapshot(path, userUnitDirectory),
					previous: undefined,
					priorMode,
					controllers,
				};
			updatePendingRecoveryJournal(path, {
				controllerRecoveryRequired: true,
				controllerQuiesced: pending?.controllerQuiesced ?? false,
				priorControllerEnabled: tx.controllers.enabled,
				priorControllerActive: tx.controllers.active,
			});
			try {
				await runDeployment(input.config, input.adminEmail, input.adminPassword, input.uiPort, input.recovery);
				retirePriorMode(tx.priorMode, "managed");
				transaction = undefined;
			} catch (error) {
				const rollbackErrors = await rollback(tx, "managed");
				transaction = undefined;
				if (rollbackErrors.length)
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackErrors.map(item => item.message).join("; ")}`,
					);
				throw error;
			}
			return { completed: true, mode: "managed" };
		},
		existing: async input => {
			const pending = readPendingRecoveryJournal(path);
			const priorMode = pending?.priorMode ?? "existing";
			const controllers =
				pending === undefined || !pending.controllerRecoveryRequired
					? controllerState(priorMode)
					: { enabled: pending.priorControllerEnabled, active: pending.priorControllerActive };
			const tx = transaction ??
				transactionFromDisk() ?? {
					snapshots: deploymentSnapshot(path, userUnitDirectory),
					previous: undefined,
					priorMode,
					controllers,
				};
			updatePendingRecoveryJournal(path, {
				controllerRecoveryRequired: true,
				controllerQuiesced: pending?.controllerQuiesced ?? false,
				priorControllerEnabled: tx.controllers.enabled,
				priorControllerActive: tx.controllers.active,
			});
			try {
				await runDeployment(input.config, "", "", 8080, undefined, input.validation);
				retirePriorMode(tx.priorMode, "existing");
				transaction = undefined;
			} catch (error) {
				const rollbackErrors = await rollback(tx, "existing");
				transaction = undefined;
				if (rollbackErrors.length)
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackErrors.map(item => item.message).join("; ")}`,
					);
				throw error;
			}
			return { completed: true, mode: "existing" };
		},
		reset: async input => {
			const evidence = input.proof.evidence;
			if (!evidence.trim()) throw new Error("reset requires proof for the persisted failed phase");
			const pending = readPendingRecoveryJournal(path);
			const resumedRecovery = pending?.controllerRecoveryRequired === true;
			const tx = resumedRecovery
				? transactionFromDisk()
				: (() => {
						const previous = existsSync(path) ? readInstalledConfig(path) : undefined;
						const controllers = controllerState(input.priorMode);
						return {
							snapshots: deploymentSnapshot(path, userUnitDirectory),
							...(previous === undefined ? {} : { previous }),
							priorMode: input.priorMode,
							controllers,
						};
					})();
			if (!tx) throw new Error("reset recovery requires a durable deployment snapshot");
			transaction = tx;
			if (!resumedRecovery) {
				updatePendingRecoveryJournal(path, {
					controllerRecoveryRequired: true,
					controllerQuiesced: false,
					priorControllerEnabled: tx.controllers.enabled,
					priorControllerActive: tx.controllers.active,
				});
			}
			try {
				if (input.priorMode === "managed") {
					const current = await state.read();
					if (!current) throw new Error("reset requires a persisted failed bootstrap phase");
					const failedPhase =
						input.proof.failedPhase ??
						current.failedPhase ??
						(current.phase === "complete" &&
						current.apiKeyCreated &&
						current.ownerUserId !== undefined &&
						current.openWebUIApiToken !== undefined
							? "route"
							: current.phase);
					if (
						failedPhase === undefined ||
						failedPhase === "complete" ||
						(current.phase !== "complete" && failedPhase !== current.phase)
					)
						throw new Error("reset requires proof for the persisted failed phase");
					await state.write(resetBootstrapState(current, failedPhase, { failedPhase, evidence }));
				}
				if (!pending?.controllerQuiesced) {
					const unit = routeControllerUnitName(input.priorMode);
					run(["systemctl", "--user", "stop", unit]);
					run(["systemctl", "--user", "disable", unit]);
				}
				updatePendingRecoveryJournal(path, {
					controllerRecoveryRequired: true,
					controllerQuiesced: true,
					priorControllerEnabled: tx.controllers.enabled,
					priorControllerActive: tx.controllers.active,
				});
				return { completed: true, mode: "reset" };
			} catch (error) {
				const rollbackErrors = await rollback(transaction, input.targetMode);
				transaction = undefined;
				if (rollbackErrors.length)
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackErrors.map(item => item.message).join("; ")}`,
					);
				throw error;
			}
		},
	};
}
export async function runInstalledCli(
	argv: readonly string[] = process.argv.slice(2),
	dependencies: CliDependencies = {},
): Promise<number> {
	const stdout = dependencies.stdout ?? process.stdout,
		stderr = dependencies.stderr ?? process.stderr;
	try {
		const command = parseCliArguments(argv);
		const options = "options" in command ? (command.options ?? {}) : {};
		const path = optionValue(options, "config") ?? defaultConfigPath();
		if (command.kind === "configure") {
			const unlock = acquireConfigLock(path);
			let unlockRoute: (() => void) | undefined;
			try {
				unlockRoute = acquireRouteLock();
				await configure(
					command.mode,
					options,
					path,
					dependencies.deployment
						? (dependencies.deployment as DeploymentLifecycle)
						: productionDeployment(
								path,
								dependencies.configureOpenWebUI,
								dependencies.managedDocker,
								dependencies.systemctl,
								dependencies.probeManagedAdapter,
								dependencies.managedReadinessDelayMs,
							),
					dependencies,
				);
			} finally {
				unlockRoute?.();
				unlock();
			}
			return 0;
		}
		if (command.kind === "credentials-show-adapter-token") {
			const explicitTerminal = dependencies.terminal;
			let input: NodeJS.ReadStream, output: NodeJS.WriteStream;
			let closeTerminal = false;
			if (explicitTerminal) {
				input = explicitTerminal.input;
				output = explicitTerminal.output;
			} else {
				const inputFd = openSync("/dev/tty", "r");
				let outputFd: number;
				try {
					outputFd = openSync("/dev/tty", "w");
				} catch (error) {
					closeSync(inputFd);
					throw error;
				}
				input = new TtyReadStream(inputFd);
				output = new TtyWriteStream(outputFd);
				closeTerminal = true;
			}
			try {
				if (!canDisplaySecret(input, output))
					throw new Error("adapter token display requires the same controlling /dev/tty");
				const token = readInstalledConfig(path).adapterToken;
				if (
					!(await (
						dependencies.confirmAdapterToken ??
						(() => confirmOnControllingTty("SHOW ADAPTER TOKEN", input, output))
					)(token))
				)
					throw new Error("adapter token confirmation phrase was not accepted on the same controlling /dev/tty");
				displayAdapterToken(token, input, output);
			} finally {
				if (closeTerminal) {
					input.destroy();
					output.destroy();
				}
			}
			return 0;
		}
		if (command.kind === "probe-ready") {
			const installed = readInstalledConfig(path);
			if (installed.mode === "managed") probeManagedAdapter(`${path}.compose.yml`);
			else {
				const target = `http://${installed.bindHost === "0.0.0.0" ? "127.0.0.1" : installed.bindHost}:${installed.bindPort}/readyz`;
				const response = await fetch(target, { headers: { authorization: `Bearer ${installed.readinessToken}` } });
				if (!response.ok) throw new Error(`adapter is not ready (${response.status})`);
			}
			return 0;
		}
		const config = loadInstalledAdapterConfig(path);
		const server = dependencies.startServer
			? await dependencies.startServer(config)
			: (() => {
					throw new Error("installed service startup must be provided by the adapter CLI");
				})();
		stdout.write(`${server.url}\n`);
		return 0;
	} catch (error) {
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return error instanceof CliUsageError ? error.exitCode : 1;
	}
}
function optionValue(options: Record<string, string | boolean>, name: string): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}
function assertRegularOrAbsent(path: string): void {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) throw new Error(`configuration artifact must be a regular file or absent: ${path}`);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}
function fdOption(options: Record<string, string | boolean>, name: string): string {
	const value = optionValue(options, name);
	if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value))
		throw new Error(`configuration requires a decimal --${name}`);
	return readSecretRecordFromFd(Number(value));
}
function readPendingRecoveryJournal(path: string): PendingRecoveryRecord | undefined {
	try {
		return parseBootstrapState(JSON.parse(readFileSync(`${path}.bootstrap.json`, "utf8"))).pendingRecovery;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
			return undefined;
		throw new Error(`Malformed bootstrap state: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function validateRecoveryPair(path: string, pending: PendingRecoveryRecord | undefined): void {
	const snapshot = readDurableDeploymentSnapshot(path);
	if (pending === undefined && snapshot === undefined) return;
	if (pending === undefined && snapshot !== undefined) {
		// Snapshot creation precedes journal creation. Without the journal no deployment
		// mutation can have started, so either self-consistent snapshot is safe to retire.
		clearDurableDeploymentSnapshot(path);
		return;
	}
	if (pending === undefined || snapshot === undefined)
		throw new Error("pending recovery and recovery snapshot must be present together");
	if (snapshot.transactionId !== pending.transactionId)
		throw new Error("pending recovery and recovery snapshot transaction IDs do not match");
	if (snapshot.status === "complete") {
		clearPendingRecoveryJournal(path);
		clearDurableDeploymentSnapshot(path);
		return;
	}
	const configSnapshot = snapshot.snapshots.find(item => item.path === path && item.content !== undefined);
	let captured: InstalledConfig | undefined;
	if (configSnapshot !== undefined) {
		try {
			captured = validateInstalledConfig(JSON.parse(configSnapshot.content!.toString("utf8")));
		} catch (error) {
			throw new Error(`invalid captured config: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (captured.mode !== pending.priorMode || captured.installationId !== pending.installationId)
			throw new Error("captured config identity does not match pending recovery");
	}
	if (!existsSync(path)) return;
	let live: InstalledConfig;
	try {
		live = readInstalledConfig(path);
	} catch (error) {
		throw new Error(`invalid live config during recovery: ${error instanceof Error ? error.message : String(error)}`);
	}
	const targetMatches =
		live.mode === pending.mode &&
		live.installationId === pending.installationId &&
		live.adapterToken === pending.adapterToken &&
		live.readinessToken === pending.readinessToken &&
		live.openWebUIApiUrl === pending.targetUrl &&
		live.adapterProviderUrl === pending.providerUrl &&
		live.bindPort === (pending.bindPort ?? live.bindPort) &&
		live.projectRoot === pending.projectRoot;
	const priorMatches =
		captured !== undefined &&
		live.mode === captured.mode &&
		live.installationId === captured.installationId &&
		live.adapterToken === captured.adapterToken &&
		live.readinessToken === captured.readinessToken &&
		live.openWebUIApiUrl === captured.openWebUIApiUrl &&
		live.adapterProviderUrl === captured.adapterProviderUrl &&
		live.bindHost === captured.bindHost &&
		live.bindPort === captured.bindPort &&
		live.projectRoot === captured.projectRoot;
	if (!targetMatches && !priorMatches)
		throw new Error("live config does not match captured prior or pending recovery target");
}
function writePendingRecoveryJournal(path: string, pendingRecovery: PendingRecoveryRecord): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let state: BootstrapState;
	try {
		state = parseBootstrapState(JSON.parse(readFileSync(`${path}.bootstrap.json`, "utf8")));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
			throw error;
		state = {
			version: 1,
			phase: "preflight",
			bootstrapComplete: false,
			apiKeyCreated: false,
			openAIConfigured: false,
			routeVerified: false,
			ownershipVerified: false,
			openAIConnectionIds: [],
		};
	}
	const target = `${path}.bootstrap.json`,
		temporary = `${target}.${process.pid}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify({ ...state, pendingRecovery })}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, target);
	const directoryFd = openSync(directory, "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}
function updatePendingRecoveryJournal(
	path: string,
	patch: Partial<
		Pick<
			PendingRecoveryRecord,
			"controllerRecoveryRequired" | "controllerQuiesced" | "priorControllerEnabled" | "priorControllerActive"
		>
	>,
): void {
	const pending = readPendingRecoveryJournal(path);
	if (pending === undefined) return;
	const controllerQuiesced = pending.controllerQuiesced || patch.controllerQuiesced === true;
	writePendingRecoveryJournal(path, {
		...pending,
		...patch,
		controllerQuiesced,
		linkage: `${pending.mode}:${pending.installationId}:${pending.targetUrl}:${pending.providerUrl}:${pending.uiPort}${pending.projectRoot === undefined ? "" : `:${pending.projectRoot}`}${pending.bindPort === undefined ? "" : `:${pending.bindPort}`}:${pending.priorMode}:${(patch.priorControllerEnabled ?? pending.priorControllerEnabled) ? "enabled" : "disabled"}:${(patch.priorControllerActive ?? pending.priorControllerActive) ? "active" : "inactive"}:${(patch.controllerRecoveryRequired ?? pending.controllerRecoveryRequired) ? "recovery-required" : "controller-live"}:${controllerQuiesced ? "controller-quiesced" : "controller-live"}`,
	});
}
function clearPendingRecoveryJournal(path: string): void {
	try {
		const state = parseBootstrapState(JSON.parse(readFileSync(`${path}.bootstrap.json`, "utf8")));
		const { pendingRecovery: _pendingRecovery, ...withoutPending } = state;
		const target = `${path}.bootstrap.json`,
			temporary = `${target}.${process.pid}.tmp`;
		const fd = openSync(temporary, "w", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(withoutPending)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, target);
		const directoryFd = openSync(dirname(target), "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
			throw error;
	}
}
async function configure(
	mode: "managed" | "existing",
	options: Record<string, string | boolean>,
	path: string,
	deployment: DeploymentLifecycle,
	dependencies: CliDependencies = {},
): Promise<void> {
	const userUnitDirectory = join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"systemd",
		"user",
	);
	for (const artifact of [
		path,
		`${path}.compose.yml`,
		`${path}.service`,
		`${path}.bootstrap.json`,
		`${path}.recovery.json`,
		join(dirname(path), "adapter-token"),
		join(userUnitDirectory, "openwebui-gjc-adapter.service"),
		join(userUnitDirectory, "openwebui-gjc-adapter-existing.service"),
	])
		assertRegularOrAbsent(artifact);
	if (mode === "managed" && dependencies.deployment === undefined) {
		const checks = await checkManagedComposePrerequisites({
			docker: managedDockerRunner(dependencies.managedDocker),
		});
		if (!checks.passed) throw new Error(checks.failures.join("; "));
	}
	let pending = readPendingRecoveryJournal(path);
	validateRecoveryPair(path, pending);
	pending = readPendingRecoveryJournal(path);
	if (existsSync(path) && (lstatSync(path).isSymbolicLink() || lstatSync(path).isDirectory()))
		throw new Error("config artifact must be a regular file or absent");
	const previous = existsSync(path) ? readInstalledConfig(path) : undefined;
	if (pending !== undefined && pending.mode !== mode)
		throw new Error("pending recovery belongs to a different deployment mode");
	if (pending !== undefined) {
		if (mode === "managed" && optionValue(options, "adapter-ingress-url") !== undefined)
			throw new Error("managed recovery does not accept an ingress URL");
		const requestedTarget = optionValue(options, "openwebui-url");
		if (requestedTarget !== undefined && canonicalizeUrl(requestedTarget, "openwebui-url") !== pending.targetUrl)
			throw new Error("pending recovery OpenWebUI URL does not match retry input");
		const requestedProvider = optionValue(options, "adapter-ingress-url");
		if (requestedProvider !== undefined) {
			let canonicalProvider = canonicalizeUrl(requestedProvider, "adapter-ingress-url");
			if (!canonicalProvider.endsWith("/v1")) canonicalProvider += "/v1";
			if (canonicalProvider !== pending.providerUrl)
				throw new Error("pending recovery provider URL does not match retry input");
		}
		if (
			pending.linkage !==
			`${pending.mode}:${pending.installationId}:${pending.targetUrl}:${pending.providerUrl}:${pending.uiPort}${pending.projectRoot === undefined ? "" : `:${pending.projectRoot}`}${pending.bindPort === undefined ? "" : `:${pending.bindPort}`}:${pending.priorMode}:${pending.priorControllerEnabled ? "enabled" : "disabled"}:${pending.priorControllerActive ? "active" : "inactive"}:${pending.controllerRecoveryRequired ? "recovery-required" : "controller-live"}:${pending.controllerQuiesced ? "controller-quiesced" : "controller-live"}`
		)
			throw new Error("pending recovery linkage is invalid");
		if (
			previous?.mode === pending.mode &&
			(previous.installationId !== pending.installationId ||
				previous.adapterToken !== pending.adapterToken ||
				previous.readinessToken !== pending.readinessToken)
		)
			throw new Error("pending recovery identity does not match installed configuration");
		if (
			pending.mode === "existing" &&
			optionValue(options, "bind-port") !== undefined &&
			Number(optionValue(options, "bind-port")) !== pending.bindPort
		)
			throw new Error("pending recovery bind port does not match retry input");
	}
	if (previous && previous.mode !== mode && options.reset !== true)
		throw new Error("changing the deployment route requires --reset");
	const bindHost = mode === "managed" ? "0.0.0.0" : "127.0.0.1";
	const bindPort = Number(optionValue(options, "bind-port") ?? pending?.bindPort ?? "8765");
	if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535)
		throw new Error("bind-port must be between 1 and 65535");
	const requestedUiPort = optionValue(options, "ui-port");
	const uiPort = Number(requestedUiPort ?? pending?.uiPort ?? "8080");
	if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535)
		throw new Error("ui-port must be between 1 and 65535");
	if (pending !== undefined && requestedUiPort !== undefined && uiPort !== pending.uiPort)
		throw new Error("pending recovery UI port does not match retry input");
	const openWebUIApiUrl =
		pending?.targetUrl ??
		canonicalizeUrl(
			optionValue(options, "openwebui-url") ?? (mode === "managed" ? `http://localhost:${uiPort}` : ""),
			"openwebui-url",
		);
	let openWebUIApiToken: string | undefined;
	let adapterProviderUrl: string;
	let adminEmail = "",
		adminPassword = "";
	let bootstrapCheckpoint: BootstrapState | undefined;
	try {
		bootstrapCheckpoint = parseBootstrapState(JSON.parse(readFileSync(`${path}.bootstrap.json`, "utf8")));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
			throw error;
	}
	if (mode === "managed") {
		adminEmail = fdOption(options, "admin-email-fd");
		adminPassword = fdOption(options, "admin-password-fd");
		adapterProviderUrl = pending?.providerUrl ?? "http://adapter:8765/v1";
	} else {
		openWebUIApiToken = fdOption(options, "openwebui-api-token-fd");
		const raw = optionValue(options, "adapter-ingress-url");
		if (!raw) throw new Error("existing configuration requires --adapter-ingress-url");
		adapterProviderUrl = pending?.providerUrl ?? canonicalizeUrl(raw, "adapter-ingress-url");
		if (!adapterProviderUrl.endsWith("/v1")) adapterProviderUrl += "/v1";
	}
	if (previous && previous.openWebUIApiUrl !== openWebUIApiUrl && options.reset !== true)
		throw new Error("changing the OpenWebUI URL requires --reset");
	const projectRoot =
		mode === "existing"
			? (optionValue(options, "project-root") ??
				pending?.projectRoot ??
				previous?.projectRoot ??
				DEFAULT_EXISTING_PROJECT_ROOT)
			: undefined;
	if (
		pending?.mode === "existing" &&
		optionValue(options, "project-root") !== undefined &&
		projectRoot !== pending.projectRoot
	)
		throw new Error("pending recovery project root does not match retry input");
	if (mode === "existing") rejectProjectRootArtifactOverlap(projectRoot!, path);
	const retainsTargetOwner = previous === undefined || previous.openWebUIApiUrl === openWebUIApiUrl;
	const config: InstalledConfig = {
		version: 1,
		mode,
		installationId: pending?.installationId ?? previous?.installationId ?? generateAdapterToken(),
		...(retainsTargetOwner && (previous?.ownerUserId ?? bootstrapCheckpoint?.ownerUserId) !== undefined
			? { ownerUserId: previous?.ownerUserId ?? bootstrapCheckpoint?.ownerUserId }
			: {}),
		adapterToken: pending?.adapterToken ?? (previous?.mode === mode ? previous.adapterToken : generateAdapterToken()),
		readinessToken: pending?.readinessToken ?? previous?.readinessToken ?? generateAdapterToken(),
		openWebUIApiToken:
			mode === "managed"
				? (previous?.openWebUIApiToken ?? bootstrapCheckpoint?.openWebUIApiToken)
				: openWebUIApiToken,
		openWebUIApiUrl,
		adapterProviderUrl,
		bindHost,
		bindPort,
		projectRoot,
	};
	const existingValidation =
		mode === "existing" && previous === undefined && pending === undefined && options.reset !== true
			? await deployment.validateExisting?.({ config })
			: undefined;
	const pendingRecovery: PendingRecoveryRecord = pending ?? {
		version: 1,
		mode,
		priorMode: previous?.mode ?? mode,
		installationId: config.installationId,
		transactionId: randomUUID(),
		adapterToken: config.adapterToken,
		readinessToken: config.readinessToken,
		targetUrl: config.openWebUIApiUrl,
		providerUrl: config.adapterProviderUrl,
		uiPort,
		...(mode === "existing" ? { bindPort } : {}),
		...(projectRoot === undefined ? {} : { projectRoot }),
		priorControllerEnabled: false,
		priorControllerActive: false,
		controllerRecoveryRequired: options.reset === true && (mode === "managed" || previous?.mode === "managed"),
		controllerQuiesced: false,
		linkage: `${mode}:${config.installationId}:${config.openWebUIApiUrl}:${config.adapterProviderUrl}:${uiPort}${projectRoot === undefined ? "" : `:${projectRoot}`}${mode === "existing" ? `:${bindPort}` : ""}:${previous?.mode ?? mode}:disabled:inactive:${options.reset === true && (mode === "managed" || previous?.mode === "managed") ? "recovery-required" : "controller-live"}:controller-live`,
	};
	let resetProof: string | undefined;
	let resetFailedPhase: BootstrapPhase | undefined;
	if (options.reset === true) {
		const proof = optionValue(options, "reset-proof");
		if (!proof) throw new Error("reset requires --reset-proof evidence");
		const confirmed = await (dependencies.confirmReset ?? ((m, p) => confirmOnControllingTty(`RESET ${m} ${p}`)))(
			mode,
			proof,
		);
		if (!confirmed) throw new Error("reset requires confirmation of the failed phase on the controlling /dev/tty");
		resetProof = proof;
		resetFailedPhase =
			bootstrapCheckpoint?.failedPhase ??
			(bootstrapCheckpoint?.phase !== undefined && bootstrapCheckpoint.phase !== "complete"
				? bootstrapCheckpoint.phase
				: bootstrapCheckpoint?.phase === "complete" &&
						bootstrapCheckpoint.apiKeyCreated &&
						bootstrapCheckpoint.ownerUserId !== undefined &&
						bootstrapCheckpoint.openWebUIApiToken !== undefined
					? "route"
					: undefined);
	}
	if (mode === "existing") prepareExistingProjectRoot(projectRoot!);
	if (!existsSync(recoverySnapshotPath(path))) {
		const userUnitDirectory = join(
			process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
			"systemd",
			"user",
		);
		writeDurableDeploymentSnapshot(path, userUnitDirectory, pendingRecovery.transactionId);
	}
	writePendingRecoveryJournal(path, pendingRecovery);
	let recovery: { readonly controllerRecoveryRequired: true; readonly controllerQuiesced?: true } | undefined;
	if (pendingRecovery.controllerRecoveryRequired)
		recovery = {
			controllerRecoveryRequired: true,
			...(pendingRecovery.controllerQuiesced ? { controllerQuiesced: true } : {}),
		};
	if (options.reset === true) {
		const resetInput = {
			priorMode: pendingRecovery.priorMode,
			targetMode: mode,
			proof: {
				evidence: resetProof as string,
				...(resetFailedPhase === undefined ? {} : { failedPhase: resetFailedPhase }),
			},
		};
		const result = await deployment.reset(resetInput);
		if (result.completed !== true || result.mode !== "reset")
			throw new Error("deployment reset did not complete successfully");
		updatePendingRecoveryJournal(path, { controllerQuiesced: true, controllerRecoveryRequired: true });
		recovery = { controllerRecoveryRequired: true, controllerQuiesced: true };
	}
	writeInstalledConfig(config, path);
	let result: DeploymentResult;
	try {
		result =
			mode === "managed"
				? await deployment.managed({ config, adminEmail, adminPassword, uiPort, recovery })
				: await deployment.existing({
						config,
						...(existingValidation === undefined ? {} : { validation: existingValidation }),
					});
	} catch (error) {
		if (previous) writeInstalledConfig(previous, path);
		else rmSync(path, { force: true });
		throw error;
	}
	if (result.completed !== true || result.mode !== mode)
		throw new Error(`${mode} deployment lifecycle did not complete successfully`);
	writeInstalledConfig(config, path);
	markDurableDeploymentSnapshotComplete(path, pendingRecovery.transactionId);
	clearPendingRecoveryJournal(path);
	clearDurableDeploymentSnapshot(path);
}
