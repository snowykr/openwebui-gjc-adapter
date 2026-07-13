import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { throws } from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildAdapterServerOptionsFromEnv as buildOptions } from "../src/adapter-server-options";
import { ProjectLinkError as LinkError } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore as RegistrationStore } from "../src/projects/registration-store";
import { reserveTcpPort } from "./cli-fixtures";
import * as fixture from "./project-registration-startup-preflight-fixtures";

const NAMES = `id name open_webui_folder_name cwd open_webui_folder_id allowed_root
session_root created_at updated_at source status`.split(/\s+/);
const NULLABLE = new Set<string>(["open_webui_folder_name", "open_webui_folder_id", "session_root"]);
const CURRENT: readonly fixture.RawColumn[] = NAMES.map(name => ({ name, definition: definition(name) }));
const LEGACY = CURRENT.toSpliced(4, 0, { name: "model_id", definition: definition("model_id") });
const PROTECTED = "Project paths must not overlap protected GJC runtime paths.";

afterEach(fixture.removeWorkspaces);

test("admits every compatible store and preserves the exact legacy row", async () => {
	// Given: missing, zero, no-table, current, forward, user-version, and exact legacy stores.
	for (const kind of ["missing", "zero", "no-table", "current", "forward", "user-version", "legacy"])
		await compatibleCase(kind);
	// When: preflight admits each source. Then: only normal initialization creates or migrates it.
});

test("shipped CLI rejects the current linked cwd row before every effect", async () => {
	// Given: a current linked cwd row and literal shipped argv.
	// When: the literal shipped command runs. Then: all raw effects remain zero or unchanged.
	await cliCase(false, [process.execPath, "run", "start"]);
}, 10_000);

test("shipped CLI rejects the exact legacy unlinked session_root row before every effect", async () => {
	// Given: an exact legacy unlinked session_root row and literal shipped argv.
	// When: the literal shipped command runs. Then: all raw effects remain zero or unchanged.
	await cliCase(true, [process.execPath, "run", "start"]);
}, 10_000);

test("lifecycle keeps an injected rejected store caller-owned", async () => {
	// Given: an injected store containing a protected registration.
	const context = await makeContext("injected");
	const store = new RegistrationStore(":memory:");
	store.linkProject(projectRecord(context.root, protectedDomain(context.root)), "admin");
	const close = spyOn(RegistrationStore.prototype, "close");
	// When: its initial audit rejects. Then: the caller remains its only owner.
	await expect(buildOptions(runtimeEnv(context.root), { projectRegistrationStore: store })).rejects.toBeInstanceOf(
		LinkError,
	);
	expect(close).toHaveBeenCalledTimes(0);
	close.mockRestore();
	store.close();
});

test("lifecycle closes one internal store without replacing the primary error", async () => {
	// Given: internal creation, a deterministic realpath sentinel, and a secondary close failure.
	const context = await makeContext("internal");
	const missing = path.join(context.root, "missing");
	const primary = Object.freeze(new Error("primary realpath failure"));
	const secondary = Object.freeze(new Error("secondary close failure"));
	const originalRealpath = fs.realpath;
	const realpath = spyOn(fs, "realpath");
	for (let index = 0; index < 4; index += 1) realpath.mockImplementationOnce(originalRealpath);
	realpath.mockRejectedValueOnce(primary);
	const original = RegistrationStore.prototype.close;
	const close = spyOn(RegistrationStore.prototype, "close").mockImplementation(closeAfter(original, secondary));
	// When: allowed-root resolution rejects. Then: one close preserves the sentinel and releases descriptors.
	await expect(buildOptions(runtimeEnv(context.root, missing))).rejects.toBe(primary);
	expect([realpath.mock.calls.at(-1), close.mock.calls.length]).toEqual([[missing], 1]);
	for (const mock of [realpath, close]) mock.mockRestore();
	expect(await fixture.openFileDescriptors(context.databasePath)).toEqual([]);
});

