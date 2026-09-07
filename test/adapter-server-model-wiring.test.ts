import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";
import { FakeManagedSdkRuntime } from "./cli-fixtures";

async function writeV3Authority(root: string, document: unknown): Promise<void> {
	const canonicalPath = join(root, "openwebui-session-mappings.json");
	const canonical = Buffer.from(`${JSON.stringify(document)}\n`);
	await writeFile(canonicalPath, canonical);
	await writeFile(
		`${canonicalPath}.v3-active.json`,
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: createHash("sha256").update(canonical).digest("hex"),
			source: { baseDigest: "0".repeat(64), walDigest: "0".repeat(64), walPresent: false },
		})}\n`,
	);
}

describe("adapter server model wiring", () => {
	test.each(["pending", "uncertain", "conflict"] as const)(
		"unassigned %s provisional blocks SDK construction before serving startup",
		async state => {
			const root = await mkdtemp(join(tmpdir(), "adapter-provisional-admission-"));
			let constructed = false;
			try {
				const sessionRoot = join(root, "sessions");
				await mkdir(sessionRoot);
				await writeV3Authority(sessionRoot, {
					kind: "openwebui-gjc-session-authority",
					version: 3,
					authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
					mappings: [],
					provisionalOperations: [
						{
							id: "catalog-create",
							ingressId: "catalog-create",
							kind: "create",
							state,
							chatId: '["owner","chat"]',
							projectId: "project",
							startedAt: "2026-08-24T00:00:00.000Z",
						},
					],
				});
				let options: Awaited<ReturnType<typeof buildAdapterServerOptions>> | undefined;
				let failure: unknown;
				try {
					options = await buildAdapterServerOptions(
						{
							mode: "existing",
							bindHost: "127.0.0.1",
							bindPort: 8765,
							openWebUIBaseUrl: "http://127.0.0.1:3000",
							allowedProjectRoots: [],
							projects: [],
							statePath: join(root, "state"),
							sessionRoot,
							gjcCommand: "/unused",
							turnTimeoutMs: 1000,
						},
						{
							createManagedSdkRuntime: () => {
								constructed = true;
								return new FakeManagedSdkRuntime();
							},
						},
					);
				} catch (error) {
					failure = error;
				} finally {
					await options?.shutdownCleanup?.();
				}
				expect(constructed).toBe(false);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toContain("unfinished provisional");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.each(["success", "failure"] as const)(
		"startup waits for actual disposal %s before releasing local ownership",
		async outcome => {
			const root = await mkdtemp(join(tmpdir(), "adapter-startup-disposal-"));
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			const startFailure = new Error("runtime start failed");
			const stopFailure = new Error("runtime actual disposal failed");
			const accounting = new FakeManagedSdkRuntime();
			let disposal: Promise<void> | undefined;
			const close = spyOn(SqliteProjectRegistrationStore.prototype, "close");
			const listed = spyOn(SqliteProjectRegistrationStore.prototype, "listProjects");
			const statePath = join(root, "state");
			try {
				const sessionRoot = join(root, "sessions");
				await mkdir(sessionRoot);
				await writeV3Authority(sessionRoot, {
					kind: "openwebui-gjc-session-authority",
					version: 3,
					authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
					mappings: [],
					provisionalOperations: [],
				});
				const pending = buildAdapterServerOptions(
					{
						mode: "existing",
						bindHost: "127.0.0.1",
						bindPort: 8765,
						openWebUIBaseUrl: "http://127.0.0.1:3000",
						allowedProjectRoots: [],
						projects: [],
						statePath,
						sessionRoot,
						gjcCommand: "/unused",
						turnTimeoutMs: 1000,
					},
					{
						managedSdkRuntime: {
							createProducerScope: () => accounting.createProducerScope(),
							state: "new",
							start: async () => {
								throw startFailure;
							},
							dispose: () => {
								disposal ??= gate.promise;
								entered.resolve();
								return disposal;
							},
							reconcile: async () => {},
							registerTenant: () => {},
							acquireAttachment: async () => {},
							generationStatus: async () => {},
						} as never,
					},
				).catch(error => error);
				await entered.promise;
				const closedAtCleanup = close.mock.calls.length;
				await expect(RuntimeSingletonLock.acquire(statePath)).rejects.toThrow("already owned");
				if (outcome === "success") gate.resolve();
				else gate.reject(stopFailure);
				const error = await pending;
				if (outcome === "success") {
					expect(error).toBe(startFailure);
					expect(close.mock.calls.length).toBe(closedAtCleanup + 1);
					const replacement = await RuntimeSingletonLock.acquire(statePath);
					await replacement.release();
				} else {
					expect(error).toBeInstanceOf(AggregateError);
					expect(error.errors).toContain(stopFailure);
					expect(close.mock.calls.length).toBe(closedAtCleanup);
					await expect(RuntimeSingletonLock.acquire(statePath)).rejects.toThrow("already owned");
				}
			} finally {
				gate.resolve();
				const closed = new Set(close.mock.contexts);
				const stores = new Set(listed.mock.contexts);
				close.mockRestore();
				listed.mockRestore();
				for (const store of stores)
					if (store instanceof SqliteProjectRegistrationStore && !closed.has(store)) store.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.each([false, true])(
		"selects only managed dependencies with completed provisional history=%s",
		async history => {
			const root = await mkdtemp(join(tmpdir(), "gjc-adapter-managed-model-wiring-"));
			const calls: string[] = [];
			const accounting = new FakeManagedSdkRuntime();
			const managedRuntime = {
				createProducerScope: () => accounting.createProducerScope(),
				state: "new",
				start: async () => void calls.push("managed-start"),
				dispose: async () => void calls.push("managed-dispose"),
				reconcile: async () => undefined,
				registerTenant: () => undefined,
				acquireAttachment: async () => undefined,
				generationStatus: async () => ({ status: "current" as const }),
			};
			try {
				const sessionRoot = join(root, "sessions");
				await mkdir(sessionRoot, { recursive: true });
				await writeV3Authority(sessionRoot, {
					kind: "openwebui-gjc-session-authority",
					version: 3,
					authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
					mappings: [],
					provisionalOperations: history
						? [
								{
									id: "completed",
									kind: "create",
									state: "complete",
									chatId: '["owner","chat"]',
									projectId: "project",
									startedAt: "2026-08-24T00:00:00.000Z",
									completedAt: "2026-08-24T00:00:00.000Z",
								},
							]
						: [],
				});
				const options = await buildAdapterServerOptions(
					{
						mode: "existing",
						bindHost: "127.0.0.1",
						bindPort: 8765,
						openWebUIBaseUrl: "http://127.0.0.1:3000",
						allowedProjectRoots: [],
						projects: [],
						statePath: join(root, "state"),
						sessionRoot,
						gjcCommand: "/not-used-for-managed-v3",
						turnTimeoutMs: 240_000,
					},
					{ managedSdkRuntime: managedRuntime as never },
				);

				expect(options.routes?.runner).toBeDefined();
				const selectedModelReaderFactory = options.routes?.modelReaderFactory;
				expect(selectedModelReaderFactory).toBeDefined();
				expect(options.turnTimeoutMs).toBe(240_000);
				expect(options.routes?.neutralWorkspace).toEndWith("/.gjc/openwebui/default-reader");
				await expect(selectedModelReaderFactory!()).rejects.toThrow(
					"Managed model catalog access requires explicit tenant or temporary service authority.",
				);
				expect(calls).toEqual(["managed-start"]);
				await options.shutdownCleanup?.();
				expect(calls).toEqual(["managed-start", "managed-dispose"]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test("fails closed for malformed V3 authority before startup effects", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-malformed-v3-"));
		const calls: string[] = [];
		try {
			const sessionRoot = join(root, "sessions");
			await mkdir(sessionRoot, { recursive: true });
			await writeV3Authority(sessionRoot, {
				kind: "openwebui-gjc-session-authority",
				version: 3,
				authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
				mappings: [{}],
				provisionalOperations: [],
			});
			await expect(
				buildAdapterServerOptions(
					{
						mode: "existing",
						bindHost: "127.0.0.1",
						bindPort: 8765,
						openWebUIBaseUrl: "http://127.0.0.1:3000",
						allowedProjectRoots: [],
						projects: [],
						statePath: join(root, "state"),
						sessionRoot,
						gjcCommand: "/not-used-for-malformed-v3",
						turnTimeoutMs: 240_000,
					},
					{ managedSdkRuntime: { start: async () => void calls.push("managed-start") } as never },
				),
			).rejects.toThrow("Canonical session authority activation is blocked.");
			expect(calls).toEqual([]);
			await expect(stat(join(root, "state"))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
