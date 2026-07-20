import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type SqlValue = string | number | null | Uint8Array;
export type RawColumn = Readonly<{ name: string; definition: string; insert?: boolean }>;
export type RawRow = Readonly<Record<string, SqlValue>>;
export type FilesystemEntry =
	| { readonly kind: "directory"; readonly path: string }
	| { readonly kind: "file"; readonly path: string; readonly contents: string | Uint8Array; readonly mode?: number }
	| { readonly kind: "symlink"; readonly path: string; readonly target: string };
export type RawDatabaseFixture =
	| {
			readonly kind: "table";
			readonly databasePath: string;
			readonly columns: readonly RawColumn[];
			readonly row?: RawRow;
			readonly userVersion?: number;
			readonly tableName: string;
			readonly journalMode: string;
			readonly virtualModule?: string;
	  }
	| { readonly kind: "sql"; readonly databasePath: string; readonly statements: readonly string[] };
export type ProcessSpec = {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly deadlineMs: number;
	readonly terminationGraceMs: number;
};
export type ProcessResult = Readonly<{ exitCode: number; timedOut: boolean; stdout: string; stderr: string }>;

const workspaces: string[] = [];

export async function makeWorkspace(label: string, initialDirectories: readonly string[] = []): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
	workspaces.push(root);
	await Promise.all(initialDirectories.map(directory => fs.mkdir(path.join(root, directory), { recursive: true })));
	return root;
}

