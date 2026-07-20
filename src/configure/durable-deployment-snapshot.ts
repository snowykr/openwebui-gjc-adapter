import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureFileSnapshot, type FileSnapshot, removeFileSnapshot, restoreFileSnapshot } from "./file-snapshots";

const RECOVERY_SNAPSHOT_VERSION = 1;
type DurableSnapshotStatus = "prepared" | "complete";
type CapturedFileValidator = (path: string, content: Buffer) => void;
type SnapshotInput = {
	readonly path: string;
	readonly transactionId: string;
	readonly status: DurableSnapshotStatus;
	readonly snapshots: readonly FileSnapshot[];
	readonly validateCapturedFile?: CapturedFileValidator;
};

export interface DurableDeploymentSnapshot {
	readonly transactionId: string;
	readonly status: DurableSnapshotStatus;
	readonly snapshots: readonly FileSnapshot[];
	readonly restore: () => void;
	readonly markComplete: () => void;
	readonly remove: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function recoverySnapshotPath(path: string): string {
	return `${path}.recovery.json`;
}

function snapshotPaths(path: string, userUnitDirectory: string): readonly string[] {
	return [
		path,
		`${path}.compose.yml`,
		`${path}.service`,
		`${path}.bootstrap.json`,
		join(dirname(path), "adapter-token"),
		join(userUnitDirectory, "openwebui-gjc-adapter.service"),
		join(userUnitDirectory, "openwebui-gjc-adapter-existing.service"),
	];
}

function assertRecoverySnapshotMode(mode: number): void {
	if (mode !== 0o400 && mode !== 0o600) throw new Error("recovery snapshot file mode must be 0400 or 0600");
}

function restoreSnapshots(snapshots: readonly FileSnapshot[]): void {
	for (const snapshot of snapshots.filter(
		value => value.content === undefined && !value.directory && value.symlink === undefined,
	))
		removeFileSnapshot(snapshot);
	const directories = snapshots
		.filter(value => value.directory)
		.filter(
			value =>
				!snapshots.some(
					parent => parent.directory && parent.path !== value.path && value.path.startsWith(`${parent.path}/`),
				),
		);
	for (const directory of directories) removeFileSnapshot(directory);
	for (const snapshot of snapshots.filter(value => value.symlink !== undefined || value.content !== undefined))
		removeFileSnapshot(snapshot);
	for (const snapshot of snapshots.filter(value => value.directory).sort((a, b) => a.path.length - b.path.length))
		restoreFileSnapshot(snapshot);
	for (const snapshot of snapshots.filter(value => value.symlink !== undefined)) restoreFileSnapshot(snapshot);
	for (const snapshot of snapshots.filter(value => value.content !== undefined)) restoreFileSnapshot(snapshot);
}

function writeJournal(target: string, value: Record<string, unknown>): void {
	const temporary = `${target}.${process.pid}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
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

function createSnapshot(input: SnapshotInput): DurableDeploymentSnapshot {
	return {
		transactionId: input.transactionId,
		status: input.status,
		snapshots: input.snapshots,
		restore: () => restoreSnapshots(input.snapshots),
		markComplete: () => {
			const current = restoreDurableDeploymentSnapshot(input.path, input.validateCapturedFile);
			if (current === undefined) throw new Error("recovery snapshot is missing");
			if (current.transactionId !== input.transactionId)
				throw new Error("recovery snapshot transaction IDs do not match");
			if (current.status === "complete") return;
			const value: unknown = JSON.parse(readFileSync(recoverySnapshotPath(input.path), "utf8"));
			if (!isRecord(value)) throw new Error("journal must be an object");
			writeJournal(recoverySnapshotPath(input.path), { ...value, status: "complete" });
		},
		remove: () => rmSync(recoverySnapshotPath(input.path), { force: true }),
	};
}

export function captureDurableDeploymentSnapshot(
	path: string,
	userUnitDirectory: string,
	transactionId = "",
): DurableDeploymentSnapshot {
	const snapshots = snapshotPaths(path, userUnitDirectory).map(captureFileSnapshot);
	const config = snapshots.find(snapshot => snapshot.path === path);
	if (config?.symlink !== undefined || config?.directory === true)
		throw new Error("config artifact must be a regular file or absent");
	for (const snapshot of snapshots)
		if (snapshot.content !== undefined && snapshot.mode !== undefined) assertRecoverySnapshotMode(snapshot.mode);
	const journal = {
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
	if (transactionId !== "") {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeJournal(recoverySnapshotPath(path), journal);
	}
	return createSnapshot({ path, transactionId, status: "prepared", snapshots });
}

export function restoreDurableDeploymentSnapshot(
	path: string,
	validateCapturedFile?: CapturedFileValidator,
): DurableDeploymentSnapshot | undefined;
export function restoreDurableDeploymentSnapshot(snapshots: readonly FileSnapshot[]): void;
export function restoreDurableDeploymentSnapshot(input: { readonly remove: string }): void;
export function restoreDurableDeploymentSnapshot(
	input: string | readonly FileSnapshot[] | { readonly remove: string },
	validateCapturedFile?: CapturedFileValidator,
): DurableDeploymentSnapshot | undefined {
	if (typeof input !== "string") {
		if ("remove" in input) rmSync(recoverySnapshotPath(input.remove), { force: true });
		else restoreSnapshots(input);
		return undefined;
	}
	const path = input;
	try {
		const value: unknown = JSON.parse(readFileSync(recoverySnapshotPath(path), "utf8"));
		if (!isRecord(value)) throw new Error("journal must be an object");
		if (
			value.version !== RECOVERY_SNAPSHOT_VERSION ||
			typeof value.transactionId !== "string" ||
			value.transactionId.trim().length === 0 ||
			!Array.isArray(value.snapshots) ||
			(value.status !== undefined && value.status !== "prepared" && value.status !== "complete")
		)
			throw new Error("invalid recovery snapshot");
		const journalKeys = Object.keys(value).sort().join(",");
		if (journalKeys !== "snapshots,transactionId,version" && journalKeys !== "snapshots,status,transactionId,version")
			throw new Error("recovery snapshot contains unknown fields");
		const userUnitDirectory = join(
			process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
			"systemd",
			"user",
		);
		const expectedPaths = snapshotPaths(path, userUnitDirectory);
		if (value.snapshots.length !== expectedPaths.length)
			throw new Error("recovery snapshot has incorrect entry count");
		const expected = new Set(expectedPaths);
		const seen = new Set<string>();
		const snapshots: FileSnapshot[] = [];
		for (const entry of value.snapshots) {
			if (!isRecord(entry)) throw new Error("invalid recovery snapshot entry");
			const keys = Object.keys(entry);
			if (typeof entry.path !== "string" || !expected.has(entry.path) || seen.has(entry.path))
				throw new Error("recovery snapshot has invalid or duplicate path");
			seen.add(entry.path);
			const hasContent = Object.hasOwn(entry, "content"),
				hasDirectory = Object.hasOwn(entry, "directory"),
				hasSymlink = Object.hasOwn(entry, "symlink");
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
			if (hasDirectory && entry.directory !== true) throw new Error("invalid directory marker");
			if (
				hasSymlink &&
				(typeof entry.symlink !== "string" || entry.symlink.length === 0 || entry.symlink.includes("\0"))
			)
				throw new Error("invalid symlink target");
			if (
				type !== "absent" &&
				(typeof entry.mode !== "number" ||
					!Number.isSafeInteger(entry.mode) ||
					entry.mode < 0 ||
					entry.mode > 0o777)
			)
				throw new Error("invalid snapshot mode");
			if (hasDirectory || hasSymlink) throw new Error("deployment artifacts must be regular files or absent");
			if (hasContent) {
				if (typeof entry.mode !== "number") throw new Error("invalid snapshot mode");
				assertRecoverySnapshotMode(entry.mode);
				if (
					typeof entry.content !== "string" ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)
				)
					throw new Error("invalid base64 content");
				const content = Buffer.from(entry.content, "base64");
				if (content.toString("base64") !== entry.content) throw new Error("non-canonical base64 content");
				validateCapturedFile?.(entry.path, content);
				snapshots.push({ path: entry.path, content, mode: entry.mode });
			} else snapshots.push({ path: entry.path });
		}
		if (seen.size !== expected.size) throw new Error("recovery snapshot path coverage is incomplete");
		return createSnapshot({
			path,
			transactionId: value.transactionId,
			status: value.status === "complete" ? "complete" : "prepared",
			snapshots,
			validateCapturedFile,
		});
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw new Error(`Malformed recovery snapshot: ${error instanceof Error ? error.message : String(error)}`);
	}
}
