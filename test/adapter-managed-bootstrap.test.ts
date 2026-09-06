import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import { type AdapterManagedBootstrapInput, activateAdapterSessionAuthorityV3 } from "../src/adapter-managed-bootstrap";
import { ManagedSdkRuntime, type ManagedSdkRuntimeDeps } from "../src/gjc/managed-sdk-runtime";
import type { SessionAuthorityTombstone } from "../src/gjc/session-authority-types";
import { parseSessionAuthorityV3Document, type SessionAuthorityV3Document } from "../src/gjc/session-authority-v3";
import type { SessionAuthorityV2Document } from "../src/gjc/session-authority-v3-migration";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";

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
		transformSource?: (source: SessionAuthorityV2Document) => SessionAuthorityV2Document;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "adapter-bootstrap-owned-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const sourcePath = join(root, "authority.json");
	const chatId = JSON.stringify(["owner", "chat"]);
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
	let runtime!: ManagedSdkRuntime;
	let deps!: ManagedSdkRuntimeDeps;
	let initialGraph: SessionAuthorityV3Document | undefined;
	const graph = () => parseSessionAuthorityV3Document(readFileSync(stagePath))!;
	const evidence = () => graph().mappings[0]?.journal.at(-1)?.lifecycle;
	const input: AdapterManagedBootstrapInput = {
		locations: { agentDir: root, stateRoot: root },
		sourcePath,
		configuredOwnerUserId: "owner",
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
		try {
			await expect(activateAdapterSessionAuthorityV3(f.input)).rejects.toThrow("bootstrap failed");
			expect(f.runtime().state).not.toBe("stopped");
			expect(await Bun.file(`${f.sourcePath}.lock`).exists()).toBe(true);
			expect(await readFile(f.sourcePath, "utf8")).toBe(f.original);
			resume();
			stop();
			await f.runtime().dispose();
			expect(f.runtime().state).toBe("stopped");
			await Promise.resolve();
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