export async function removeWorkspaces(): Promise<void> {
	await Promise.all(workspaces.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
}

export async function materializeFilesystem(entries: readonly FilesystemEntry[]): Promise<void> {
	for (const entry of entries) {
		if (entry.kind === "directory") await fs.mkdir(entry.path, { recursive: true });
		if (entry.kind === "file") {
			await fs.mkdir(path.dirname(entry.path), { recursive: true });
			await fs.writeFile(entry.path, entry.contents);
			if (entry.mode !== undefined) await fs.chmod(entry.path, entry.mode);
		}
		if (entry.kind === "symlink") {
			await fs.mkdir(path.dirname(entry.path), { recursive: true });
			await fs.symlink(entry.target, entry.path);
		}
	}
}

export async function writeRawDatabase(fixture: RawDatabaseFixture): Promise<void> {
	await fs.mkdir(path.dirname(fixture.databasePath), { recursive: true });
	const database = new Database(fixture.databasePath);
	if (fixture.kind === "sql") for (const statement of fixture.statements) database.exec(statement);
	else {
		const definitions = fixture.columns.map(column => column.definition).join(", ");
		database.exec(
			fixture.virtualModule === undefined
				? `CREATE TABLE ${fixture.tableName} (${definitions})`
				: `CREATE VIRTUAL TABLE ${fixture.tableName} USING ${fixture.virtualModule} (${definitions})`,
		);
		if (fixture.row !== undefined) insertRawRow(database, fixture.columns, fixture.row, fixture.tableName);
		if (fixture.userVersion !== undefined) database.exec(`PRAGMA user_version = ${fixture.userVersion}`);
		database.exec(`PRAGMA journal_mode = ${fixture.journalMode}`);
	}
	database.close();
}

export function writeSqlDatabase(databasePath: string, statements: readonly string[]): Promise<void> {
	return writeRawDatabase({ kind: "sql", databasePath, statements });
}

export function writeRawTable(
	databasePath: string,
	columns: readonly RawColumn[],
	tableName: string,
	journalMode: string,
	row?: RawRow,
	userVersion?: number,
	virtualModule?: string,
): Promise<void> {
	return writeRawDatabase({
		kind: "table",
		databasePath,
		columns,
		row,
		tableName,
		journalMode,
		userVersion,
		virtualModule,
	});
}

export function insertRawRow(database: Database, columns: readonly RawColumn[], row: RawRow, tableName: string): void {
	const inserted = columns.filter(column => column.insert !== false);
	const values = inserted.map(column => {
		const value = row[column.name];
		if (value === undefined) throw new Error(`Missing raw value for ${column.name}.`);
		return value;
	});
	database
		.query(
			`INSERT INTO ${tableName} (${inserted.map(column => column.name).join(",")}) VALUES (${inserted.map(() => "?").join(",")})`,
		)
		.run(...values);
}

export function columnName(row: unknown): string {
	if (typeof row === "object" && row !== null && "name" in row && typeof row.name === "string") return row.name;
	throw new Error("Invalid SQLite column row.");
}

export async function copySourceFamily(
	sourcePath: string,
	destinationPath: string,
	suffixes: readonly string[],
): Promise<void> {
	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	await Promise.all(suffixes.map(suffix => fs.copyFile(`${sourcePath}${suffix}`, `${destinationPath}${suffix}`)));
}

export function createFifo(target: string, cwd: string): Promise<ProcessResult> {
	return runProcess({
		argv: ["mkfifo", target],
		cwd,
		env: process.env,
		deadlineMs: 2_000,
		terminationGraceMs: 200,
	});
}

export async function snapshotSourceFamily(databasePath: string): Promise<unknown> {
	let source = databasePath;
	try {
		if ((await fs.lstat(databasePath)).isSymbolicLink()) {
			const target = await fs.readlink(databasePath);
			source = path.resolve(path.dirname(databasePath), target);
		}
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const names = [
		databasePath,
		source,
		`${source}-wal`,
		`${source}-shm`,
		`${source}-journal`,
		path.dirname(databasePath),
		path.dirname(source),
	];
	return Promise.all(
		[...new Set(names)].sort().map(target => snapshotPath(target, target === path.dirname(databasePath))),
	);
}

export async function existingSourceArtifacts(databasePath: string): Promise<readonly string[]> {
	const candidates = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
	const existing = await Promise.all(
		candidates.map(async candidate => ((await Bun.file(candidate).exists()) ? candidate : undefined)),
	);
	return existing.filter(candidate => candidate !== undefined);
}

async function snapshotPath(target: string, ignoreDirectoryMetadata = false): Promise<unknown> {
	try {
		const metadata = await fs.lstat(target, { bigint: true });
		const common = [
			target,
			String(metadata.size),
			String(metadata.mtimeNs),
			String(metadata.mode),
			String(metadata.uid),
			String(metadata.gid),
			String(metadata.dev),
			String(metadata.ino),
		];
		if (metadata.isSymbolicLink()) {
			const link = await fs.readlink(target);
			const resolved = path.resolve(path.dirname(target), link);
			return [...common, "symlink", link, await snapshotPath(resolved), await snapshotPath(path.dirname(resolved))];
		}
		if (metadata.isDirectory())
			return [
				target,
				...(ignoreDirectoryMetadata
					? []
					: [
							String(metadata.size),
							String(metadata.mtimeNs),
							String(metadata.mode),
							String(metadata.uid),
							String(metadata.gid),
							String(metadata.dev),
							String(metadata.ino),
						]),
				"directory",
				(await fs.readdir(target)).sort(),
			];
		if (!metadata.isFile()) return [...common, "other"];
		return [...common, "file", await fs.readFile(target)];
	} catch (error) {
		if (isMissing(error)) return [target, "missing"];
		throw error;
	}
}

export async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
	const child = Bun.spawn([...spec.argv], {
		cwd: spec.cwd,
		env: { ...spec.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const completed = await Promise.race([
		child.exited.then(exitCode => ({ exitCode })),
		Bun.sleep(spec.deadlineMs).then(() => undefined),
	]);
	if (completed === undefined) {
		child.kill("SIGTERM");
		const terminated = await Promise.race([
			child.exited.then(() => true),
			Bun.sleep(spec.terminationGraceMs).then(() => false),
		]);
		if (!terminated) child.kill("SIGKILL");
	}
	const exitCode = completed?.exitCode ?? (await child.exited);
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	return { exitCode, timedOut: completed === undefined, stdout, stderr };
}

export async function openFileDescriptors(prefix: string): Promise<readonly string[]> {
	const links = await Promise.all(
		(await fs.readdir("/proc/self/fd")).map(async descriptor => {
			try {
				return await fs.readlink(`/proc/self/fd/${descriptor}`);
			} catch {
				return "";
			}
		}),
	);
	return links.filter(link => link.startsWith(prefix));
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
