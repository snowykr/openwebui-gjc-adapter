import {
	closeSync,
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
import { dirname } from "node:path";

export interface FileSnapshot {
	readonly path: string;
	readonly content?: Buffer;
	readonly mode?: number;
	readonly directory?: boolean;
	readonly symlink?: string;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function captureFileSnapshot(path: string): FileSnapshot {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`deployment artifact must be a regular file or absent: ${path}`);
		if (stat.isDirectory()) throw new Error(`deployment artifact must be a regular file or absent: ${path}`);
		if (stat.isFile()) return { path, content: readFileSync(path), mode: stat.mode & 0o777 };
		throw new Error(`unsupported snapshot file type: ${path}`);
	} catch (error) {
		if (isMissingFile(error)) return { path };
		throw error;
	}
}

export function removeFileSnapshot(snapshot: FileSnapshot): void {
	rmSync(snapshot.path, { recursive: true, force: true });
}

export function restoreFileSnapshot(snapshot: FileSnapshot): void {
	if (snapshot.directory) {
		mkdirSync(snapshot.path, { recursive: true, mode: snapshot.mode });
		return;
	}
	if (snapshot.symlink !== undefined) {
		mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
		const temporary = `${snapshot.path}.${process.pid}.restore`;
		rmSync(temporary, { force: true });
		symlinkSync(snapshot.symlink, temporary);
		renameSync(temporary, snapshot.path);
		return;
	}
	if (snapshot.content === undefined) {
		removeFileSnapshot(snapshot);
		return;
	}
	mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
	const temporary = `${snapshot.path}.${process.pid}.restore`;
	const fd = openSync(temporary, "w", snapshot.mode ?? 0o600);
	try {
		writeFileSync(fd, snapshot.content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, snapshot.path);
}
