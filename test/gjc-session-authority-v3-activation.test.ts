import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { linkSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createManagedLifecycleEvidence,
	type ManagedLifecycleEvidence,
	managedLifecycleEvidenceHash,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import { probeSessionAuthorityEpoch } from "../src/gjc/session-authority-epoch";
import { AuthorityMutationLock } from "../src/gjc/session-authority-file";
import { FileSessionAuthority } from "../src/gjc/session-authority-persistence";
import { parseSessionAuthorityV3Document } from "../src/gjc/session-authority-v3";
import {
	activateSessionAuthorityV3,
	type SessionAuthorityV3ActivationBoundary,
	type SessionAuthorityV3ActivationOptions,
	type SessionAuthorityV3BootstrapAccess,
	type SessionAuthorityV3BootstrapContext,
} from "../src/gjc/session-authority-v3-activation";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function historicalFixture() {
	const f = await fixture();
	const chatId = JSON.stringify(["owner", "chat"]);
	const original = Buffer.from(
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: 2,
			mappings: [
				{
					version: 2,
					chatId,
					projectId: "project",
					sessionId: "session",
					createdAt: "2026-01-01T00:00:00.000Z",
					header: { chatId, projectId: "project", sessionId: "session" },
					rawFrameCursor: 1,
					eventCursor: 2,
					operationId: "historical-turn",
					assistantText: "immutable old answer",
					events: [{ type: "message", id: "old", payload: { text: "original" } }],
					journal: [],
				},
			],
			provisionalOperations: [],
		})}\n`,
	);
	await writeFile(f.canonicalPath, original);
	return { ...f, original, chatId };
}

function bootstrapEvidence(context: SessionAuthorityV3BootstrapContext): ManagedLifecycleEvidence {
	const record = parseSessionAuthorityV3Document(readFileSync(context.stagedPath))!.mappings[0]!;
	return createManagedLifecycleEvidence({
		operation: "session.resume",
		payloadHash: "a".repeat(64),
		preparedAuthority: {
			principalId: "owner",
			projectId: "project",
			canonicalWorkspace: "/workspace",
			chatId: "chat",
			leaseId: "lease",
			epoch: "epoch",
			requestKey: "stable-manifest-key",
		},
		historicalSource: {
			kind: "bootstrap-history",
			manifestDigest: context.manifestDigest,
			historicalBinding: record.historicalBinding!,
			savedSession: {
				id: "session",
				path: "/workspace/session.jsonl",
				identity: {
					dev: "1",
					ino: "2",
					size: 123,
					mtimeMs: 1,
					mtimeNs: "1000000",
					sha256: "b".repeat(64),
					nlink: "1",
					ctimeNs: "1000000",
				},
			},
		},
		target: {
			sessionId: "session",
			cwd: "/workspace",
			sessionPath: "/workspace/session.jsonl",
			sessionIdentity: {
				dev: "1",
				ino: "2",
				size: 123,
				mtimeMs: 1,
				mtimeNs: "1000000",
				sha256: "b".repeat(64),
			},
		},
	});
}

async function advanceBootstrap(context: SessionAuthorityV3BootstrapContext, intent: ManagedLifecycleEvidence) {
	const id = "migration:resume:session";
	let previous = intent;
	for (const next of [transitionManagedLifecycleEvidence(intent, "invoking")]) {
		await context.stage.advance(id, managedLifecycleEvidenceHash(previous), next);
		previous = next;
	}
	const acknowledged = { ...intent.preparedAuthority, sessionId: "session", generation: 7 };
	const ack = transitionManagedLifecycleEvidence(previous, "acknowledged_unproven", { acknowledged });
	await context.stage.advance(id, managedLifecycleEvidenceHash(previous), ack);
	const active = transitionManagedLifecycleEvidence(ack, "active_generation_proven", {
		proven: {
			kind: "managed-generation",
			sessionId: "session",
			generation: 7,
			leaseId: "lease",
			epoch: "epoch",
		},
	});
	await context.stage.advance(id, managedLifecycleEvidenceHash(ack), active);
	return active;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gjc-v3-activation-"));
	const canonicalPath = join(root, "authority.json");
	const original = Buffer.from('{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n');
	await writeFile(canonicalPath, original);
	const runtimeLock = await RuntimeSingletonLock.acquire(root);
	const invoke = async (options: Omit<SessionAuthorityV3ActivationOptions, "runtimeLock" | "mutationLock">) => {
		const mutationLock = AuthorityMutationLock.acquire(canonicalPath);
		try {
			return await activateSessionAuthorityV3({
				beforeBootstrapCommit: async () => () => {},
				bootstrapTenantFence: evidence =>
					evidence.preparedAuthority.principalId === "owner" &&
					evidence.preparedAuthority.projectId === "project" &&
					evidence.preparedAuthority.canonicalWorkspace === "/workspace" &&
					evidence.preparedAuthority.chatId === "chat" &&
					evidence.preparedAuthority.leaseId === "lease" &&
					evidence.preparedAuthority.epoch === "epoch",
				...options,
				runtimeLock,
				mutationLock,
			});
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
	test.each(["symlink", "directory"] as const)(
		"rejects a %s canonical source without snapshot effects",
		async kind => {
			const f = await fixture();
			const retained = `${f.canonicalPath}.retained`;
			try {
				await rename(f.canonicalPath, retained);
				if (kind === "symlink") await symlink(retained, f.canonicalPath);
				else await mkdir(f.canonicalPath);
				await expect(f.activate()).rejects.toThrow();
				expect((await readFile(retained)).equals(f.original)).toBe(true);
				expect(await Bun.file(`${f.canonicalPath}.v3-active.json`).exists()).toBe(false);
				const snapshot = join(
					f.root,
					"private",
					`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
					"source.v2.json",
				);
				expect(await Bun.file(snapshot).exists()).toBe(false);
			} finally {
				await f.cleanup();
			}
		},
	);

	test("release rejects an externally replaced mutation lock and preserves its bytes", async () => {
		const f = await fixture();
		const lock = AuthorityMutationLock.acquire(f.canonicalPath);
		const lockPath = `${f.canonicalPath}.lock`;
		try {
			lock.assertHeld(f.canonicalPath);
			const bytes = await readFile(lockPath);
			await rename(lockPath, `${lockPath}.retained`);
			await writeFile(lockPath, bytes);
			const replacement = await stat(lockPath);
			expect(() => lock.assertHeld(f.canonicalPath)).toThrow("ownership was lost");
			expect(() => lock.release()).toThrow("ownership changed before release");
			expect((await readFile(lockPath)).equals(bytes)).toBe(true);
			expect((await stat(lockPath)).ino).toBe(replacement.ino);
		} finally {
			await f.cleanup();
		}
	});

	test.each(["manifest", "base", "marker"] as const)(
		"activation and forward recovery leave unrelated user files untouched at %s",
		async boundary => {
			const f = await fixture();
			const unrelated: Array<{ path: string; bytes: Buffer; ino: number }> = [];
			try {
				for (const [directory, name, content] of [
					["transcripts", "session.jsonl", '{"text":"private transcript"}\n'],
					["artifacts", "user-output.txt", "user artifact\n"],
				]) {
					await mkdir(join(f.root, directory!));
					const path = join(f.root, directory!, name!);
					const bytes = Buffer.from(content!);
					await writeFile(path, bytes);
					unrelated.push({ path, bytes, ino: (await stat(path)).ino });
				}
				await expect(
					f.activate(current => {
						if (current === boundary) throw new Error("interrupted activation");
					}),
				).rejects.toThrow("interrupted activation");
				const afterCrash = await readFile(f.canonicalPath);
				const afterCrashInode = (await stat(f.canonicalPath)).ino;
				if (boundary === "manifest") expect(afterCrash.equals(f.original)).toBe(true);
				else expect(parseSessionAuthorityV3Document(afterCrash)).toBeDefined();
				expect((await f.activate()).status).toBe("activated");
				if (boundary !== "manifest") {
					expect((await readFile(f.canonicalPath)).equals(afterCrash)).toBe(true);
					expect((await stat(f.canonicalPath)).ino).toBe(afterCrashInode);
				}
				for (const file of unrelated) {
					expect((await readFile(file.path)).equals(file.bytes)).toBe(true);
					expect((await stat(file.path)).ino).toBe(file.ino);
				}
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["committing", "base"] as const)(
		"bootstrap crash at %s never trusts pre-swap historical proof",
		async boundary => {
			const f = await historicalFixture();
			let effects = 0;
			const bootstrap = async (context: SessionAuthorityV3BootstrapContext) => {
				const intent = bootstrapEvidence(context);
				await context.stage.begin("migration:resume:session", intent);
				effects += 1;
				const active = await advanceBootstrap(context, intent);
				await context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
			};
			try {
				await expect(
					f.invoke({
						canonicalPath: f.canonicalPath,
						stagingRoot: join(f.root, "private"),
						bootstrap,
						afterBoundary: value => {
							if (value === boundary) throw new Error("commit interrupted");
						},
					}),
				).rejects.toThrow("commit interrupted");
				const retry = await f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					bootstrap,
				});
				expect(retry.status).toBe(boundary === "base" ? "activated" : "blocked");
				expect(effects).toBe(1);
				if (boundary === "committing") {
					expect(await readFile(f.canonicalPath)).toEqual(f.original);
					await expect(stat(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
				}
			} finally {
				await f.cleanup();
			}
		},
	);

	test("final bootstrap token check follows the last awaited lock check", async () => {
		const f = await historicalFixture();
		let valid = true;
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					beforeBootstrapCommit: async () => () => {
						if (!valid) throw new Error("final token stale");
					},
					afterBoundary: boundary => {
						if (boundary === "committing") valid = false;
					},
					bootstrap: async context => {
						const intent = bootstrapEvidence(context);
						await context.stage.begin("migration:resume:session", intent);
						const active = await advanceBootstrap(context, intent);
						await context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
					},
				}),
			).rejects.toThrow("final token stale");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
		} finally {
			await f.cleanup();
		}
	});

	test("missing commit verifier is rejected before bootstrap effects", async () => {
		const f = await fixture();
		let invoked = false;
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					beforeBootstrapCommit: undefined,
					bootstrap: async () => {
						invoked = true;
					},
				}),
			).rejects.toThrow("commit revalidation");
			expect(invoked).toBe(false);
		} finally {
			await f.cleanup();
		}
	});

	test("commits the same staged migration journal and revokes its mutable capability", async () => {
		const f = await historicalFixture();
		let context!: SessionAuthorityV3BootstrapContext;
		let active!: ManagedLifecycleEvidence;
		try {
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				bootstrap: async current => {
					context = current;
					const intent = bootstrapEvidence(current);
					await current.stage.begin("migration:resume:session", intent);
					await expect(
						current.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(intent), intent),
					).rejects.toThrow("persisted exact generation proof");
					active = await advanceBootstrap(current, intent);
					await expect(current.stage.advance("migration:resume:session", "0".repeat(64), active)).rejects.toThrow(
						"evidence changed",
					);
					await current.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
					await current.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
					expect(await readFile(f.canonicalPath)).toEqual(f.original);
				},
			});
			expect(result.status).toBe("activated");
			const document = parseSessionAuthorityV3Document(await readFile(f.canonicalPath))!;
			expect(document.mappings[0]!.operationId).toBe("historical-turn");
			expect(document.mappings[0]!.assistantText).toBe("immutable old answer");
			expect(document.mappings[0]!.managedAuthority?.generation).toBe(7);
			expect(document.mappings[0]!.journal[0]!.state).toBe("complete");
			expect(document.mappings[0]!.journal[0]!.lifecycle).toEqual(active);
			await expect(
				context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active),
			).rejects.toThrow("ownership is unavailable");
			const store = new V3FileBackedSessionMappingStore(f.canonicalPath);
			expect(() => store.bootstrapStage({} as SessionAuthorityV3BootstrapAccess)).toThrow(
				"ownership is unavailable",
			);
			expect(store.getScoped({ principalId: "owner", chatId: "chat" })?.sessionId).toBe("session");
			store.close();
		} finally {
			await f.cleanup();
		}
	});

	test("restart retains prepared bootstrap identity and blocks fresh-key replacement", async () => {
		const f = await historicalFixture();
		let intent!: ManagedLifecycleEvidence;
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					bootstrap: async context => {
						intent = bootstrapEvidence(context);
						await context.stage.begin("migration:resume:session", intent);
						throw new Error("crash after intent");
					},
				}),
			).rejects.toThrow("crash after intent");
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				bootstrap: async context => {
					const operation = await context.stage.begin("migration:resume:session", intent);
					expect(operation.state).toBe("uncertain");
					await expect(context.stage.begin("migration:resume:different", intent)).rejects.toThrow("new key");
					const active = await advanceBootstrap(context, intent);
					await context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
				},
			});
			expect(result.status).toBe("activated");
		} finally {
			await f.cleanup();
		}
	});

	test("restart cannot convert an unacknowledged invocation into same-key success", async () => {
		const f = await historicalFixture();
		let intent!: ManagedLifecycleEvidence;
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					bootstrap: async context => {
						intent = bootstrapEvidence(context);
						await context.stage.begin("migration:resume:session", intent);
						await context.stage.advance(
							"migration:resume:session",
							managedLifecycleEvidenceHash(intent),
							transitionManagedLifecycleEvidence(intent, "invoking"),
						);
						throw new Error("lost acknowledgement");
					},
				}),
			).rejects.toThrow("lost acknowledgement");
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				bootstrap: async context => {
					const current = parseSessionAuthorityV3Document(await readFile(context.stagedPath))!.mappings[0]!
						.journal[0]!.lifecycle!;
					expect(current.state).toBe("uncertain");
					const guessed = transitionManagedLifecycleEvidence(current, "acknowledged_unproven", {
						acknowledged: {
							...intent.preparedAuthority,
							sessionId: "session",
							generation: 7,
						},
					});
					await expect(
						context.stage.advance("migration:resume:session", managedLifecycleEvidenceHash(current), guessed),
					).rejects.toThrow("original-incarnation");
				},
			});
			expect(result.status).toBe("blocked");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
		} finally {
			await f.cleanup();
		}
	});

	test("retained promoted stage completes only local activation after a callback crash", async () => {
		const f = await historicalFixture();
		let active!: ManagedLifecycleEvidence;
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					bootstrap: async context => {
						const intent = bootstrapEvidence(context);
						await context.stage.begin("migration:resume:session", intent);
						active = await advanceBootstrap(context, intent);
						await context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
						throw new Error("after promotion");
					},
				}),
			).rejects.toThrow("after promotion");
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				bootstrap: async context => {
					await context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
				},
			});
			expect(result.status).toBe("activated");
			expect(parseSessionAuthorityV3Document(await readFile(f.canonicalPath))!.mappings[0]!.journal).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});

	test("bootstrap callback cannot discard historical text while publishing proof", async () => {
		const f = await historicalFixture();
		try {
			await expect(
				f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					bootstrap: async context => {
						const intent = bootstrapEvidence(context);
						await context.stage.begin("migration:resume:session", intent);
						const active = await advanceBootstrap(context, intent);
						await context.stage.promote("migration:resume:session", managedLifecycleEvidenceHash(active), active);
						const value = JSON.parse(await readFile(context.stagedPath, "utf8"));
						value.mappings[0].assistantText = "rewritten";
						await writeFile(context.stagedPath, JSON.stringify(value));
					},
				}),
			).rejects.toThrow("immutable source history");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
		} finally {
			await f.cleanup();
		}
	});

	test("a timed-out bootstrap lease check cannot write when its grant arrives late", async () => {
		const f = await historicalFixture();
		let release!: (valid: boolean) => void;
		const pending = new Promise<boolean>(resolve => {
			release = resolve;
		});
		let entered!: () => void;
		const reached = new Promise<void>(resolve => {
			entered = resolve;
		});
		let path = "";
		try {
			const activation = f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				timeoutMs: 2_000,
				bootstrapTenantFence: () => {
					entered();
					return pending;
				},
				bootstrap: async context => {
					path = context.stagedPath;
					await context.stage.begin("migration:resume:session", bootstrapEvidence(context));
				},
			});
			const rejected = expect(activation).rejects.toMatchObject({ code: "timeout" });
			await Promise.race([reached, activation]);
			await rejected;
			const before = await readFile(path);
			release(true);
			await Promise.resolve();
			await Promise.resolve();
			expect(await readFile(path)).toEqual(before);
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
		} finally {
			release?.(false);
			await f.cleanup();
		}
	});

	test.each(["lease", "manifest", "occurrence"] as const)(
		"denies bootstrap writes with foreign %s proof",
		async mismatch => {
			const f = await historicalFixture();
			try {
				const result = await f.invoke({
					canonicalPath: f.canonicalPath,
					stagingRoot: join(f.root, "private"),
					bootstrap: async context => {
						const intent = bootstrapEvidence(context);
						const changed = {
							...intent,
							...(mismatch === "lease"
								? { preparedAuthority: { ...intent.preparedAuthority, leaseId: "foreign" } }
								: {
										historicalSource: {
											...intent.historicalSource!,
											...(mismatch === "manifest"
												? { manifestDigest: "f".repeat(64) }
												: {
														historicalBinding: {
															...intent.historicalSource!.historicalBinding,
															provenance: {
																...intent.historicalSource!.historicalBinding.provenance,
																nodeRef: "/mappings/99",
															},
														},
													}),
										},
									}),
						};
						const before = await readFile(context.stagedPath);
						await expect(context.stage.begin("migration:resume:session", changed)).rejects.toThrow();
						expect(await readFile(context.stagedPath)).toEqual(before);
					},
				});
				expect(result.status).toBe("blocked");
			} finally {
				await f.cleanup();
			}
		},
	);

	test("a revoked tenant fence retains invocation acknowledgement but cannot publish proof", async () => {
		const f = await historicalFixture();
		let live = true;
		try {
			const result = await f.invoke({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				bootstrapTenantFence: () => live,
				bootstrap: async context => {
					const intent = bootstrapEvidence(context);
					await context.stage.begin("migration:resume:session", intent);
					const invoking = transitionManagedLifecycleEvidence(intent, "invoking");
					await context.stage.advance("migration:resume:session", managedLifecycleEvidenceHash(intent), invoking);
					live = false;
					const ack = transitionManagedLifecycleEvidence(invoking, "acknowledged_unproven", {
						acknowledged: {
							...intent.preparedAuthority,
							sessionId: "session",
							generation: 7,
						},
					});
					await context.stage.advance("migration:resume:session", managedLifecycleEvidenceHash(invoking), ack);
					const persisted = parseSessionAuthorityV3Document(await readFile(context.stagedPath))!.mappings[0]!
						.journal[0]!.lifecycle!;
					expect(persisted).toEqual(ack);
					const proof = transitionManagedLifecycleEvidence(ack, "active_generation_proven", {
						proven: {
							kind: "managed-generation",
							sessionId: "session",
							generation: 7,
							leaseId: "lease",
							epoch: "epoch",
						},
					});
					await expect(
						context.stage.advance("migration:resume:session", managedLifecycleEvidenceHash(ack), proof),
					).rejects.toThrow("tenant fence was lost");
				},
			});
			expect(result.status).toBe("blocked");
		} finally {
			await f.cleanup();
		}
	});

	test.each([false, true])("never regenerates a modified normal V3 stage after resolver failure=%s", async crash => {
		const f = await fixture();
		let stagePath = "";
		let calls = 0;
		try {
			const options = {
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: (_graph: unknown, context: { stagedPath: string }) => {
					calls += 1;
					stagePath = context.stagedPath;
					const staged = new V3FileBackedSessionMappingStore(stagePath);
					staged.reserveProvisionalOperationScoped(
						{ principalId: "owner", chatId: "chat" },
						{
							id: "migration-resume",
							ingressId: "same-key",
							kind: "resume",
							chatId: "chat",
							projectId: "project",
							detail: "same-hash",
						},
					);
					staged.close();
					if (crash) throw new Error("after staged intent");
					return [];
				},
			};
			if (crash) await expect(f.invoke(options)).rejects.toThrow("after staged intent");
			else expect((await f.invoke(options)).status).toBe("blocked");
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			const before = JSON.parse(await readFile(stagePath, "utf8")).provisionalOperations[0];
			expect(before.state).toBe("pending");
			expect((await f.invoke(options)).status).toBe("blocked");
			expect(calls).toBe(1);
			const after = JSON.parse(await readFile(stagePath, "utf8")).provisionalOperations[0];
			expect(after.state).toBe("uncertain");
			expect(after.id).toBe(before.id);
			expect(after.ingressId).toBe(before.ingressId);
			expect(after.detail).toBe(before.detail);
			expect(after.startedAt).toBe(before.startedAt);
			expect(await readFile(f.canonicalPath)).toEqual(f.original);
			await expect(stat(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
		} finally {
			await f.cleanup();
		}
	});

	test.each(["missing", "corrupt", "checkpoint"] as const)(
		"does not recreate a %s retained historical stage",
		async damage => {
			const f = await fixture();
			let stagePath = "";
			try {
				await expect(
					f.invoke({
						canonicalPath: f.canonicalPath,
						stagingRoot: join(f.root, "private"),
						resolveBindings: (_graph, context) => {
							stagePath = context.stagedPath;
							throw new Error("before public effect");
						},
					}),
				).rejects.toThrow("before public effect");
				if (damage === "missing") await rm(stagePath);
				else if (damage === "corrupt") await writeFile(stagePath, "invalid V3");
				else await writeFile(join(stagePath, "..", "historical-stage.json"), "{}\n");
				await expect(f.activate()).rejects.toThrow();
				expect(await readFile(f.canonicalPath)).toEqual(f.original);
				if (damage === "missing") await expect(stat(stagePath)).rejects.toThrow();
				if (damage === "corrupt") expect(await readFile(stagePath, "utf8")).toBe("invalid V3");
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["manifest", "checkpoint", "source"] as const)(
		"resolver currentness rejects changed %s evidence",
		async changed => {
			const f = await fixture();
			try {
				await expect(
					f.invoke({
						canonicalPath: f.canonicalPath,
						stagingRoot: join(f.root, "private"),
						resolveBindings: async (_graph, context) => {
							const path =
								changed === "source"
									? f.canonicalPath
									: join(
											context.stagedPath,
											"..",
											changed === "manifest" ? "source-manifest.json" : "historical-stage.json",
										);
							await writeFile(path, "{}\n");
							await context.assertCurrent();
							throw new Error("Changed bootstrap evidence was incorrectly authorized.");
						},
					}),
				).rejects.toThrow(
					changed === "manifest"
						? "manifest changed"
						: changed === "checkpoint"
							? "checkpoint conflicts"
							: "authority changed",
				);
				await expect(stat(`${f.canonicalPath}.v3-active.json`)).rejects.toThrow();
				if (changed !== "source") expect(await readFile(f.canonicalPath)).toEqual(f.original);
				else expect(await readFile(f.canonicalPath, "utf8")).toBe("{}\n");
			} finally {
				await f.cleanup();
			}
		},
	);

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
