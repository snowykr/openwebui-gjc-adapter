import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv } from "../src/adapter-server-options";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { FakeGjcTurnRunner } from "./cli-fixtures";
import * as fixture from "./project-registration-startup-preflight-fixtures";

const NAMES = `id name open_webui_folder_name cwd open_webui_folder_id allowed_root
session_root created_at updated_at source status`.split(/\s+/);
type Field = "cwd" | "session_root";
type Index = 0 | 1 | 2 | 3;
type Context = { readonly root: string; readonly databasePath: string };
const NULLABLE = new Set<string>(["open_webui_folder_name", "open_webui_folder_id", "session_root"]);
const CURRENT: readonly fixture.RawColumn[] = NAMES.map(name => ({ name, definition: definition(name) }));
const LEGACY = CURRENT.toSpliced(4, 0, { name: "model_id", definition: definition("model_id") });
const PROTECTED = "Project paths must not overlap protected GJC runtime paths.";
const INCOMPATIBLE = "Project registration database is incompatible.";

afterEach(fixture.removeWorkspaces);

test("rejects the bijective 32-case DELETE-journal matrix before projection writes", async () => {
	// Given: current/legacy × linked/unlinked × cwd/session_root × four protected paths.
	const seen = new Set<string>();
	for (const legacy of [false, true])
		for (const status of ["linked", "unlinked"] as const)
			for (const field of ["cwd", "session_root"] as const)
				for (const index of [0, 1, 2, 3] as const) {
					seen.add(`${legacy}:${status}:${field}:${index}`);
					// When: the builder audits raw DELETE state. Then: source and projection remain unchanged.
					await protectedCase(legacy, status, field, index);
				}
	expect(seen.size).toBe(32);
}, 30_000);

test("rejects WAL-only current linked cwd with a 0-to-1 row witness", async () => {
	// Given: main-only has zero rows while a private current main+WAL clone has one protected row.
	// When: startup audits a private clone. Then: the exact error leaves the source family immutable.
	await walCase(false);
});

test("rejects WAL-only exact legacy unlinked session_root with a 0-to-1 row witness", async () => {
	// Given: main-only has zero rows while a private exact-legacy main+WAL clone has one protected row.
	// When: startup audits a private clone. Then: the exact error leaves the source family immutable.
	await walCase(true);
});

test("rejects every incompatible schema and row domain without mutation", async () => {
	// Given: malformed/view/legacy-extra, every missing column, and every invalid storage domain.
	for (const kind of ["malformed", "legacy-extra", "view"]) await incompatibleCase(kind);
	for (const column of NAMES) {
		await incompatibleCase("missing", column);
		await incompatibleCase("invalid", column);
	}
	// When: each boundary is audited. Then: every result is the exact private error.
});

for (const kind of ["uppercase-model", "hidden-model", "virtual", "index"])
	test(`rejects ${kind} schema spoof without mutation`, async () => incompatibleCase(kind));

test("rejects rollback, aliases, every orphan/sidecar, and nonregular main variants", async () => {
	// Given: rollback, dangling/fixed aliases, orphan WAL/SHM/journal, sidecar WAL/SHM, directory, and FIFO.
	for (const kind of `journal dangling fixed orphan-wal orphan-shm orphan-journal sidecar-wal sidecar-shm
sidecar-directory main-directory main-fifo`.split(/\s+/))
		await filesystemCase(kind);
	// When: each family is audited. Then: exact errors win without source mutation.
});

async function protectedCase(legacy: boolean, status: "linked" | "unlinked", field: Field, index: Index) {
	const context = await makeContext("matrix");
	const protectedPath = protectedPaths(context.root)[index];
	const row = rawRow(context, {
		cwd: field === "cwd" ? protectedPath : path.join(context.root, "safe"),
		session_root: field === "session_root" ? protectedPath : null,
		status,
	});
	const tableName = legacy ? "project_registration" : "Project_Registration";
	await writeTable(context.databasePath, legacy ? LEGACY : CURRENT, row, tableName);
	await expectRejected(context, PROTECTED, `${legacy}:${status}:${field}:${index}`);
}

