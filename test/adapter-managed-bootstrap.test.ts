import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import { type AdapterManagedBootstrapInput, activateAdapterSessionAuthorityV3 } from "../src/adapter-managed-bootstrap";
import { ManagedSdkRuntime, type ManagedSdkRuntimeDeps } from "../src/gjc/managed-sdk-runtime";
import { parseSessionAuthorityV3Document } from "../src/gjc/session-authority-v3";
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
		timeoutMs?: number;
		staleAtCommit?: boolean;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "adapter-bootstrap-owned-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const sourcePath = join(root, "authority.json");
	const chatId = JSON.stringify(["owner", "chat"]);
	const stamp = "2026-01-01T00:00:00.000Z";
	const original = JSON.stringify({
		kind: "openwebui-gjc-session-authority",
		version: 2,
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
			expect(graph().version).toBe(3);
			expect(readFileSync(sourcePath, "utf8")).toBe(original);
			const attachment = { sessionId: "session", generation: 7, isCurrent: () => !stale };
			const sdkRouter = {
				start: async () => {
					calls.push("start");
				},
				stop: async () => {
					calls.push("stop");
					await options.stopGate;
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
		evidence,
		runtime: () => runtime,
		deps: () => deps,
		cleanup: async () => {
			await runtime?.dispose();
			await runtimeLock.release();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("adapter managed bootstrap composition", () => {
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
