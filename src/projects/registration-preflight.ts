import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GjcRuntimeLocations } from "../contracts";
import { assertProjectsAdmitted, ProjectLinkError } from "./link-service";
import type { RegisteredProject } from "./registry";

const REQUIRED_COLUMNS = `id name open_webui_folder_name cwd open_webui_folder_id allowed_root
session_root created_at updated_at source status`.split(/\s+/);
const LEGACY_COLUMNS = [...REQUIRED_COLUMNS.slice(0, 4), "model_id", ...REQUIRED_COLUMNS.slice(4)] as const;
const SOURCE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

type Fingerprint = Readonly<
	{
		path: string;
		kind: "missing" | "file" | "directory" | "symlink" | "other";
		entries?: readonly string[];
	} & Partial<
		Record<"bytes" | "sha256" | "size" | "mtimeNs" | "mode" | "uid" | "gid" | "dev" | "ino" | "linkTarget", string>
	>
>;
type SourceSnapshot = Readonly<{
	alias: Fingerprint;
	sourcePath: string;
	family: readonly Fingerprint[];
	parents: readonly Fingerprint[];
}>;

type TableRow = { readonly type: unknown };
type ColumnRow = { readonly name: unknown; readonly hidden: unknown };
type RawProjectRow = {
	readonly id: unknown;
	readonly name: unknown;
	readonly open_webui_folder_name: unknown;
	readonly cwd: unknown;
	readonly open_webui_folder_id: unknown;
	readonly allowed_root: unknown;
	readonly session_root: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly source: unknown;
	readonly status: unknown;
};

export async function preflightProjectRegistrationDatabase(
	databasePath: string,
	protectedPaths: GjcRuntimeLocations["protectedProjectPaths"],
): Promise<void> {
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const before = await snapshotSource(databasePath);
			if (before === undefined) return;
			const cloneDirectory = await mkdtemp(path.join(tmpdir(), "gjc-registration-preflight-"));
			let primary: Error | undefined;
			try {
				await chmod(cloneDirectory, 0o700);
				const clonePath = path.join(cloneDirectory, "registration.sqlite");
				try {
					await copyFile(before.sourcePath, clonePath);
					if (before.family[1]?.kind === "file") await copyFile(`${before.sourcePath}-wal`, `${clonePath}-wal`);
				} catch (error) {
					if (isMissing(error) && attempt + 1 < 3) continue;
					throw error;
				}
				const after = await snapshotSource(databasePath);
				if (after === undefined || !snapshotsEqual(before, after) || !(await cloneMatches(clonePath, before))) {
					if (attempt + 1 < 3) continue;
					throw incompatibleDatabase();
				}
				await auditClone(clonePath, protectedPaths);
				return;
			} catch (error) {
				primary = normalizePreflightError(error);
				throw primary;
			} finally {
				await cleanupPreserving(primary, () => rm(cloneDirectory, { force: true, recursive: true }));
			}
		}
	} catch (error) {
		throw normalizePreflightError(error);
	}
}

async function snapshotSource(databasePath: string): Promise<SourceSnapshot | undefined> {
	const alias = await fingerprint(databasePath);
	if (alias.kind === "missing") {
		const orphans = await Promise.all(
			SOURCE_SUFFIXES.slice(1).map(suffix => fingerprint(`${databasePath}${suffix}`)),
		);
		if (orphans.some(entry => entry.kind !== "missing")) throw incompatibleDatabase();
		return undefined;
	}
	if (alias.kind !== "file" && alias.kind !== "symlink") throw incompatibleDatabase();
	let sourcePath = databasePath;
	if (alias.kind === "symlink") {
		try {
			sourcePath = await realpath(databasePath);
		} catch (error) {
			if (isMissing(error)) throw incompatibleDatabase();
			throw error;
		}
	}
	const family = await Promise.all(SOURCE_SUFFIXES.map(suffix => fingerprint(`${sourcePath}${suffix}`)));
	if (family[0]?.kind !== "file" || family.some(entry => entry.kind !== "file" && entry.kind !== "missing")) {
		throw incompatibleDatabase();
	}
	if (family[3]?.kind !== "missing") throw incompatibleDatabase();
	const parentPaths = [...new Set([path.dirname(databasePath), path.dirname(sourcePath)])].sort();
	const parents = await Promise.all(parentPaths.map(fingerprintDirectory));
	return { alias, sourcePath, family, parents };
}