async function walCase(legacy: boolean) {
	const context = await makeContext("wal");
	const columns = legacy ? LEGACY : CURRENT;
	await writeTable(context.databasePath, columns);
	const writer = new Database(context.databasePath);
	writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
	const row = rawRow(
		context,
		legacy
			? { cwd: path.join(context.root, "safe"), session_root: protectedPaths(context.root)[3], status: "unlinked" }
			: { cwd: protectedPaths(context.root)[0] },
	);
	fixture.insertRawRow(writer, columns, row, "project_registration");
	const mainOnlyPath = path.join(context.root, "main-only.sqlite");
	const clonePath = path.join(context.root, "main-wal.sqlite");
	await Promise.all([
		fixture.copySourceFamily(context.databasePath, mainOnlyPath, [""]),
		fixture.copySourceFamily(context.databasePath, clonePath, ["", "-wal"]),
	]);
	expect(await Bun.file(`${clonePath}-shm`).exists()).toBe(false);
	const mainOnly = new Database(mainOnlyPath, { readonly: true, create: false });
	const clone = new Database(clonePath, { readonly: true, create: false });
	expect([rowCount(mainOnly), rowCount(clone)]).toEqual([0, 1]);
	for (const database of [mainOnly, clone]) database.close();
	if (legacy) await expectRejected(context, PROTECTED);
	else await rejectWithCleanupFailures(context);
	writer.close();
}

async function incompatibleCase(kind: string, column?: string) {
	const context = await makeContext(`incompatible-${kind}`);
	if (kind === "malformed")
		await fixture.materializeFilesystem([{ kind: "file", path: context.databasePath, contents: "not sqlite" }]);
	else if (kind === "view" || kind === "index")
		await fixture.writeSqlDatabase(
			context.databasePath,
			kind === "view"
				? ["CREATE VIEW Project_Registration AS SELECT 1 AS id"]
				: ["CREATE TABLE sentinel (value TEXT)", "CREATE INDEX Project_Registration ON sentinel(value)"],
		);
	else {
		const columns = schemaColumns(kind, column);
		await writeTable(
			context.databasePath,
			columns,
			incompatibleRow(context, kind, column),
			undefined,
			kind === "virtual" ? "fts5" : undefined,
		);
	}
	await expectRejected(context, INCOMPATIBLE);
}

async function filesystemCase(kind: string) {
	const context = await makeContext(`filesystem-${kind}`);
	if (kind === "main-directory")
		await fixture.materializeFilesystem([{ kind: "directory", path: context.databasePath }]);
	else if (kind === "main-fifo") {
		const result = await fixture.createFifo(context.databasePath, context.root);
		expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
	} else if (kind === "dangling")
		await fixture.materializeFilesystem([
			{ kind: "symlink", path: context.databasePath, target: targetPath(context) },
		]);
	else if (kind.startsWith("orphan-"))
		await fixture.materializeFilesystem([
			{ kind: "file", path: `${context.databasePath}-${kind.slice(7)}`, contents: "orphan" },
		]);
	else {
		const source = kind === "fixed" ? targetPath(context) : context.databasePath;
		await writeTable(
			source,
			CURRENT,
			rawRow(context, { cwd: kind === "fixed" ? protectedPaths(context.root)[1] : path.join(context.root, "safe") }),
		);
		const suffix = kind === "sidecar-directory" ? "wal" : kind.startsWith("sidecar-") ? kind.slice(8) : "journal";
		const sentinel = path.join(context.root, "sentinel");
		const entries: fixture.FilesystemEntry[] =
			kind === "fixed"
				? [{ kind: "symlink", path: context.databasePath, target: targetPath(context) }]
				: kind === "sidecar-directory"
					? [{ kind: "directory", path: `${source}-${suffix}` }]
					: kind.startsWith("sidecar-")
						? [
								{ kind: "file", path: sentinel, contents: suffix },
								{ kind: "symlink", path: `${source}-${suffix}`, target: sentinel },
							]
						: [{ kind: "file", path: `${source}-journal`, contents: "rollback" }];
		await fixture.materializeFilesystem(entries);
	}
	await expectRejected(context, kind === "fixed" ? PROTECTED : INCOMPATIBLE);
}

async function expectRejected(context: Context, message: string, label = message) {
	const before = await fixture.snapshotSourceFamily(context.databasePath);
	const repository = new InMemoryOpenWebUIProjectionRepository();
	const runner = new FakeGjcTurnRunner();
	const writes = [
		...(["upsertFolder", "upsertChat", "replaceChatMessages"] as const).map(method => spyOn(repository, method)),
		spyOn(Bun, "serve"),
	];
	const error = await buildAdapterServerOptionsFromEnv(runtimeEnv(context.root), {
		projectionRepository: repository,
		turnRunner: runner,
	}).catch(value => value);
	if (!(error instanceof Error)) throw new Error("Expected operation to fail.");
	expect([error.name, error.message]).toEqual([message === PROTECTED ? "ProjectLinkError" : "Error", message]);
	if (message === PROTECTED) expect(error).toHaveProperty("code", "invalid_project_link");
	expect([...writes.map(write => write.mock.calls.length), runner.starts.length]).toEqual([0, 0, 0, 0, 0]);
	for (const write of writes) write.mockRestore();
	expect(await fixture.snapshotSourceFamily(context.databasePath), label).toEqual(before);
}

