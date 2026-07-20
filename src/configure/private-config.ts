import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ConfigFileError,
	canonicalizeUrl,
	DEFAULT_EXISTING_PROJECT_ROOT,
	defaultExistingProjectRoot,
	type InstalledConfig,
	type InstalledMode,
	validateInstalledConfig,
	validateProjectRoot,
	xdgStateDataHome,
} from "./installed-config-schema";

export {
	ConfigFileError,
	canonicalizeUrl,
	DEFAULT_EXISTING_PROJECT_ROOT,
	defaultExistingProjectRoot,
	type InstalledConfig,
	type InstalledMode,
	validateInstalledConfig,
};
export function defaultConfigPath(home = process.env.HOME): string {
	if (!home) throw new ConfigFileError("HOME is not set");
	return join(home, ".config", "openwebui-gjc-adapter", "config.json");
}
function rejectSymlink(path: string, label: string): void {
	let current = path;
	for (;;) {
		try {
			if (lstatSync(current).isSymbolicLink())
				throw new ConfigFileError(`${label} must not traverse a symbolic link`);
		} catch (error) {
			if (error instanceof ConfigFileError) throw error;
			if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"))
				throw error;
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
function privateInstallerRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
	const home = environment.HOME;
	if (!home) return [];
	return [
		join(home, ".config", "openwebui-gjc-adapter"),
		join(xdgStateDataHome(environment), "openwebui-gjc-adapter"),
	].map(value => resolve(value));
}
function overlapsPrivateInstallerRoot(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): boolean {
	const candidate = resolve(projectRoot);
	return privateInstallerRoots(environment).some(
		root => candidate === root || candidate.startsWith(`${root}/`) || root.startsWith(`${candidate}/`),
	);
}
function artifactsOverlap(candidate: string, artifact: string): boolean {
	return candidate === artifact || candidate.startsWith(`${artifact}/`) || artifact.startsWith(`${candidate}/`);
}
export function rejectProjectRootArtifactOverlap(projectRoot: string, configPath: string): void {
	const candidate = resolve(validateProjectRoot(projectRoot));
	const config = resolve(configPath);
	const artifacts = [
		config,
		`${config}.compose.yml`,
		`${config}.service`,
		`${config}.bootstrap.json`,
		`${config}.recovery.json`,
		`${config}.lock`,
		`${config}.route.lock`,
		join(dirname(config), "adapter-token"),
	];
	if (artifacts.some(artifact => artifactsOverlap(candidate, resolve(artifact))))
		throw new ConfigFileError("projectRoot must not overlap configuration artifacts");
}
export function prepareExistingProjectRoot(value: string = DEFAULT_EXISTING_PROJECT_ROOT): string {
	const projectRoot = validateProjectRoot(value);
	if (projectRoot !== resolve(DEFAULT_EXISTING_PROJECT_ROOT) && overlapsPrivateInstallerRoot(projectRoot))
		throw new ConfigFileError("projectRoot must not overlap private installer paths");
	rejectSymlink(projectRoot, "projectRoot");
	mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
	return projectRoot;
}
export function readInstalledConfig(path = defaultConfigPath()): InstalledConfig {
	try {
		return validateInstalledConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (e) {
		if (e instanceof ConfigFileError) throw e;
		throw new ConfigFileError(`cannot read installed config: ${e instanceof Error ? e.message : String(e)}`);
	}
}
export function writeInstalledConfig(config: InstalledConfig, path = defaultConfigPath()): void {
	const valid = validateInstalledConfig(config),
		directory = dirname(path);
	rejectSymlink(path, "config path");
	rejectSymlink(directory, "config directory");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.config.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		const fd = openSync(temporary, "w", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(valid, null, "\t")}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		const directoryFd = openSync(directory, "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {}
	}
}
export function acquireConfigLock(path = defaultConfigPath()): () => void {
	rejectSymlink(path, "config path");
	const lockPath = `${path}.lock`;
	const recoveryPath = `${lockPath}.recovery`;
	rejectSymlink(lockPath, "config lock");
	rejectSymlink(recoveryPath, "config lock recovery");
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	if (lockExists(recoveryPath)) {
		if (!lockOwnerIsDead(recoveryPath)) throw new ConfigFileError("configuration is already being modified");
		rmSync(recoveryPath);
	}
	const fd = tryAcquireLock(lockPath) ?? recoverDeadLock(lockPath, recoveryPath);
	return () => releaseLock(lockPath, fd);
}

function tryAcquireLock(lockPath: string): number | undefined {
	const temporary = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	let linked = false;
	try {
		writeFileSync(fd, `${process.pid}\n`);
		fsyncSync(fd);
		try {
			linkSync(temporary, lockPath);
			linked = true;
			return fd;
		} catch (error) {
			if (isErrno(error, "EEXIST")) return undefined;
			throw error;
		}
	} finally {
		rmSync(temporary, { force: true });
		if (!linked) closeSync(fd);
	}
}

function recoverDeadLock(lockPath: string, recoveryPath: string): number {
	const recoveryFd = tryAcquireLock(recoveryPath);
	if (recoveryFd === undefined) throw new ConfigFileError("configuration is already being modified");
	try {
		if (!lockOwnerIsDead(lockPath)) throw new ConfigFileError("configuration is already being modified");
		rmSync(lockPath);
		const fd = tryAcquireLock(lockPath);
		if (fd === undefined) throw new ConfigFileError("configuration is already being modified");
		return fd;
	} finally {
		releaseLock(recoveryPath, recoveryFd);
	}
}

function lockOwnerIsDead(lockPath: string): boolean {
	rejectSymlink(lockPath, "config lock");
	let fd: number;
	try {
		fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return false;
	}
	try {
		if (!fstatSync(fd).isFile()) return false;
		const pid = Number(readFileSync(fd, "utf8").trim());
		if (!Number.isSafeInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return false;
		} catch (error) {
			return isErrno(error, "ESRCH");
		}
	} finally {
		closeSync(fd);
	}
}

function lockExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
}

function releaseLock(lockPath: string, fd: number): void {
	try {
		const held = fstatSync(fd);
		const current = lstatSync(lockPath);
		if (current.dev === held.dev && current.ino === held.ino) rmSync(lockPath);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
	} finally {
		closeSync(fd);
	}
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
export function acquireRouteLock(home = process.env.HOME): () => void {
	return acquireConfigLock(`${defaultConfigPath(home)}.route`);
}
