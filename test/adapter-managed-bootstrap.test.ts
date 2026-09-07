import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import {
	type AdapterManagedBootstrapInput,
	startAdapterSessionAuthorityV3Activation,
} from "../src/adapter-managed-bootstrap";
import { ManagedSdkRuntime, type ManagedSdkRuntimeDeps } from "../src/gjc/managed-sdk-runtime";
import type { SessionAuthorityTombstone } from "../src/gjc/session-authority-types";
import { parseSessionAuthorityV3Document, type SessionAuthorityV3Document } from "../src/gjc/session-authority-v3";
import type { SessionAuthorityV2Document } from "../src/gjc/session-authority-v3-migration";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";

function activateAdapterSessionAuthorityV3(input: AdapterManagedBootstrapInput) {
	return startAdapterSessionAuthorityV3Activation(input).result;
}

async function fixture(
	options: {
		unresolved?: boolean;
		revokeAfterResume?: boolean;
		failResume?: boolean;
		sessionId?: string;
		generation?: number;
		stale?: boolean;
		empty?: boolean;
		stopGate?: Promise<void>;
		resumeGate?: Promise<void>;
		failStart?: boolean;
		failStop?: boolean;
		onResume?: () => void;
		onStop?: () => Promise<void>;
		timeoutMs?: number;
		staleAtCommit?: boolean;
		unscoped?: boolean;
		configuredOwner?: string;
		explicitOwner?: string;
		stopAtPrepared?: boolean;
		transformSource?: (source: SessionAuthorityV2Document) => SessionAuthorityV2Document;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "adapter-bootstrap-owned-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const sourcePath = join(root, "authority.json");
	const chatId = options.unscoped ? "chat" : JSON.stringify(["owner", "chat"]);
	const stamp = "2026-01-01T00:00:00.000Z";
	const source: SessionAuthorityV2Document = {
		mappings: options.empty
			? []
			: [
					{
						version: 2,
						chatId,
						projectId: "project",
						sessionId: "session",
						createdAt: stamp,
						header: { chatId, projectId: "project", sessionId: "session" },
						rawFrameCursor: 1,
						eventCursor: 2,
						operationId: "turn",
						sessionFile: "/inert/history.jsonl",
						assistantText: "retained answer",
						...(options.explicitOwner === undefined
							? {}
							: { observations: { __gjcSessionMappingScope: { principalId: options.explicitOwner } } }),
						journal: [
							{
								id: "turn",
								kind: "prompt",
								state: "complete",
								startedAt: stamp,
								completedAt: stamp,
								result: {
									kind: "turn",
									assistantText: "retained answer",
									events: [{ id: "event", type: "message", payload: { text: "old" } }],
									mapping: {
										chatId,
										projectId: "project",
										sessionId: "session",
										operationId: "turn",
										rawFrameCursor: 1,
										eventCursor: 2,
									},
								},
							},
						],
					},
				],
		provisionalOperations: [],
	};
	const original = JSON.stringify({
		kind: "openwebui-gjc-session-authority",
		version: 2,
		...(options.transformSource?.(source) ?? source),
	});
	await writeFile(sourcePath, original);
	const stagePath = join(
		root,
		`session-authority-v3-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`,
		"historical.v3.json",
	);
	const runtimeLock = await RuntimeSingletonLock.acquire(root);
	const calls: string[] = [];
	let live = true;
	let stale = options.stale ?? false;
	let reconciles = 0;
	let preparedStopped = false;
	let runtime!: ManagedSdkRuntime;
	let deps!: ManagedSdkRuntimeDeps;
	let initialGraph: SessionAuthorityV3Document | undefined;
	const graph = () => parseSessionAuthorityV3Document(readFileSync(stagePath))!;
	const evidence = () => graph().mappings[0]?.journal.at(-1)?.lifecycle;
	const input: AdapterManagedBootstrapInput = {
		locations: { agentDir: root, stateRoot: root },
		sourcePath,
		configuredOwnerUserId: options.configuredOwner ?? "owner",
		runtimeLock,
		timeoutMs: options.timeoutMs ?? 5_000,
		authority: {
			resolve: async (principalId, projectId) =>
				options.unresolved || principalId !== "owner" || projectId !== "project"
					? undefined
					: {
							project: {
								id: "project",
								name: "project",
								cwd: workspace,
								allowedRoot: workspace,
								createdAt: new Date(0),
							},
							canonicalWorkspace: workspace,
							leaseId: "lease",
							epoch: "epoch",
							assertFence: async () => {
								if (!live) throw new Error("lease revoked");
								if (
									options.stopAtPrepared &&
									!preparedStopped &&
									initialGraph !== undefined &&
									evidence()?.state === "intent_prepared"
								) {
									preparedStopped = true;
									throw new Error("interrupted after prepared intent");
								}
								if (options.staleAtCommit && reconciles >= 2) {
									await Promise.resolve();
									stale = true;
								}
							},
							assertCurrent: () => {
								if (!live) throw new Error("lease revoked at commit");
							},
						},
		},
		createRuntime: (agentDir, owned) => {
			deps = owned;
			calls.push("construct");
			initialGraph = graph();
			expect(graph().version).toBe(3);
			expect(readFileSync(sourcePath, "utf8")).toBe(original);
			const attachment = { sessionId: "session", generation: 7, isCurrent: () => !stale };
			const sdkRouter = {
				start: async () => {
					calls.push("start");
					if (options.failStart) throw new Error("router start failed");
				},
				stop: async () => {
					calls.push("stop");
					await options.stopGate;
					if (options.failStop) throw new Error("router stop failed");
					await options.onStop?.();
				},
				reconcile: async () => {
					calls.push("reconcile");
					reconciles += 1;
					if (!options.empty) expect(evidence()?.acknowledged?.generation).toBe(7);
				},
				attachment: (id: string, generation: number) =>
					id === attachment.sessionId && generation === attachment.generation ? attachment : undefined,
				generationStatus: async () => ({ status: "current" }),
			} as unknown as router.SessionRouter;
			const service = {
				list: async (request: Parameters<lifecycle.AgentDirSessionLifecycleService["list"]>[0]) => {
					calls.push("list");
					expect(request.target).toEqual({ cwd: workspace, resolveSessionId: "session" });
					expect(readFileSync(sourcePath, "utf8")).toBe(original);
					return {
						ok: true,
						operation: "session.list",
						result: {
							savedSession: {
								id: "session",
								path: join(workspace, "saved.jsonl"),
								identity: {
									dev: "1",
									ino: "2",
									size: 3,
									mtimeMs: 4,
									mtimeNs: "4000000",
									sha256: "a".repeat(64),
									nlink: "1",
									ctimeNs: "4000000",
								},
							},
						},
					};
				},
				resume: async (request: Parameters<lifecycle.AgentDirSessionLifecycleService["resume"]>[0]) => {
					calls.push("resume");
					expect(evidence()?.state).toBe("invoking");
					expect(evidence()?.requestKey).toBe(request.requestKey);
					expect(readFileSync(sourcePath, "utf8")).toBe(original);
					if (options.revokeAfterResume) live = false;
					if (options.failResume) throw new Error("lost outcome");
					options.onResume?.();
					await options.resumeGate;
					return {
						ok: true,
						operation: "session.resume",
						result: { sessionId: options.sessionId ?? "session", endpointGeneration: options.generation ?? 7 },
					};
				},
			} as unknown as lifecycle.AgentDirSessionLifecycleService;
			runtime = new ManagedSdkRuntime({
				agentDir,
				deps: { ...owned, createRouter: () => sdkRouter, createLifecycleService: () => service },
			});
			return runtime;
		},
	};
	return {
		input,
		root,
		sourcePath,
		original,
		stagePath,
		calls,
		graph,
		initialGraph: () => initialGraph!,
		evidence,
		runtime: () => runtime,
		deps: () => deps,
		cleanup: async () => {
			try {
				await runtime?.dispose();
			} finally {
				await runtimeLock.release();
				await rm(root, { recursive: true, force: true });
			}
		},
	};
}

function withReassignment(
	source: SessionAuthorityV2Document,
	state: "committed" | "rolled_back" | "pending",
): SessionAuthorityV2Document {
	const mapping = source.mappings[0]!;
	const tombstone = (
		projectId: string,
		operationId: string,
		prior?: SessionAuthorityTombstone,
	): SessionAuthorityTombstone => ({
		version: 2,
		chatId: mapping.chatId,
		projectId,
		// Reused saved-session identity is history, not another live occurrence.
		sessionId: mapping.sessionId,
		createdAt: mapping.createdAt,
		header: { chatId: mapping.chatId, projectId, sessionId: mapping.sessionId },
		rawFrameCursor: 1,
		eventCursor: 1,
		operationId,
		sessionFile: `/inert/${operationId}.jsonl`,
		journal: [
			{
				id: operationId,
				kind: "prompt",
				state: "complete",
				startedAt: mapping.createdAt,
				completedAt: mapping.createdAt,
				result: {
					kind: "turn",
					assistantText: operationId,
					mapping: {
						chatId: mapping.chatId,
						projectId,
						sessionId: mapping.sessionId,
						operationId,
						rawFrameCursor: 1,
						eventCursor: 1,
					},
				},
			},
		],
		retiredAt: mapping.createdAt,
		...(prior === undefined ? {} : { prior }),
	});
	const prior = tombstone("older-project", "older-turn");
	const old = tombstone("old-project", "old-turn", prior);
	const operation = mapping.journal[0]!;
	return {
		...source,
		mappings: [
			{
				...mapping,
				reassignment: {
					state,
					sourceProjectId: state === "committed" ? "old-project" : mapping.projectId,
					targetProjectId: state === "committed" ? mapping.projectId : "other-project",
					startedAt: mapping.createdAt,
					...(state === "pending" ? {} : { completedAt: mapping.createdAt }),
					...(state === "committed"
						? { sourceTombstone: old, priorTombstone: structuredClone(prior) }
						: { priorTombstone: prior }),
				},
			},
		],
		provisionalOperations: [
			{ ...operation, chatId: mapping.chatId, projectId: mapping.projectId, sessionId: mapping.sessionId },
		],
	};
}

describe("adapter managed bootstrap composition", () => {
	test("bootstrap keeps the original finite mutation lease beyond thirty seconds", async () => {
		const started = Date.now();
		const now = spyOn(Date, "now").mockReturnValue(started);
		const f = await fixture({ timeoutMs: 60_000, onResume: () => now.mockReturnValue(started + 30_001) });
		try {
			const attempt = startAdapterSessionAuthorityV3Activation(f.input);
			const result = await attempt.result;
			if (result.status !== "activated") throw new Error("Expected bounded long activation.");
			result.store.close();
			await attempt.settled;
			expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
			expect(f.evidence()?.state).toBe("active_generation_proven");
		} finally {
			now.mockRestore();
			await f.cleanup();
		}
	});

	test.each(["lstat", "mkdir", "write", "reject"] as const)(
		"source initialization %s cannot outlive successful cleanup settlement",
		async phase => {
			const f = await fixture({ timeoutMs: 1_000 });
			await rm(f.sourcePath);
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const pause = async () => {
				entered.resolve();
				await gate.promise;
			};
			const originalLstat = filesystem.lstat;
			const originalMkdir = filesystem.mkdir;
			const originalWrite = filesystem.writeFile;
			const spy =
				phase === "mkdir"
					? spyOn(filesystem, "mkdir").mockImplementation((async (
							...args: Parameters<typeof filesystem.mkdir>
						) => {
							if (args[0] === f.root) await pause();
							return originalMkdir(...args);
						}) as typeof filesystem.mkdir)
					: phase === "write"
						? spyOn(filesystem, "writeFile").mockImplementation(async (...args) => {
								if (args[0] === f.sourcePath) await pause();
								return originalWrite(...args);
							})
						: spyOn(filesystem, "lstat").mockImplementation((async (
								...args: Parameters<typeof filesystem.lstat>
							) => {
								if (args[0] === f.sourcePath) {
									await pause();
									if (phase === "reject") throw new Error("late lstat failure");
								}
								return originalLstat(...args);
							}) as typeof filesystem.lstat);
			const attempt = startAdapterSessionAuthorityV3Activation(f.input);
			let finished = false;
			void attempt.settled.then(() => {
				finished = true;
			});
			try {
				await entered.promise;
				await expect(attempt.result).rejects.toThrow("bootstrap failed");
				expect(finished).toBe(false);
				expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
				await expect(RuntimeSingletonLock.acquire(f.root)).rejects.toThrow("already owned");
				expect(await Bun.file(f.sourcePath).exists()).toBe(false);
				gate.resolve();
				await attempt.settled;
				expect(await Bun.file(f.sourcePath).exists()).toBe(phase === "write");
				expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
				expect(f.calls).toEqual([]);
			} finally {
				gate.resolve();
				await attempt.settled;
				spy.mockRestore();
				await f.cleanup();
			}
		},
	);

	test("admission receives only detached staged candidates before resolver and SDK effects", async () => {
		const f = await fixture({ unscoped: true });
		let admitted = false;
		let released = false;
		const resolver = f.input.authority.resolve;
		const attempt = startAdapterSessionAuthorityV3Activation({
			...f.input,
			authority: {
				resolve: async (...args) => {
					expect(admitted).toBe(true);
					return resolver(...args);
				},
			},
			admission: {
				admit: async request => {
					expect(f.calls).toEqual([]);
					expect(f.graph().mappings[0]!.historicalBinding).toEqual(request.candidates[0]!.source);
					expect(request.candidates[0]!.principalId).toBe("owner");
					expect(request.candidates[0]!.chatId).toBe("chat");
					expect(request.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
					expect(request.remaining()).toBeGreaterThan(0);
					await request.assertCurrent();
					Reflect.set(request.candidates[0]!, "principalId", "foreign");
					expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
					admitted = true;
				},
				release: async () => {
					expect(f.runtime().state).toBe("stopped");
					expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
					released = true;
				},
			},
		});
		try {
			const result = await attempt.result;
			if (result.status !== "activated") throw new Error("Expected admitted activation.");
			result.store.close();
			await attempt.settled;
			expect(released).toBe(true);
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
		} finally {
			await f.cleanup();
		}
	});

	test("a later invalid candidate blocks all admission acquisitions", async () => {
		const f = await fixture({
			transformSource: source => ({
				...source,
				mappings: [
					...source.mappings,
					{
						...source.mappings[0]!,
						sessionId: "other",
						header: { ...source.mappings[0]!.header, chatId: "unowned", sessionId: "other" },
						chatId: "unowned",
						operationId: "other",
						journal: [],
					},
				],
			}),
		});
		let acquisitions = 0;
		try {
			const attempt = startAdapterSessionAuthorityV3Activation({
				...f.input,
				configuredOwnerUserId: "",
				admission: {
					admit: async () => {
						acquisitions++;
					},
					release: async () => {},
				},
			});
			expect((await attempt.result).status).toBe("blocked");
			await attempt.settled;
			expect(acquisitions).toBe(0);
			expect(f.calls).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});

	test.each([false, true])("late admission outcome rejects=%s stays owned until cleanup settles", async reject => {
		const f = await fixture({ timeoutMs: 500 });
		const acquisition = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const cleaning = Promise.withResolvers<void>();
		const started = Date.now();
		const now = spyOn(Date, "now").mockReturnValue(started);
		const nativeSetTimeout = globalThis.setTimeout;
		let expire: (() => void) | undefined;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			milliseconds?: number,
			...args: unknown[]
		) => {
			if (expire === undefined && milliseconds === 500) {
				expire = () => callback(...args);
				const handle = nativeSetTimeout(() => {}, 0);
				clearTimeout(handle);
				return handle;
			}
			return nativeSetTimeout(callback, milliseconds, ...args);
		}) as typeof setTimeout);
		let signal: AbortSignal | undefined;
		let settled = false;
		let acquired = false;
		const attempt = startAdapterSessionAuthorityV3Activation({
			...f.input,
			admission: {
				admit: async request => {
					signal = request.signal;
					entered.resolve();
					await acquisition.promise;
					acquired = true;
					if (reject) throw new Error("late acquisition failed");
				},
				release: async () => {
					expect(acquired).toBe(true);
					cleaning.resolve();
					await release.promise;
				},
			},
		});
		void attempt.settled.then(() => {
			settled = true;
		});
		try {
			await Promise.race([
				entered.promise,
				attempt.result.then(() => {
					throw new Error("Bootstrap completed before admission entered.");
				}),
			]);
			expect(signal?.aborted).toBe(false);
			expect(expire).toBeDefined();
			now.mockReturnValue(started + 500);
			expire!();
			await expect(attempt.result).rejects.toThrow("bootstrap failed");
			expect(signal?.aborted).toBe(true);
			expect(settled).toBe(false);
			expect(f.calls).toEqual([]);
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
			await expect(RuntimeSingletonLock.acquire(f.root)).rejects.toThrow("already owned");
			acquisition.resolve();
			await cleaning.promise;
			expect(settled).toBe(false);
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
			release.resolve();
			await attempt.settled;
			expect(f.calls).toEqual([]);
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
		} finally {
			timer.mockRestore();
			now.mockRestore();
			acquisition.resolve();
			release.resolve();
			await attempt.settled;
			await f.cleanup();
		}
	});

	test("concurrent failed activation does not release another attempt's admission", async () => {
		const f = await fixture();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let released = 0;
		const input = {
			...f.input,
			admission: {
				admit: async () => {
					entered.resolve();
					await gate.promise;
				},
				release: async () => {
					released++;
				},
			},
		};
		const first = startAdapterSessionAuthorityV3Activation(input);
		try {
			await entered.promise;
			const second = startAdapterSessionAuthorityV3Activation(input);
			await expect(second.result).rejects.toThrow("bootstrap failed");
			await second.settled;
			expect(released).toBe(0);
			gate.resolve();
			const result = await first.result;
			if (result.status !== "activated") throw new Error("Expected first activation.");
			result.store.close();
			await first.settled;
			expect(released).toBe(1);
		} finally {
			gate.resolve();
			await first.settled;
			await f.cleanup();
		}
	});

	test("partial admission failure is cleaned without constructing an SDK runtime", async () => {
		const f = await fixture();
		let released = 0;
		const attempt = startAdapterSessionAuthorityV3Activation({
			...f.input,
			admission: {
				admit: async () => {
					throw new Error("second acquisition failed");
				},
				release: async () => {
					released++;
				},
			},
		});
		try {
			await expect(attempt.result).rejects.toThrow("bootstrap failed");
			await attempt.settled;
			expect(released).toBe(1);
			expect(f.calls).toEqual([]);
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
		} finally {
			await f.cleanup();
		}
	});

	test("failed owned resource release rejects settlement and retains mutation exclusion", async () => {
		const f = await fixture({ failStart: true });
		const attempt = startAdapterSessionAuthorityV3Activation({
			...f.input,
			admission: {
				admit: async () => {},
				release: async () => {
					throw new Error("lease release failed");
				},
			},
		});
		try {
			await expect(attempt.result).rejects.toThrow("bootstrap failed");
			await expect(attempt.settled).rejects.toThrow("lease release failed");
			expect(f.runtime().state).toBe("stopped");
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test.each(["admin", "explicit", "sessionless", "sessionless-result"] as const)(
		"resolves unscoped %s history with one canonical live key",
		async variant => {
			const f = await fixture({
				unscoped: true,
				...(variant === "explicit" ? { explicitOwner: "owner", configuredOwner: "different-admin" } : {}),
				transformSource: source => {
					const graph = withReassignment(source, "committed");
					if (variant !== "sessionless" && variant !== "sessionless-result") return graph;
					const { sessionId: _session, result, ...reservation } = graph.provisionalOperations![0]!;
					return {
						...graph,
						provisionalOperations: [{ ...reservation, ...(variant === "sessionless-result" ? { result } : {}) }],
					};
				},
			});
			try {
				const result = await activateAdapterSessionAuthorityV3(f.input);
				if (result.status === "blocked") throw new Error(JSON.stringify(result.activation));
				expect(result.status).toBe("activated");
				const initial = f.initialGraph();
				const document = parseSessionAuthorityV3Document(await readFile(f.sourcePath))!;
				const record = document.mappings[0]!;
				expect(record.chatId).toBe(JSON.stringify(["owner", "chat"]));
				expect(record.header.chatId).toBe(record.chatId);
				expect(record.journal.slice(0, -1)).toEqual([...initial.mappings[0]!.journal]);
				expect(record.reassignment).toEqual(initial.mappings[0]!.reassignment);
				expect(document.provisionalOperations).toEqual(initial.provisionalOperations);
				expect(record.journal.at(-1)!.lifecycle!.historicalSource!.historicalBinding).toEqual(
					initial.mappings[0]!.historicalBinding!,
				);
				result.store.close();
				const store = new V3FileBackedSessionMappingStore(f.sourcePath);
				try {
					const scope = { principalId: "owner", chatId: "chat" };
					const current = store.getScoped(scope)!;
					expect(current.managedAuthority?.generation).toBe(7);
					expect(store.getScoped({ principalId: "different-admin", chatId: "chat" })).toBeUndefined();
					expect(store.provisionalOperationScoped(scope, "turn")).toEqual(document.provisionalOperations[0]!);
					store.beginOperationScoped(scope, { id: "fresh", kind: "prompt", detail: "fresh-hash" });
					store.completeOperationWithMappingScoped(
						scope,
						"fresh",
						"fresh-hash",
						{ ...current, operationId: "fresh", assistantText: "new" },
						"turn",
					);
					const reservation = {
						id: "publish",
						ingressId: "publish-alias",
						kind: "prompt" as const,
						detail: "publish-hash",
						chatId: "chat",
						projectId: "project",
					};
					store.reserveProvisionalOperationScoped(scope, reservation);
					store.publishProvisionalOperationScoped(scope, reservation, {
						...current,
						operationId: "publish",
						assistantText: "published",
					});
					expect(() =>
						store.reserveProvisionalOperationScoped(scope, {
							id: "turn",
							kind: "prompt",
							chatId: "chat",
							projectId: "project",
						}),
					).toThrow();
					const after = parseSessionAuthorityV3Document(await readFile(f.sourcePath))!;
					expect(after.mappings).toHaveLength(1);
					expect(after.mappings[0]!.journal.slice(0, record.journal.length)).toEqual([...record.journal]);
					expect(after.mappings[0]!.reassignment).toEqual(record.reassignment);
					expect(after.provisionalOperations[0]).toEqual(document.provisionalOperations[0]!);
				} finally {
					store.close();
				}
				const reopened = new V3FileBackedSessionMappingStore(f.sourcePath);
				try {
					expect(reopened.getScoped({ principalId: "owner", chatId: "chat" })?.assistantText).toBe("published");
					expect(reopened.provisionalOperationScoped({ principalId: "owner", chatId: "chat" }, "turn")).toEqual(
						document.provisionalOperations[0]!,
					);
					expect(reopened.operationScoped({ principalId: "owner", chatId: "chat" }, "turn")?.result).toEqual(
						record.journal[0]!.result,
					);
				} finally {
					reopened.close();
				}
				expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["occupied", "foreign-owner"] as const)(
		"blocks %s source scope without public effects",
		async scenario => {
			const f = await fixture({
				unscoped: scenario === "occupied",
				explicitOwner: scenario === "foreign-owner" ? "foreign" : undefined,
				transformSource: source => {
					if (scenario !== "occupied") return source;
					const original = source.mappings[0]!;
					const chatId = JSON.stringify(["owner", "chat"]);
					return {
						...source,
						mappings: [
							...source.mappings,
							{
								...original,
								chatId,
								sessionId: "other",
								header: { chatId, projectId: original.projectId, sessionId: "other" },
								operationId: "other",
								journal: [],
							},
						],
					};
				},
			});
			try {
				expect((await activateAdapterSessionAuthorityV3(f.input)).status).toBe("blocked");
				expect(f.calls).toEqual([]);
				expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			} finally {
				await f.cleanup();
			}
		},
	);

	test("uninvoked unscoped intent reuses its original identity and rejects changed owner or lease", async () => {
		const f = await fixture({ unscoped: true, stopAtPrepared: true });
		try {
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			const prepared = f.evidence()!;
			expect(prepared.state).toBe("intent_prepared");
			expect(f.calls.filter(call => call === "resume")).toHaveLength(0);
			expect(
				(await activateAdapterSessionAuthorityV3({ ...f.input, configuredOwnerUserId: "different-admin" })).status,
			).toBe("blocked");
			const resolve = f.input.authority.resolve;
			expect(
				(
					await activateAdapterSessionAuthorityV3({
						...f.input,
						authority: {
							resolve: async (...args) => {
								const authority = await resolve(...args);
								return authority === undefined ? undefined : { ...authority, leaseId: "replacement-lease" };
							},
						},
					})
				).status,
			).toBe("blocked");
			expect(f.evidence()).toEqual(prepared);
			const result = await activateAdapterSessionAuthorityV3(f.input);
			if (result.status !== "activated") throw new Error("Expected same-intent activation.");
			result.store.close();
			expect(f.evidence()?.requestKey).toBe(prepared.requestKey);
			expect(f.evidence()?.payloadHash).toBe(prepared.payloadHash);
			expect(f.evidence()?.preparedAuthority).toEqual(prepared.preparedAuthority);
			expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});

	test("unscoped uncertain invocation retains source identity and never resumes under a changed admin", async () => {
		const f = await fixture({ unscoped: true, revokeAfterResume: true });
		try {
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			const receipt = f.evidence()!;
			expect(receipt.state).toBe("uncertain");
			expect(receipt.acknowledged?.generation).toBe(7);
			expect(receipt.historicalSource?.historicalBinding.chatId).toBe("chat");
			expect(receipt.historicalSource?.historicalBinding.principalId).toBeUndefined();
			const before = f.graph();
			expect(
				(await activateAdapterSessionAuthorityV3({ ...f.input, configuredOwnerUserId: "different-admin" })).status,
			).toBe("blocked");
			expect(f.evidence()).toEqual(receipt);
			expect(f.graph().mappings[0]!.journal.at(-1)!.state).toBe("uncertain");
			expect(f.graph().mappings[0]!.journal.slice(0, -1)).toEqual(before.mappings[0]!.journal.slice(0, -1));
			const bytes = await readFile(f.stagePath);
			expect((await activateAdapterSessionAuthorityV3(f.input)).status).toBe("blocked");
			expect((await readFile(f.stagePath)).equals(bytes)).toBe(true);
			expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});

	test.each(["", " owner", "owner\n"])(
		"blocks missing or invalid configured owner %j before SDK effects",
		async configuredOwner => {
			const f = await fixture({ unscoped: true, configuredOwner });
			try {
				expect((await activateAdapterSessionAuthorityV3(f.input)).status).toBe("blocked");
				expect(f.calls).toEqual([]);
				expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["committed", "rolled_back", "pending"] as const)(
		"promotes only the current occurrence with %s reassignment history and no unresolved target",
		async state => {
			const f = await fixture({ transformSource: source => withReassignment(source, state) });
			try {
				const result = await activateAdapterSessionAuthorityV3(f.input);
				expect(result.status).toBe("activated");
				if (result.status !== "activated") throw new Error("Expected activated store.");
				const initial = f.initialGraph();
				expect(initial.mappings[0]!.reassignment?.state).toBe(state === "pending" ? "rolled_back" : state);
				const persisted = parseSessionAuthorityV3Document(await readFile(f.sourcePath))!;
				expect(persisted.mappings[0]!.reassignment).toEqual(initial.mappings[0]!.reassignment);
				expect(persisted.mappings[0]!.journal.slice(0, -1)).toEqual([...initial.mappings[0]!.journal]);
				expect(persisted.provisionalOperations).toEqual(initial.provisionalOperations);
				expect(persisted.mappings[0]!.managedAuthority?.generation).toBe(7);
				expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
				result.store.close();
				const reopened = new V3FileBackedSessionMappingStore(f.sourcePath);
				try {
					reopened.assertServingReady();
					expect(reopened.getScoped({ principalId: "owner", chatId: "chat" })?.managedAuthority?.generation).toBe(
						7,
					);
					expect(reopened.getScoped({ principalId: "foreign", chatId: "chat" })).toBeUndefined();
					const retainedOlder = persisted.mappings[0]!.reassignment!.priorTombstone!;
					const older = reopened.operationAuthorityScoped({ principalId: "owner", chatId: "chat" }, "older-turn");
					expect(older?.chatId).toBe(retainedOlder.chatId);
					expect(older?.header).toEqual(retainedOlder.header);
					expect(older?.historicalBinding).toEqual(retainedOlder.historicalBinding);
					expect(older?.journal).toEqual(retainedOlder.journal);
					expect(
						reopened.operationScoped({ principalId: "owner", chatId: "chat" }, "older-turn")?.result
							?.historicalBinding,
					).toBeDefined();
					expect(
						reopened.operationScoped({ principalId: "owner", chatId: "chat" }, "older-turn")?.result
							?.managedAuthority,
					).toBeUndefined();
					expect(
						reopened.operationScoped({ principalId: "foreign", chatId: "chat" }, "older-turn"),
					).toBeUndefined();
					expect(parseSessionAuthorityV3Document(await readFile(f.sourcePath))).toEqual(persisted);
				} finally {
					reopened.close();
				}
			} finally {
				await f.cleanup();
			}
		},
	);

	test.each(["pending", "missing-completion", "uncertain-history", "unassigned-provisional"] as const)(
		"blocks %s before SDK construction without discarding history",
		async scenario => {
			const f = await fixture({
				transformSource: source => {
					const graph = withReassignment(source, scenario === "pending" ? "pending" : "committed");
					const mapping = graph.mappings[0]!;
					const reassignment = mapping.reassignment!;
					if (scenario === "pending") {
						const target = { id: "destination", kind: "prompt" as const, detail: "destination-hash" };
						return {
							...graph,
							mappings: [{ ...mapping, reassignment: { ...reassignment, target } }],
							provisionalOperations: [
								...graph.provisionalOperations!,
								{
									...target,
									state: "pending",
									startedAt: mapping.createdAt,
									chatId: mapping.chatId,
									projectId: reassignment.targetProjectId,
								},
							],
						};
					}
					if (scenario === "missing-completion") {
						const { completedAt: _completed, ...unresolved } = reassignment;
						return { ...graph, mappings: [{ ...mapping, reassignment: unresolved }] };
					}
					if (scenario === "uncertain-history") {
						const old = reassignment.sourceTombstone!;
						return {
							...graph,
							mappings: [
								{
									...mapping,
									reassignment: {
										...reassignment,
										sourceTombstone: {
											...old,
											journal: [
												...old.journal,
												{
													id: "uncertain-effect",
													kind: "branch",
													state: "uncertain",
													startedAt: mapping.createdAt,
												},
											],
										},
									},
								},
							],
						};
					}
					return scenario === "unassigned-provisional"
						? {
								...graph,
								provisionalOperations: [
									...graph.provisionalOperations!,
									{
										id: "unassigned",
										kind: "create",
										state: "uncertain",
										startedAt: mapping.createdAt,
										chatId: "unassigned-chat",
										projectId: "project",
									},
								],
							}
						: graph;
				},
			});
			try {
				const result = await activateAdapterSessionAuthorityV3(f.input);
				expect(result.status).toBe("blocked");
				expect(f.calls).toEqual([]);
				expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
				const retained = await readFile(f.stagePath);
				expect(f.graph().mappings[0]!.historicalBinding).toBeDefined();
				expect((await activateAdapterSessionAuthorityV3(f.input)).status).toBe("blocked");
				expect((await readFile(f.stagePath)).equals(retained)).toBe(true);
				expect(f.calls).toEqual([]);
			} finally {
				await f.cleanup();
			}
		},
	);

	test("lock release failure is observable without releasing an external replacement", async () => {
		let lockPath = "";
		const replacement = "external mutation owner\n";
		const f = await fixture({
			onStop: async () => {
				await rename(lockPath, `${lockPath}.retained`);
				await writeFile(lockPath, replacement);
			},
		});
		lockPath = `${f.sourcePath}.lock`;
		try {
			const error = await activateAdapterSessionAuthorityV3(f.input).catch(error => error);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors.map(error => error.message)).toEqual([
				"Session authority mutation lease ownership changed before release.",
			]);
			expect(f.runtime().state).toBe("stopped");
			expect(await readFile(lockPath, "utf8")).toBe(replacement);
			expect(parseSessionAuthorityV3Document(await readFile(f.sourcePath))).toBeDefined();
		} finally {
			await f.cleanup();
		}
	});

	test("Router start failure stops locally and releases mutation ownership without invoking resume", async () => {
		const f = await fixture({ failStart: true });
		try {
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			expect(f.calls).toEqual(["construct", "start", "stop"]);
			expect(f.runtime().state).toBe("stopped");
			expect(f.evidence()).toBeUndefined();
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
			expect(await Bun.file(`${f.sourcePath}.v3-active.json`).exists()).toBe(false);
			await Promise.all([f.runtime().dispose(), f.runtime().dispose()]);
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});

	test("failed local shutdown retains mutation ownership and exposes both failures", async () => {
		const f = await fixture({ failResume: true, failStop: true });
		try {
			const error = await activateAdapterSessionAuthorityV3(f.input).catch(error => error);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors.map(error => error.message)).toEqual([
				"lost outcome",
				"router stop failed",
				"Bootstrap shutdown is unproven; mutation ownership remains held.",
			]);
			expect(f.runtime().state).toBe("failed");
			expect(f.evidence()?.state).toBe("uncertain");
			const ownedLock = await readFile(`${f.sourcePath}.lock`, "utf8");
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			expect(await readFile(`${f.sourcePath}.lock`, "utf8")).toBe(ownedLock);
			expect(f.calls.filter(call => call === "construct")).toHaveLength(1);
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
		} finally {
			await expect(f.cleanup()).rejects.toThrow("router stop failed");
		}
	});

	test("concurrent activation cannot duplicate an in-flight resume or share bootstrap capabilities", async () => {
		let entered!: () => void;
		let release!: () => void;
		const invoked = new Promise<void>(resolve => {
			entered = resolve;
		});
		const f = await fixture({
			onResume: () => entered(),
			resumeGate: new Promise<void>(resolve => {
				release = resolve;
			}),
		});
		const first = activateAdapterSessionAuthorityV3(f.input);
		try {
			await Promise.race([
				invoked,
				first.then(() => {
					throw new Error("Activation missed resume barrier.");
				}),
			]);
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			expect(f.calls.filter(call => call === "construct")).toHaveLength(1);
			expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
			expect(f.evidence()?.state).toBe("invoking");
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			release();
			const result = await first;
			expect(result.status).toBe("activated");
			expect(Object.keys(result).sort()).toEqual(["activation", "status", "store"]);
			if (result.status === "activated") result.store.close();
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
			await Promise.all([f.runtime().dispose(), f.runtime().dispose()]);
			expect(f.calls.filter(call => call === "stop")).toHaveLength(1);
		} finally {
			release();
			await first.catch(() => undefined);
			await f.cleanup();
		}
	});

	test("an attachment invalidated during final lease checking cannot be committed", async () => {
		const f = await fixture({ staleAtCommit: true });
		try {
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			expect(f.evidence()?.state).toBe("active_generation_proven");
			expect(f.calls.at(-1)).toBe("stop");
		} finally {
			await f.cleanup();
		}
	});

	test("expired operation retains mutation ownership until shutdown is proven", async () => {
		let resume!: () => void;
		let stop!: () => void;
		const f = await fixture({
			timeoutMs: 500,
			resumeGate: new Promise<void>(resolve => {
				resume = resolve;
			}),
			stopGate: new Promise<void>(resolve => {
				stop = resolve;
			}),
		});
		const attempt = startAdapterSessionAuthorityV3Activation(f.input);
		try {
			await expect(attempt.result).rejects.toThrow("bootstrap failed");
			expect(f.runtime().state).not.toBe("stopped");
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			resume();
			stop();
			await f.runtime().dispose();
			expect(f.runtime().state).toBe("stopped");
			await attempt.settled;
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(false);
		} finally {
			resume();
			stop();
			await f.cleanup();
		}
	});

	test("preserves history while staging intent, immediate acknowledgement, proof and atomic promotion", async () => {
		const f = await fixture();
		try {
			const result = await activateAdapterSessionAuthorityV3(f.input);
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Expected activated store.");
			const history = result.store.operationScoped({ principalId: "owner", chatId: "chat" }, "turn")!;
			expect(history.result?.assistantText).toBe("retained answer");
			expect(history.result?.historicalBinding).toBeDefined();
			expect(history.result?.managedAuthority).toBeUndefined();
			expect(result.store.getScoped({ principalId: "owner", chatId: "chat" })?.managedAuthority?.generation).toBe(7);
			expect(result.store.getScoped({ principalId: "foreign", chatId: "chat" })).toBeUndefined();
			expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
			expect(f.evidence()?.state).toBe("active_generation_proven");
			const operation = f.graph().mappings[0]!.journal.at(-1)!;
			await expect(f.runtime().resumeHistoricalSession(operation.id, operation.lifecycle!)).rejects.toThrow();
			expect(f.calls.filter(call => call === "resume")).toHaveLength(1);
			expect(f.runtime().state).toBe("stopped");
			result.store.close();
		} finally {
			await f.cleanup();
		}
	});

	test("unresolved owner leaves ordinary history readable without constructing public SDK", async () => {
		const f = await fixture({ unresolved: true });
		try {
			const result = await activateAdapterSessionAuthorityV3(f.input);
			expect(result.status).toBe("blocked");
			expect(f.calls).toEqual([]);
			expect(f.graph().mappings[0]!.journal[0]!.result?.assistantText).toBe("retained answer");
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
		} finally {
			await f.cleanup();
		}
	});

	test.each([
		{ failResume: true },
		{ sessionId: "foreign" },
		{ generation: 0 },
		{ stale: true },
		{ revokeAfterResume: true },
	])("blocks uncertain or invalid public lifecycle result %j", async options => {
		const f = await fixture(options);
		try {
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			expect(f.calls.at(-1)).toBe("stop");
			expect(f.evidence()?.state).toBe("uncertain");
			if (options.revokeAfterResume || options.stale) expect(f.evidence()?.acknowledged?.generation).toBe(7);
			const count = f.calls.filter(call => call === "resume").length;
			const retry = await activateAdapterSessionAuthorityV3(f.input);
			expect(retry.status).toBe("blocked");
			expect(f.evidence()?.state).toBe("uncertain");
			expect(f.calls.filter(call => call === "resume")).toHaveLength(count);
		} finally {
			await f.cleanup();
		}
	});

	test("empty authority activates without a lifecycle invocation", async () => {
		const f = await fixture({ empty: true });
		try {
			const result = await activateAdapterSessionAuthorityV3(f.input);
			expect(result.status).toBe("activated");
			expect(f.calls).not.toContain("resume");
			if (result.status === "activated") result.store.close();
		} finally {
			await f.cleanup();
		}
	});
});
