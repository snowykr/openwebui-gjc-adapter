import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSessionAuthorityEpoch } from "../src/gjc/session-authority-epoch";
import { AuthorityMutationLock } from "../src/gjc/session-authority-file";
import { FileSessionAuthority } from "../src/gjc/session-authority-persistence";
import {
	activateSessionAuthorityV3,
	type SessionAuthorityV3ActivationBoundary,
	type SessionAuthorityV3ActivationOptions,
} from "../src/gjc/session-authority-v3-activation";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gjc-v3-activation-"));
	const canonicalPath = join(root, "authority.json");
	const original = Buffer.from('{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n');
	await writeFile(canonicalPath, original);
	const runtimeLock = await RuntimeSingletonLock.acquire(root);
	const invoke = async (options: Omit<SessionAuthorityV3ActivationOptions, "runtimeLock" | "mutationLock">) => {
		const mutationLock = AuthorityMutationLock.acquire(canonicalPath);
		try {
			return await activateSessionAuthorityV3({ ...options, runtimeLock, mutationLock });
		} finally {
			mutationLock.release();
		}
	};
	return {
		root,
		canonicalPath,
		original,
		runtimeLock,
		invoke,
		activate: (afterBoundary?: (boundary: SessionAuthorityV3ActivationBoundary) => void) =>
			invoke({
				canonicalPath,
				stagingRoot: join(root, "private"),
				bindings: [],
				afterBoundary,
			}),
		cleanup: async () => {
			await runtimeLock.release();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("session authority V3 activation", () => {
	test.each(["runtime", "mutation"] as const)("rejects released %s ownership before snapshot effects", async kind => {
		const f = await fixture();
		const mutationLock = AuthorityMutationLock.acquire(f.canonicalPath);
		try {
			if (kind === "runtime") await f.runtimeLock.release();
			else mutationLock.release();
			await expect(
				activateSessionAuthorityV3({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					runtimeLock: f.runtimeLock,
					mutationLock,
					bindings: [],
				}),
			).rejects.toThrow();
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			await expect(stat(join(f.root, "private"))).rejects.toThrow();
		} finally {
			mutationLock.release();
			await f.cleanup();
		}
	});

	test("rejects a mutation capability for another canonical path", async () => {
		const f = await fixture();
		const wrong = AuthorityMutationLock.acquire(join(f.root, "other.json"));
		try {
			await expect(
				activateSessionAuthorityV3({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					runtimeLock: f.runtimeLock,
					mutationLock: wrong,
					bindings: [],
				}),
			).rejects.toThrow("requested path");
			await expect(stat(join(f.root, "private"))).rejects.toThrow();
		} finally {
			wrong.release();
			await f.cleanup();
		}
	});

	test("an expired mutation lease cannot replace original authority", async () => {
		const f = await fixture();
		const now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			await expect(
				f.activate(boundary => {
					if (boundary === "committing") clock.mockImplementation(() => now + 30_001);
				}),
			).rejects.toThrow("mutation lease ownership was lost");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			await expect(readFile(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
			clock.mockRestore();
			expect((await f.activate()).status).toBe("activated");
		} finally {
			clock.mockRestore();
			await f.cleanup();
		}
	});

	test("a borrowed constructor lock cannot reopen after release", async () => {
		const f = await fixture();
		try {
			expect((await f.activate()).status).toBe("activated");
			const lock = AuthorityMutationLock.acquire(f.canonicalPath);
			new V3FileBackedSessionMappingStore(f.canonicalPath, lock).close();
			lock.assertHeld(f.canonicalPath);
			lock.release();
			expect(() => new V3FileBackedSessionMappingStore(f.canonicalPath, lock)).toThrow("does not own");
		} finally {
			await f.cleanup();
		}
	});

	test.each(["snapshot", "backup"] as const)(
		"lost mutation ownership after %s prevents manifest and replay effects",
		async phase => {
			const f = await fixture();
			const lock = AuthorityMutationLock.acquire(f.canonicalPath);
			const path = `${f.canonicalPath}.lock`;
			let replaced = false;
			try {
				await expect(
					activateSessionAuthorityV3({
						canonicalPath: f.canonicalPath,
						runtimeLock: f.runtimeLock,
						mutationLock: lock,
						stagingRoot: join(f.root, "private"),
						bindings: [],
						afterBoundary: boundary => {
							if (boundary !== phase) return;
							const bytes = readFileSync(path);
							renameSync(path, `${path}.retained`);
							writeFileSync(path, bytes);
							replaced = true;
						},
					}),
				).rejects.toThrow("mutation lease ownership was lost");
				const root = join(
					f.root,
					"private",
					`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
				);
				await expect(stat(join(root, "source-manifest.json"))).rejects.toThrow();
				await expect(stat(join(root, "replay.v2.json"))).rejects.toThrow();
				if (phase === "snapshot") await expect(stat(join(root, "source.v2.json"))).rejects.toThrow();
				expect(await readFile(f.canonicalPath)).toEqual(f.original);
			} finally {
				if (replaced) await rename(`${path}.retained`, path);
				lock.release();
				await f.cleanup();
			}
		},
	);

	test("losing the runtime lock during binding cannot commit staged authority", async () => {
		const f = await fixture();
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					resolveBindings: async () => {
						await f.runtimeLock.release();
						return [];
					},
				}),
			).rejects.toThrow("released");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			await expect(readFile(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
		} finally {
			await f.cleanup();
		}
	});

	test("rejects a live runtime capability rooted outside the authority", async () => {
		const f = await fixture();
		const foreign = await fixture();
		const mutationLock = AuthorityMutationLock.acquire(f.canonicalPath);
		try {
			await expect(
				activateSessionAuthorityV3({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					runtimeLock: foreign.runtimeLock,
					mutationLock,
					bindings: [],
				}),
			).rejects.toThrow("does not own the requested authority path");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			await expect(stat(join(f.root, "private"))).rejects.toThrow();
		} finally {
			mutationLock.release();
			await foreign.cleanup();
			await f.cleanup();
		}
	});

	test.each(["runtime", "mutation"] as const)(
		"same-owner %s lock inode substitution revokes its capability",
		async kind => {
			const f = await fixture();
			const mutationLock = AuthorityMutationLock.acquire(f.canonicalPath);
			const path = kind === "runtime" ? join(f.root, ".openwebui-gjc-adapter.lock") : `${f.canonicalPath}.lock`;
			const retained = `${path}.retained`;
			try {
				const bytes = await readFile(path);
				await rename(path, retained);
				await writeFile(path, bytes);
				await expect(
					activateSessionAuthorityV3({
						canonicalPath: f.canonicalPath,
						stagingRoot: join(f.root, "private"),
						runtimeLock: f.runtimeLock,
						mutationLock,
						bindings: [],
					}),
				).rejects.toThrow("ownership");
				expect(await readFile(path)).toEqual(bytes);
				await expect(stat(join(f.root, "private"))).rejects.toThrow();
			} finally {
				await rename(retained, path);
				mutationLock.release();
				await f.cleanup();
			}
		},
	);

	test("replays a private V2 copy before resolving bindings and leaves the source bytes untouched", async () => {
		const f = await fixture();
		const original = Buffer.from(
			`${JSON.stringify({
				kind: "openwebui-gjc-session-authority",
				version: 2,
				mappings: [
					{
						version: 2,
						chatId: "chat-replayed",
						projectId: "project-replayed",
						sessionId: "session-replayed",
						createdAt: "2026-01-01T00:00:00.000Z",
						header: { chatId: "chat-replayed", projectId: "project-replayed", sessionId: "session-replayed" },
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: "operation-replayed",
						journal: [],
					},
				],
				provisionalOperations: [],
			})}\n`,
		);
		const wal = Buffer.alloc(0);
		try {
			await writeFile(f.canonicalPath, original);
			await writeFile(`${f.canonicalPath}.wal`, wal);
			let callbackObserved = false;
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: async (graph, context) => {
					expect(await readFile(f.canonicalPath)).toEqual(original);
					expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
					expect(graph.mappings).toHaveLength(1);
					const staged = new V3FileBackedSessionMappingStore(context.stagedPath);
					expect(staged.get("chat-replayed")).toBeUndefined();
					staged.close();
					const historical = JSON.parse(await readFile(context.stagedPath, "utf8"));
					expect(historical.mappings[0].historicalBinding.provenance.nodeRef).toBe("/mappings/0");
					expect(historical.mappings[0].managedAuthority).toBeUndefined();
					expect(context.manifestDigest).toBe(
						digest(await readFile(join(context.stagedPath, "..", "source-manifest.json"))),
					);
					callbackObserved = true;
					return [
						{
							nodeRef: "/mappings/0",
							chatId: "chat-replayed",
							projectId: "project-replayed",
							sessionId: "session-replayed",
							managedAuthority: {
								principalId: "principal-replayed",
								projectId: "project-replayed",
								canonicalWorkspace: "/workspace/project-replayed",
								chatId: "chat-replayed",
								sessionId: "session-replayed",
								generation: 1,
								leaseId: "lease-replayed",
								epoch: "managed/1",
								requestKey: "request-replayed",
							},
						},
					];
				},
			});
			expect(callbackObserved).toBe(true);
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const backupRoot = join(
				f.root,
				"private",
				`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
			);
			expect(await readFile(join(backupRoot, "source.v2.json"))).toEqual(original);
			expect(await readFile(join(backupRoot, "source.v2.wal"))).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});

	test("blocks when canonical V2 bytes change during binding resolution", async () => {
		const f = await fixture();
		try {
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: async () => {
					await writeFile(f.canonicalPath, Buffer.from('{"kind":"changed"}\n'));
					return [];
				},
			});
			expect(result).toMatchObject({ status: "blocked" });
			if (result.status !== "blocked") throw new Error("Changed source unexpectedly activated.");
			expect(result.reasons?.join(" ")).toContain("changed during private replay");
		} finally {
			await f.cleanup();
		}
	});

	test("private replay retains acknowledged WAL-only mappings without touching source bytes", async () => {
		const f = await fixture();
		try {
			const source = new FileSessionAuthority(f.canonicalPath);
			for (const id of ["base", "wal-only"])
				source.set({
					chatId: id,
					projectId: "project",
					sessionId: id,
					operationId: id,
					rawFrameCursor: 0,
					eventCursor: 0,
				});
			const base = await readFile(f.canonicalPath),
				wal = await readFile(`${f.canonicalPath}.wal`);
			expect(JSON.parse(base.toString()).mappings).toHaveLength(1);
			expect(wal.length).toBeGreaterThan(0);
			let observed = false;
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: async graph => {
					observed = true;
					expect(graph.mappings.map(mapping => mapping.chatId)).toEqual(["base", "wal-only"]);
					expect(await readFile(f.canonicalPath)).toEqual(base);
					expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
					return undefined;
				},
			});
			expect(observed).toBe(true);
			expect(result.status).toBe("blocked");
			expect(await readFile(f.canonicalPath)).toEqual(base);
			expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});

	test("activation deadline bounds a hanging resolver and fences its late continuation", async () => {
		const f = await fixture();
		let finish!: () => void;
		let reached!: () => void;
		const entered = new Promise<void>(resolve => {
			reached = resolve;
		});
		const waiting = new Promise<void>(resolve => {
			finish = resolve;
		});
		let check: (() => Promise<void>) | undefined;
		try {
			const activation = f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				timeoutMs: 2_000,
				resolveBindings: async (_graph, context) => {
					check = () => context.assertCurrent();
					reached();
					await waiting;
					await context.assertCurrent();
					return [];
				},
			});
			const rejected = expect(activation).rejects.toMatchObject({ code: "timeout" });
			await Promise.race([entered, activation]);
			await rejected;
			if (check === undefined) throw new Error("Resolver was not entered.");
			await expect(check()).rejects.toThrow();
			finish();
			await Promise.resolve();
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			await expect(stat(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
			const lock = AuthorityMutationLock.acquire(f.canonicalPath);
			lock.release();
		} finally {
			finish?.();
			await f.cleanup();
		}
	});

	test("private pending recovery preserves completed event history and source identity", async () => {
		const f = await fixture();
		try {
			const at = "2026-01-01T00:00:00.000Z";
			const events = [{ type: "message", text: "immutable history", payload: { retained: true } }];
			const mapping = {
				chatId: "chat",
				projectId: "project",
				sessionId: "session",
				rawFrameCursor: 4,
				eventCursor: 2,
				operationId: "complete",
			};
			const original = Buffer.from(
				JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: 2,
					mappings: [
						{
							...mapping,
							version: 2,
							createdAt: at,
							header: { chatId: "chat", projectId: "project", sessionId: "session" },
							journal: [
								{
									id: "complete",
									kind: "prompt",
									state: "complete",
									startedAt: at,
									completedAt: at,
									result: { kind: "turn", assistantText: "immutable history", mapping, events },
								},
								{ id: "pending", kind: "prompt", state: "pending", startedAt: at },
							],
						},
					],
					provisionalOperations: [],
				}),
			);
			await writeFile(f.canonicalPath, original);
			const identity = await stat(f.canonicalPath);
			await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: graph => {
					expect(graph.mappings[0]?.journal[0]?.result?.events).toEqual(events);
					expect(graph.mappings[0]?.journal[1]?.state).toBe("uncertain");
					return undefined;
				},
			});
			expect(await readFile(f.canonicalPath)).toEqual(original);
			expect((await stat(f.canonicalPath)).ino).toBe(identity.ino);
			const root = join(
				f.root,
				"private",
				`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
			);
			const working = JSON.parse(await readFile(join(root, "replay.v2.json"), "utf8"));
			expect(working.mappings[0].journal[0].result.events).toEqual(events);
			const derived = JSON.parse(await readFile(join(root, "replay-evidence.json"), "utf8"));
			expect(derived.baseGeneration).toBe(working.generation);
			expect(derived.baseDigest).toBe(digest(await readFile(join(root, "replay.v2.json"))));
			expect(derived.walDigest).toBeNull();
		} finally {
			await f.cleanup();
		}
	});

	test.each(["working", "replay"] as const)("recreates only private copies after %s interruption", async phase => {
		const f = await fixture();
		try {
			const source = new FileSessionAuthority(f.canonicalPath);
			for (const id of ["base", "wal-only"])
				source.set({
					chatId: id,
					projectId: "project",
					sessionId: id,
					operationId: id,
					rawFrameCursor: 0,
					eventCursor: 0,
				});
			const base = await readFile(f.canonicalPath),
				wal = await readFile(`${f.canonicalPath}.wal`);
			const identity = await stat(f.canonicalPath),
				walIdentity = await stat(`${f.canonicalPath}.wal`);
			await expect(
				f.activate(boundary => {
					if (boundary === phase) throw new Error("crash");
				}),
			).rejects.toThrow("crash");
			const root = join(
				f.root,
				"private",
				`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
			);
			const manifest = await readFile(join(root, "source-manifest.json"));
			await writeFile(join(root, "replay.v2.json"), "interrupted private write");
			await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: graph => {
					expect(graph.mappings.map(mapping => mapping.chatId)).toEqual(["base", "wal-only"]);
					return undefined;
				},
			});
			expect(await readFile(f.canonicalPath)).toEqual(base);
			expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
			expect((await stat(f.canonicalPath)).ino).toBe(identity.ino);
			expect((await stat(`${f.canonicalPath}.wal`)).ino).toBe(walIdentity.ino);
			expect(await readFile(join(root, "source-manifest.json"))).toEqual(manifest);
		} finally {
			await f.cleanup();
		}
	});

	test("copied WAL corruption remains fatal instead of being discarded as stale", async () => {
		const f = await fixture();
		try {
			const source = new FileSessionAuthority(f.canonicalPath);
			for (const id of ["base", "wal-only"])
				source.set({
					chatId: id,
					projectId: "project",
					sessionId: id,
					operationId: id,
					rawFrameCursor: 0,
					eventCursor: 0,
				});
			const walPath = `${f.canonicalPath}.wal`;
			const lines = (await readFile(walPath, "utf8")).trimEnd().split("\n");
			const delta = JSON.parse(lines[1]!);
			delta.head = "0".repeat(64);
			lines[1] = JSON.stringify(delta);
			const corrupt = `${lines.join("\n")}\n`;
			await writeFile(walPath, corrupt);
			const base = await readFile(f.canonicalPath);
			await expect(f.activate()).rejects.toThrow("WAL chain is broken");
			expect(await readFile(walPath, "utf8")).toBe(corrupt);
			expect(await readFile(f.canonicalPath)).toEqual(base);
		} finally {
			await f.cleanup();
		}
	});

	test.each(["digest", "alias"] as const)("snapshot replay rejects %s before mutable recovery", async failure => {
		const f = await fixture();
		const working = join(f.root, "working.json");
		try {
			if (failure === "alias") linkSync(f.canonicalPath, working);
			else await writeFile(working, f.original);
			const before = await stat(f.canonicalPath);
			expect(
				() =>
					new FileSessionAuthority(working, undefined, {
						sourcePath: f.canonicalPath,
						baseDigest: failure === "digest" ? "0".repeat(64) : digest(f.original),
						baseMtimeMs: before.mtimeMs,
						walDigest: null,
					}),
			).toThrow(failure === "alias" ? "alias original source" : "immutable snapshot");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			expect(await readFile(working)).toEqual(f.original);
			expect((await stat(f.canonicalPath)).ino).toBe(before.ino);
		} finally {
			await f.cleanup();
		}
	});

	test("snapshots V2 and WAL absence, atomically activates deterministic V3, and binds its marker", async () => {
		const f = await fixture();
		try {
			const result = await f.activate();
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const marker = JSON.parse(await readFile(result.markerPath, "utf8")) as Record<string, unknown>;
			expect(marker).toMatchObject({ activationV3Digest: result.activationV3Digest, authorityEpoch: "managed/1" });
			expect(marker.source).toMatchObject({ baseDigest: digest(f.original), walPresent: false });
			expect(probeSessionAuthorityEpoch(f.canonicalPath)).toEqual({
				status: "v3",
				selection: "managed-store",
			});
			new V3FileBackedSessionMappingStore(f.canonicalPath).close();
		} finally {
			await f.cleanup();
		}
	});

	test("preserves original V2 before swap and completes the exact V3 swap forward on restart", async () => {
		for (const boundary of [
			"snapshot",
			"backup",
			"manifest",
			"working",
			"replay",
			"historical-stage",
			"stage",
			"committing",
			"base",
			"wal",
			"swap",
		] as const) {
			const f = await fixture();
			try {
				await expect(
					f.activate(
						current =>
							current === boundary &&
							(() => {
								throw new Error("crash");
							})(),
					),
				).rejects.toThrow("crash");
				const before = await readFile(f.canonicalPath);
				const identity = await stat(f.canonicalPath);
				const replaced = boundary === "base" || boundary === "wal" || boundary === "swap";
				if (!replaced) expect(before).toEqual(f.original);
				const boundaries: string[] = [];
				const activated = await f.activate(current => {
					boundaries.push(current);
				});
				expect(activated.status).toBe("activated");
				if (replaced) {
					expect(boundaries).toEqual([]);
					expect(await readFile(f.canonicalPath)).toEqual(before);
					expect((await stat(f.canonicalPath)).ino).toBe(identity.ino);
				}
				if (boundary === "committing") expect(boundaries).toEqual([]);
			} finally {
				await f.cleanup();
			}
		}
	});

	test.each(["source", "stage", "wal", "marker"] as const)(
		"preserves %s substitution at commit before rename",
		async target => {
			const f = await fixture();
			const stageRoot = join(
				f.root,
				"private",
				`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
			);
			const path =
				target === "source"
					? f.canonicalPath
					: target === "stage"
						? join(stageRoot, "canonical.v3.json")
						: target === "wal"
							? `${f.canonicalPath}.wal`
							: `${f.canonicalPath}.v3-active.json`;
			let substituted: Buffer | undefined;
			try {
				await expect(
					f.activate(boundary => {
						if (boundary !== "committing") return;
						substituted =
							target === "source" || target === "stage" ? readFileSync(path) : Buffer.from("external evidence");
						writeFileSync(`${path}.replacement`, substituted);
						renameSync(`${path}.replacement`, path);
					}),
				).rejects.toThrow();
				expect(substituted).toBeDefined();
				if (substituted === undefined) throw new Error("Commit substitution boundary was not reached.");
				expect((await readFile(path)).equals(substituted)).toBe(true);
				expect(await readFile(f.canonicalPath)).toEqual(f.original);
				await expect(f.activate()).rejects.toThrow();
				expect((await readFile(path)).equals(substituted)).toBe(true);
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["base", "wal", "swap"] as const)("preserves newly introduced WAL after %s", async phase => {
		const f = await fixture();
		const wal = Buffer.from("externally-owned-WAL");
		try {
			await expect(
				f.activate(boundary => {
					if (boundary === phase) writeFileSync(`${f.canonicalPath}.wal`, wal);
				}),
			).rejects.toThrow(/WAL/);
			expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
			expect(JSON.parse(await readFile(f.canonicalPath, "utf8")).version).toBe(3);
			await expect(readFile(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
			await expect(f.activate()).rejects.toThrow(/WAL/);
			expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});

	test("retains malformed external marker after an interrupted swap", async () => {
		const f = await fixture();
		const markerPath = `${f.canonicalPath}.v3-active.json`;
		try {
			await expect(
				f.activate(boundary => {
					if (boundary === "swap") throw new Error("crash");
				}),
			).rejects.toThrow("crash");
			await writeFile(markerPath, "external marker");
			await expect(f.activate()).rejects.toThrow("Active V3 marker is invalid");
			expect(await readFile(markerPath, "utf8")).toBe("external marker");
		} finally {
			await f.cleanup();
		}
	});

	test.each(["base", "wal"] as const)("recovers a present source WAL after the %s boundary", async phase => {
		const f = await fixture();
		try {
			await writeFile(`${f.canonicalPath}.wal`, Buffer.alloc(0));
			await expect(
				f.activate(boundary => {
					if (boundary === phase) throw new Error("crash");
				}),
			).rejects.toThrow("crash");
			const base = await readFile(f.canonicalPath);
			const ino = (await stat(f.canonicalPath)).ino;
			if (phase === "base") expect((await readFile(`${f.canonicalPath}.wal`)).length).toBe(0);
			else await expect(stat(`${f.canonicalPath}.wal`)).rejects.toThrow();
			expect((await f.activate()).status).toBe("activated");
			expect(await readFile(f.canonicalPath)).toEqual(base);
			expect((await stat(f.canonicalPath)).ino).toBe(ino);
			await expect(stat(`${f.canonicalPath}.wal`)).rejects.toThrow();
		} finally {
			await f.cleanup();
		}
	});

	test.each(["stage", "swap"] as const)(
		"preserves an external same-bytes inode replacement after %s",
		async boundary => {
			const f = await fixture();
			try {
				await expect(
					f.activate(current => {
						if (current === boundary) throw new Error("crash");
					}),
				).rejects.toThrow("crash");
				const bytes = await readFile(f.canonicalPath);
				await writeFile(`${f.canonicalPath}.replacement`, bytes);
				await rename(`${f.canonicalPath}.replacement`, f.canonicalPath);
				const external = await stat(f.canonicalPath);
				await expect(f.activate()).rejects.toThrow(
					boundary === "stage" ? "source changed" : "automatic V2 restoration is forbidden",
				);
				expect(await readFile(f.canonicalPath)).toEqual(bytes);
				expect((await stat(f.canonicalPath)).ino).toBe(external.ino);
				await expect(readFile(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
			} finally {
				await f.cleanup();
			}
		},
	);

	test("never deletes an externally introduced WAL while recovering a completed swap", async () => {
		const f = await fixture();
		try {
			await expect(
				f.activate(current => {
					if (current === "swap") throw new Error("crash");
				}),
			).rejects.toThrow("crash");
			const bytes = await readFile(f.canonicalPath);
			const wal = Buffer.from("externally-owned-new-wal");
			await writeFile(`${f.canonicalPath}.wal`, wal);
			await expect(f.activate()).rejects.toThrow("WAL identity changed");
			expect(await readFile(f.canonicalPath)).toEqual(bytes);
			expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});

	test("malformed committing journal blocks recovery without replacing canonical or snapshots", async () => {
		const f = await fixture();
		try {
			await expect(
				f.activate(current => {
					if (current === "swap") throw new Error("crash");
				}),
			).rejects.toThrow("crash");
			const root = join(
				f.root,
				"private",
				`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
			);
			const canonical = await readFile(f.canonicalPath);
			const snapshot = await readFile(join(root, "source.v2.json"));
			await writeFile(join(root, "activation.json"), "{broken");
			await expect(f.activate()).rejects.toThrow();
			expect(await readFile(f.canonicalPath)).toEqual(canonical);
			expect(await readFile(join(root, "source.v2.json"))).toEqual(snapshot);
		} finally {
			await f.cleanup();
		}
	});

	test("detects equal-byte V2 inode substitution during binding resolution", async () => {
		const f = await fixture();
		try {
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: async () => {
					await writeFile(`${f.canonicalPath}.replacement`, f.original);
					await rename(`${f.canonicalPath}.replacement`, f.canonicalPath);
					return [];
				},
			});
			expect(result.status).toBe("blocked");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
		} finally {
			await f.cleanup();
		}
	});

	test.each([false, true])(
		"fsyncs immutable manifest before private replay and preserves it across restart (WAL %s)",
		async walPresent => {
			const f = await fixture();
			try {
				if (walPresent) await writeFile(`${f.canonicalPath}.wal`, Buffer.alloc(0));
				const root = join(
					f.root,
					"private",
					`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
				);
				await expect(
					f.activate(boundary => {
						if (boundary === "manifest") throw new Error("manifest crash");
					}),
				).rejects.toThrow("manifest crash");
				await expect(readFile(join(root, "replay.v2.json"))).rejects.toThrow();
				await expect(readFile(join(root, "activation.json"))).rejects.toThrow();
				const manifestBytes = await readFile(join(root, "source-manifest.json"));
				const manifest = JSON.parse(manifestBytes.toString("utf8"));
				expect(manifest.canonicalReplaced).toBe(false);
				expect(manifest.canonicalPath).toBe(f.canonicalPath);
				expect(manifest.originalBaseGeneration).toBeNull();
				expect(manifest.source.baseDigest).toBe(digest(f.original));
				expect(manifest.source.base.ino).toBe(String((await stat(f.canonicalPath)).ino));
				expect(manifest.source.wal === null).toBe(!walPresent);
				const baseIdentity = await stat(join(root, "source.v2.json"));
				const manifestIdentity = await stat(join(root, "source-manifest.json"));
				expect(manifestIdentity.mode & 0o777).toBe(0o600);
				const boundaries: string[] = [];
				expect(
					(
						await f.activate(boundary => {
							boundaries.push(boundary);
						})
					).status,
				).toBe("activated");
				expect(boundaries).toEqual([
					"working",
					"replay",
					"historical-stage",
					"stage",
					"committing",
					"base",
					"wal",
					"swap",
					"marker",
				]);
				expect(await readFile(join(root, "source-manifest.json"))).toEqual(manifestBytes);
				expect((await stat(join(root, "source-manifest.json"))).ino).toBe(manifestIdentity.ino);
				expect((await stat(join(root, "source.v2.json"))).ino).toBe(baseIdentity.ino);
				expect(JSON.parse(await readFile(join(root, "activation.json"), "utf8")).manifestDigest).toBe(
					digest(manifestBytes),
				);
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["manifest", "swap"] as const)(
		"snapshot inode substitution after %s cannot be reused or overwritten",
		async phase => {
			const f = await fixture();
			try {
				await expect(
					f.activate(boundary => {
						if (boundary === phase) throw new Error("crash");
					}),
				).rejects.toThrow("crash");
				const root = join(
					f.root,
					"private",
					`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
				);
				const basePath = join(root, "source.v2.json");
				await writeFile(`${basePath}.replacement`, f.original);
				await rename(`${basePath}.replacement`, basePath);
				await expect(f.activate()).rejects.toThrow(
					phase === "manifest" ? "snapshot identity changed" : "snapshot identity or content changed",
				);
				if (phase === "manifest") {
					expect(await readFile(f.canonicalPath)).toEqual(f.original);
					await expect(readFile(join(root, "replay.v2.json"))).rejects.toThrow();
				} else expect(JSON.parse(await readFile(f.canonicalPath, "utf8")).version).toBe(3);
			} finally {
				await f.cleanup();
			}
		},
	);

	test("keeps the activation marker valid after an ordinary V3 mapping write and restart", async () => {
		const f = await fixture();
		try {
			const activated = await f.activate();
			if (activated.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const store = new V3FileBackedSessionMappingStore(f.canonicalPath);
			store.set({
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "operation-1",
				managedAuthority: {
					principalId: "principal-1",
					projectId: "project-1",
					canonicalWorkspace: "/workspace/project-1",
					chatId: "chat-1",
					sessionId: "session-1",
					generation: 1,
					leaseId: "lease-1",
					epoch: "managed/1",
					requestKey: "request-1",
				},
			});
			store.close();
			expect(probeSessionAuthorityEpoch(f.canonicalPath)).toEqual({ status: "v3", selection: "managed-store" });
			const marker = JSON.parse(await readFile(activated.markerPath, "utf8")) as Record<string, unknown>;
			expect(marker.activationV3Digest).toBe(activated.activationV3Digest);
			const restarted = new V3FileBackedSessionMappingStore(f.canonicalPath);
			expect(restarted.get("chat-1")).toMatchObject({ sessionId: "session-1" });
			restarted.close();
		} finally {
			await f.cleanup();
		}
	});

	test("retains a present WAL in immutable backup and is forward-only after the durable marker", async () => {
		const f = await fixture();
		try {
			const wal = Buffer.alloc(0);
			await writeFile(`${f.canonicalPath}.wal`, wal);
			await expect(
				f.activate(
					boundary =>
						boundary === "marker" &&
						(() => {
							throw new Error("crash");
						})(),
				),
			).rejects.toThrow("crash");
			const restarted = await f.activate();
			expect(restarted.status).toBe("activated");
			const backup = await readFile(
				join(
					f.root,
					"private",
					`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
					"source.v2.wal",
				),
			);
			expect(backup).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});
});