async function rejectWithCleanupFailures(context: Context) {
	const originalClose = Database.prototype.close,
		originalRemove = fs.rm;
	const secondary = Object.freeze(new Error("secondary clone cleanup failure"));
	const close = spyOn(Database.prototype, "close").mockImplementation(function (this: Database) {
		originalClose.call(this);
		throw secondary;
	});
	const remove = spyOn(fs, "rm").mockImplementation(async (target, options) => {
		await originalRemove(target, options);
		throw secondary;
	});
	await expectRejected(context, PROTECTED);
	expect([close.mock.calls.length, remove.mock.calls.length]).toEqual([1, 1]);
	await expect(fs.readdir(String(remove.mock.calls[0]?.[0]))).rejects.toHaveProperty("code", "ENOENT");
	for (const mock of [close, remove]) mock.mockRestore();
}

const writeTable = (
	databasePath: string,
	columns: readonly fixture.RawColumn[],
	row?: fixture.RawRow,
	tableName = "project_registration",
	virtualModule?: string,
) => fixture.writeRawTable(databasePath, columns, tableName, "DELETE", row, undefined, virtualModule);
function schemaColumns(kind: string, column?: string): readonly fixture.RawColumn[] {
	if (kind === "legacy-extra") return [...LEGACY, { name: "future", definition: "future TEXT" }];
	if (kind === "uppercase-model") return [...CURRENT, { name: "MODEL_ID", definition: "MODEL_ID TEXT" }];
	if (kind === "hidden-model")
		return [...CURRENT, { name: "model_id", definition: "model_id TEXT AS (cwd) VIRTUAL", insert: false }];
	if (kind === "virtual") return CURRENT.map(value => ({ ...value, definition: `${value.name} UNINDEXED` }));
	return CURRENT.filter(value => value.name !== (kind === "missing" ? column : undefined));
}
function incompatibleRow(context: Context, kind: string, column?: string): fixture.RawRow {
	if (kind === "invalid" && column !== undefined) return rawRow(context, { [column]: invalidValue(column) });
	if (kind === "legacy-extra") return rawRow(context, { future: "future" });
	const cwd = protectedPaths(context.root)[0];
	if (kind === "uppercase-model") return rawRow(context, { MODEL_ID: "legacy-model", cwd });
	return rawRow(context, kind === "hidden-model" || kind === "virtual" ? { cwd } : {});
}
const rowCount = (db: Database) => db.query<{ n: number }, []>("SELECT COUNT(*) n FROM project_registration").get()?.n;
const targetPath = (context: Context) => path.join(context.root, "target", "registrations.sqlite");
function definition(name: string) {
	if (name === "id") return "id TEXT PRIMARY KEY";
	if (name === "cwd" || name === "model_id") return `${name} TEXT NOT NULL UNIQUE`;
	return `${name} TEXT${NULLABLE.has(name) ? "" : " NOT NULL"}`;
}
function rawRow(context: Context, overrides: Readonly<Record<string, fixture.SqlValue>> = {}): fixture.RawRow {
	return Object.assign(
		{ id: "project", name: "Project", open_webui_folder_name: "Project" },
		{ cwd: path.join(context.root, "safe"), model_id: "legacy-model", open_webui_folder_id: "folder" },
		{ allowed_root: context.root, session_root: null, created_at: "2026-07-13T00:00:00.000Z" },
		{ updated_at: "2026-07-13T00:01:00.000Z", source: "admin", status: "linked" },
		overrides,
	);
}
function protectedPaths(root: string): readonly [string, string, string, string] {
	const domain = path.join(root, "home", ".gjc");
	const reader = path.join(domain, "openwebui/default-reader");
	return [domain, path.join(domain, "agent"), reader, path.join(reader, ".gjc/sessions")];
}
async function makeContext(label: string): Promise<Context> {
	const root = await fixture.makeWorkspace(`gjc-preflight-${label}`, ["home", "state"]);
	return { root, databasePath: path.join(root, "state", "adapter-state.sqlite") };
}
function runtimeEnv(root: string): Record<string, string | undefined> {
	return {
		...process.env,
		HOME: path.join(root, "home"),
		GJC_OPENWEBUI_STATE_PATH: path.join(root, "state"),
		GJC_OPENWEBUI_SESSION_ROOT: path.join(root, "sessions"),
		GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: root,
	};
}
function invalidValue(name: string): fixture.SqlValue {
	if (name === "source" || name === "status") return "invalid";
	return name === "created_at" || name === "updated_at" ? "not-a-date" : new Uint8Array([0, 1]);
}