test("lifecycle closes constructor-local handles while preserving initialization errors", async () => {
	// Given: WAL, schema, and migration initialization failures.
	for (const kind of ["wal", "schema", "migration"]) {
		const databasePath = await constructorCase(kind);
		const artifacts = await fixture.existingSourceArtifacts(databasePath);
		const primary = Object.freeze(new Error(`primary ${kind} failure`));
		const secondary = Object.freeze(new Error(`secondary ${kind} cleanup failure`));
		const execute = failingExec(kind, primary, secondary);
		const originalClose = Database.prototype.close;
		const close = spyOn(Database.prototype, "close").mockImplementation(closeAfter(originalClose, secondary));
		// When: construction rejects. Then: one close preserves the primary error and releases descriptors.
		throws(
			() => new RegistrationStore(databasePath),
			error => error === primary,
		);
		expect(close).toHaveBeenCalledTimes(1);
		for (const mock of [execute, close]) mock.mockRestore();
		expect(await fixture.existingSourceArtifacts(databasePath)).toEqual(expect.arrayContaining(artifacts));
		expect(await fixture.openFileDescriptors(databasePath)).toEqual([]);
	}
});
async function compatibleCase(kind: string) {
	const context = await makeContext(`compatible-${kind}`);
	if (kind === "zero")
		await fixture.materializeFilesystem([{ kind: "file", path: context.databasePath, contents: "" }]);
	else if (kind === "no-table")
		await fixture.writeRawDatabase({
			kind: "sql",
			databasePath: context.databasePath,
			statements: ["CREATE TABLE unrelated (value TEXT)"],
		});
	else if (kind !== "missing") {
		const columns =
			kind === "legacy"
				? LEGACY
				: kind === "forward"
					? [...CURRENT, { name: "future", definition: "future TEXT" }]
					: CURRENT;
		await writeTable(
			context.databasePath,
			columns,
			rawRow(
				context.root,
				kind === "forward" ? { future: "future" } : kind === "legacy" ? { model_id: "legacy-model" } : {},
			),
			kind === "user-version" ? 77 : undefined,
		);
	}
	if (kind === "current" || kind === "legacy") {
		const before = await fixture.snapshotSourceFamily(context.databasePath);
		const primary = Object.freeze(new Error(`primary ${kind} writable pragma failure`));
		const execute = failingExec("wal", primary);
		await expect(buildOptions(runtimeEnv(context.root))).rejects.toBe(primary);
		execute.mockRestore();
		expect(await fixture.snapshotSourceFamily(context.databasePath)).toEqual(before);
	}
	const missing = path.join(context.root, "missing");
	await expect(buildOptions(runtimeEnv(context.root, missing))).rejects.toHaveProperty("code", "ENOENT");
	const database = new Database(context.databasePath, { readonly: true, create: false, strict: true });
	const names = database.query("PRAGMA table_info(project_registration)").all().map(fixture.columnName);
	if (kind === "legacy") {
		expect(names).toEqual([...NAMES]);
		expect(database.query(`SELECT ${NAMES.join(",")} FROM project_registration`).get()).toEqual(rawRow(context.root));
	} else expect(names).toEqual(kind === "forward" ? [...NAMES, "future"] : NAMES);
	if (kind === "no-table")
		expect(database.query("PRAGMA table_list").all().map(fixture.columnName)).toContain("unrelated");
	if (kind === "user-version") expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 77 });
	database.close();
}

async function cliCase(legacy: boolean, argv: readonly string[]) {
	const context = await makeContext("cli");
	const row = rawRow(
		context.root,
		legacy
			? {
					cwd: path.join(context.root, "safe"),
					model_id: "legacy-model",
					session_root: sessionRoot(context.root),
					status: "unlinked",
				}
			: { cwd: protectedDomain(context.root) },
	);
	await writeTable(context.databasePath, legacy ? LEGACY : CURRENT, row);
	const before = await fixture.snapshotSourceFamily(context.databasePath);
	const port = await reserveTcpPort();
	const marker = path.join(context.root, "runner-marker");
	const tmp = path.join(context.root, "tmp");
	const command = path.join(context.root, "runner.sh");
	await fixture.materializeFilesystem([
		{ kind: "directory", path: tmp },
		{ kind: "file", path: command, contents: `#!/bin/sh\nprintf invoked > '${marker}'\n`, mode: 0o700 },
	]);
	let requests = 0;
	const openWebUI = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests += 1;
			return new Response("unexpected");
		},
	});
	const result = await fixture
		.runProcess({
			argv,
			cwd: path.resolve(import.meta.dir, ".."),
			deadlineMs: 4_000,
			terminationGraceMs: 500,
			env: {
				...process.env,
				...runtimeEnv(context.root),
				TMPDIR: tmp,
				GJC_OPENWEBUI_BASE_URL: openWebUI.url.toString(),
				GJC_OPENWEBUI_API_TOKEN: "openwebui-token",
				GJC_OPENWEBUI_BIND_PORT: String(port),
				GJC_OPENWEBUI_GJC_COMMAND: command,
				PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
			},
		})
		.finally(() => openWebUI.stop(true));
	expect([result.exitCode, result.timedOut, result.stdout, result.stderr]).toEqual([
		1,
		false,
		"",
		`$ bun run src/cli.ts\n${PROTECTED}\nerror: script "start" exited with code 1\n`,
	]);
	expect({ requests, runner: await Bun.file(marker).exists() }).toEqual({ requests: 0, runner: false });
	expect(await fixture.snapshotSourceFamily(context.databasePath)).toEqual(before);
	expect(await fixture.openFileDescriptors(context.databasePath)).toEqual([]);
	expect(await fs.readdir(tmp)).toEqual([]);
	const listener = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("free") });
	await listener.stop(true);
}