async function fingerprint(targetPath: string): Promise<Fingerprint> {
	let metadata: Awaited<ReturnType<typeof lstat>>;
	try {
		metadata = await lstat(targetPath, { bigint: true });
	} catch (error) {
		if (isMissing(error)) return { path: targetPath, kind: "missing" };
		throw error;
	}
	const common = {
		path: targetPath,
		size: metadata.size.toString(),
		mtimeNs: metadata.mtimeNs.toString(),
		mode: metadata.mode.toString(),
		uid: metadata.uid.toString(),
		gid: metadata.gid.toString(),
		dev: metadata.dev.toString(),
		ino: metadata.ino.toString(),
	};
	if (metadata.isSymbolicLink()) return { ...common, kind: "symlink", linkTarget: await readlink(targetPath) };
	if (metadata.isDirectory()) return { ...common, kind: "directory" };
	if (!metadata.isFile()) return { ...common, kind: "other" };
	const bytes = await readFile(targetPath);
	return {
		...common,
		kind: "file",
		bytes: bytes.toString("base64"),
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

async function fingerprintDirectory(directoryPath: string): Promise<Fingerprint> {
	const entry = await fingerprint(directoryPath);
	if (entry.kind !== "directory") throw incompatibleDatabase();
	return { ...entry, entries: (await readdir(directoryPath)).sort() };
}

async function auditClone(
	clonePath: string,
	protectedPaths: GjcRuntimeLocations["protectedProjectPaths"],
): Promise<void> {
	let database: Database | undefined;
	let primary: Error | undefined;
	try {
		database = new Database(clonePath, { readonly: true, create: false, strict: true });
		await assertProjectsAdmitted(readProjects(database), protectedPaths);
	} catch (error) {
		primary = normalizePreflightError(error);
		throw primary;
	} finally {
		await cleanupPreserving(primary, () => database?.close());
	}
}

function readProjects(database: Database): readonly RegisteredProject[] {
	const objects = database
		.query<TableRow, []>("SELECT type FROM sqlite_schema WHERE name = 'project_registration' COLLATE NOCASE")
		.all();
	if (objects.length === 0) return [];
	if (objects.length !== 1 || objects[0]?.type !== "table") throw incompatibleDatabase();
	const table = database
		.query<TableRow, []>(
			"SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = 'project_registration' COLLATE NOCASE",
		)
		.get();
	if (table?.type !== "table") throw incompatibleDatabase();
	const columns = database.query<ColumnRow, []>("PRAGMA table_xinfo(project_registration)").all();
	classifyColumns(columns);
	return database
		.query<RawProjectRow, []>(
			"SELECT id, name, open_webui_folder_name, cwd, open_webui_folder_id, allowed_root, session_root, created_at, updated_at, source, status FROM project_registration",
		)
		.all()
		.map(decodeProject);
}

function classifyColumns(rows: readonly ColumnRow[]): void {
	const columns = rows.map(columnName);
	if (!REQUIRED_COLUMNS.every(column => columns.includes(column))) throw incompatibleDatabase();
	if (rows.some(row => REQUIRED_COLUMNS.includes(columnName(row)) && row.hidden !== 0)) throw incompatibleDatabase();
	if (
		columns.some(column => column.toLowerCase() === "model_id") &&
		(columns.length !== LEGACY_COLUMNS.length ||
			!LEGACY_COLUMNS.every((column, index) => columns[index] === column) ||
			rows.some(row => row.hidden !== 0))
	)
		throw incompatibleDatabase();
}

function decodeProject(row: RawProjectRow): RegisteredProject {
	if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.cwd !== "string") {
		throw incompatibleDatabase();
	}
	if (
		typeof row.allowed_root !== "string" ||
		typeof row.created_at !== "string" ||
		typeof row.updated_at !== "string"
	) {
		throw incompatibleDatabase();
	}
	if (
		!optionalText(row.open_webui_folder_name) ||
		!optionalText(row.open_webui_folder_id) ||
		!optionalText(row.session_root)
	) {
		throw incompatibleDatabase();
	}
	if (row.source !== "env" && row.source !== "admin") throw incompatibleDatabase();
	if (row.status !== "linked" && row.status !== "unlinked") throw incompatibleDatabase();
	if (!validDate(row.created_at) || !validDate(row.updated_at)) throw incompatibleDatabase();
	return {
		id: row.id,
		name: row.name,
		...(row.open_webui_folder_name === null ? {} : { openWebUIFolderName: row.open_webui_folder_name }),
		cwd: row.cwd,
		...(row.open_webui_folder_id === null ? {} : { openWebUIFolderId: row.open_webui_folder_id }),
		allowedRoot: row.allowed_root,
		...(row.session_root === null ? {} : { sessionRoot: row.session_root }),
		createdAt: new Date(row.created_at),
	};
}

function columnName(row: ColumnRow): string {
	if (typeof row.name !== "string") throw incompatibleDatabase();
	return row.name;
}

async function cloneMatches(clonePath: string, snapshot: SourceSnapshot): Promise<boolean> {
	const main = snapshot.family[0];
	if (main?.bytes === undefined || (await readFile(clonePath)).toString("base64") !== main.bytes) return false;
	const wal = snapshot.family[1];
	if (wal?.kind === "missing") return true;
	return wal?.bytes !== undefined && (await readFile(`${clonePath}-wal`)).toString("base64") === wal.bytes;
}

async function cleanupPreserving(primary: Error | undefined, cleanup: () => void | Promise<void>): Promise<void> {
	try {
		await cleanup();
	} catch (error) {
		if (primary === undefined) throw error;
		if (primary.cause === undefined) Reflect.defineProperty(primary, "cause", { value: error });
	}
}

const normalizePreflightError = (error: unknown): Error =>
	error instanceof ProjectLinkError || isIncompatible(error) ? error : incompatibleDatabase();
const optionalText = (value: unknown): value is string | null => value === null || typeof value === "string";
const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const snapshotsEqual = (left: SourceSnapshot, right: SourceSnapshot) => JSON.stringify(left) === JSON.stringify(right);
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const incompatibleDatabase = (): Error => new Error("Project registration database is incompatible.");
const isIncompatible = (e: unknown): e is Error => e instanceof Error && e.message === incompatibleDatabase().message;