function definition(name: string) {
	if (name === "id") return "id TEXT PRIMARY KEY";
	if (name === "cwd" || name === "model_id") return `${name} TEXT NOT NULL UNIQUE`;
	return `${name} TEXT${NULLABLE.has(name) ? "" : " NOT NULL"}`;
}
const writeTable = (
	databasePath: string,
	columns: readonly fixture.RawColumn[],
	row?: fixture.RawRow,
	version?: number,
) => fixture.writeRawTable(databasePath, columns, "project_registration", "DELETE", row, version);
function rawRow(root: string, overrides: Readonly<Record<string, fixture.SqlValue>> = {}): fixture.RawRow {
	return Object.assign(
		{ id: "project", name: "Project", open_webui_folder_name: "Project" },
		{ cwd: path.join(root, "safe"), open_webui_folder_id: "folder", allowed_root: root },
		{ session_root: null, created_at: "2026-07-13T00:00:00.000Z", updated_at: "2026-07-13T00:01:00.000Z" },
		{ source: "admin", status: "linked" },
		overrides,
	);
}
const protectedDomain = (root: string) => path.join(root, "home", ".gjc");
const sessionRoot = (root: string) => path.join(protectedDomain(root), "openwebui/default-reader/.gjc/sessions");
async function makeContext(label: string) {
	const root = await fixture.makeWorkspace(`gjc-preflight-${label}`, ["home"]);
	return { root, databasePath: path.join(root, "state", "adapter-state.sqlite") };
}
function runtimeEnv(root: string, allowedRoot = root): Record<string, string | undefined> {
	return Object.assign({}, process.env, {
		HOME: path.join(root, "home"),
		GJC_OPENWEBUI_STATE_PATH: path.join(root, "state"),
		GJC_OPENWEBUI_SESSION_ROOT: path.join(root, "sessions"),
		GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: allowedRoot,
	});
}
function projectRecord(root: string, cwd: string) {
	return { id: "unsafe", name: "unsafe", cwd, allowedRoot: root, createdAt: new Date("2026-07-13T00:00:00.000Z") };
}
async function constructorCase(kind: string) {
	const context = await makeContext(`constructor-${kind}`);
	const databasePath = path.join(context.root, "registrations.sqlite");
	const columns = kind === "migration" ? LEGACY : CURRENT;
	await writeTable(databasePath, columns, rawRow(context.root, { model_id: "legacy-model" }));
	return databasePath;
}
function closeAfter<T>(original: (this: T) => unknown, secondary: Error) {
	return function (this: T) {
		original.call(this);
		throw secondary;
	};
}
function failingExec(kind: string, primary: Error, secondary?: Error) {
	const original = Database.prototype.exec;
	return spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, sql) {
		const statement = String(sql);
		const fails =
			kind === "wal"
				? statement === "PRAGMA journal_mode = WAL"
				: statement.includes(kind === "schema" ? "CREATE TABLE IF NOT EXISTS project_registration" : "ALTER TABLE");
		if (fails) throw primary;
		const result = original.call(this, sql);
		if (kind === "migration" && statement === "ROLLBACK") throw secondary;
		return result;
	});
}
