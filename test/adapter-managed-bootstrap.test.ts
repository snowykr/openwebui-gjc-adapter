import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateAdapterSessionAuthorityV3, createAdapterManagedBootstrap } from "../src/adapter-managed-bootstrap";
import type { SessionMapping } from "../src/gjc/session-router";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import type { RegisteredProject } from "../src/projects/registry";
import { RuntimeSingletonLock } from "../src/runtime-singleton-lock";

const project = (cwd: string): RegisteredProject => ({
	id: "project",
	name: "project",
	cwd,
	allowedRoot: cwd,
	sessionRoot: join(cwd, ".gjc", "sessions"),
	createdAt: new Date(0),
});

function mapping(principalId: string | undefined, sessionFile: string, workspace: string): SessionMapping {
	return {
		...(principalId === undefined ? {} : { principalId }),
		chatId: "chat",
		projectId: "project",
		sessionId: "session",
		sessionFile,
		operationId: "operation",
		rawFrameCursor: 1,
		eventCursor: 2,
		attachment: {
			descriptorPath: "/state/descriptor",
			descriptorStat: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
			payloadDigest: "a".repeat(64),
			generation: 1,
			expectedSessionId: "session",
			expectedCwd: workspace,
		},
	};
}

describe("adapter managed bootstrap composition", () => {
	test("reopens unbound scoped history before any public runtime or lifecycle effect", async () => {
		const root = await mkdtemp(join(tmpdir(), "adapter-managed-unbound-"));
		const sourcePath = join(root, "authority.json");
		const chatId = JSON.stringify(["owner", "chat"]);
		const timestamp = "2026-01-01T00:00:00.000Z";
		const original = JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: 2,
			mappings: [
				{
					version: 2,
					chatId,
					projectId: "project",
					sessionId: "session",
					createdAt: timestamp,
					header: { chatId, projectId: "project", sessionId: "session" },
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "turn",
					sessionFile: "/history/session.jsonl",
					observations: {
						__gjcSessionMappingScope: { principalId: "owner", chatId: "chat" },
					},
					journal: [
						{
							id: "turn",
							kind: "prompt",
							state: "complete",
							startedAt: timestamp,
							completedAt: timestamp,
							result: {
								kind: "turn",
								assistantText: "retained answer",
								mapping: {
									chatId,
									projectId: "project",
									sessionId: "session",
									operationId: "turn",
									rawFrameCursor: 0,
									eventCursor: 0,
								},
							},
						},
					],
				},
			],
			provisionalOperations: [],
		});
		await writeFile(sourcePath, original);
		const runtimeLock = await RuntimeSingletonLock.acquire(root);
		const effect = mock(() => {
			throw new Error("Public effects are forbidden before staged proof.");
		});
		try {
			const result = await activateAdapterSessionAuthorityV3({
				locations: { agentDir: root, stateRoot: root },
				configuredOwnerUserId: "owner",
				sourcePath,
				runtimeLock,
				authority: { resolve: effect },
				runtime: { start: effect, resumeExternalLifecycleSession: effect } as never,
				lifecycle: { resumeLifecycleSession: effect },
			});
			expect(result.status).toBe("blocked");
			expect(effect).not.toHaveBeenCalled();
			expect(await Bun.file(sourcePath).text()).toBe(original);
			expect(await Bun.file(`${sourcePath}.v3-active.json`).exists()).toBe(false);
			const staged = join(
				root,
				`session-authority-v3-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`,
				"canonical.v3.json",
			);
			const store = new V3FileBackedSessionMappingStore(staged);
			expect(store.getScoped({ principalId: "owner", chatId: "chat" })).toBeUndefined();
			expect(store.operationScoped({ principalId: "owner", chatId: "chat" }, "turn")?.result?.assistantText).toBe(
				"retained answer",
			);
			store.close();
		} finally {
			await runtimeLock.release();
		}
	});

	test("activates an absent authority as an empty canonical V3 store without reading session files", async () => {
		const root = await mkdtemp(join(tmpdir(), "adapter-managed-v3-empty-"));
		const sourcePath = join(root, "authority.v2.json");
		const runtime = {
			state: "new",
			start: async () => {},
			dispose: async () => {},
			reconcile: async () => {},
			registerTenant: () => {},
			acquireAttachment: async () => ({ isCurrent: () => true }),
			generationStatus: async () => ({ status: "current" }),
		} as never;
		const runtimeLock = await RuntimeSingletonLock.acquire(root);
		const result = await activateAdapterSessionAuthorityV3({
			locations: { agentDir: root, stateRoot: root },
			configuredOwnerUserId: "owner",
			mappings: { mappingRecordsIterable: function* () {} },
			sourcePath,
			runtimeLock,
			authority: { resolve: async () => undefined },
			runtime,
			lifecycle: {} as never,
		});
		await runtimeLock.release();
		expect(result.status).toBe("activated");
		if (result.status !== "activated") return;
		expect(result.store.mappingRecords()).toEqual([]);
		await result.managed.dispose();
	});

	test("blocks incomplete V2 graph authority before touching canonical source bytes", async () => {
		const root = await mkdtemp(join(tmpdir(), "adapter-managed-v3-blocked-"));
		const sourcePath = join(root, "authority.v2.json");
		const bytes = '{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n';
		await writeFile(sourcePath, bytes);
		const runtimeLock = await RuntimeSingletonLock.acquire(root);
		const result = await activateAdapterSessionAuthorityV3({
			locations: { agentDir: root, stateRoot: root },
			configuredOwnerUserId: "owner",
			mappings: {
				mappingRecordsIterable: function* () {
					yield { chatId: "chat", projectId: "project", sessionId: "session" } as SessionMapping;
				},
			},
			sourcePath,
			runtimeLock,
			authority: { resolve: async () => undefined },
			runtime: {} as never,
			lifecycle: {} as never,
		});
		await runtimeLock.release();
		expect(result.status).toBe("blocked");
		expect(await Bun.file(sourcePath).text()).toBe(bytes);
	});

	test("derives deterministic owner-fallback evidence from mapping metadata without opening routes", async () => {
		const root = await mkdtemp(join(tmpdir(), "adapter-managed-bootstrap-"));
		const workspace = join(root, "workspace");
		const sessionRoot = join(workspace, ".gjc", "sessions");
		const sessionFile = join(sessionRoot, "session.jsonl");
		const sourcePath = join(root, "authority.v2.json");
		await mkdir(sessionRoot, { recursive: true });
		await writeFile(sessionFile, "not read");
		await writeFile(sourcePath, "authority");
		const bootstrap = createAdapterManagedBootstrap({
			locations: { agentDir: root, stateRoot: root },
			configuredOwnerUserId: "owner",
			mappings: {
				mappingRecordsIterable: function* () {
					yield mapping(undefined, sessionFile, workspace);
				},
			},
			sourcePath,
			runtimeLock: { release: async () => {} } as never,
			authority: {
				resolve: async (principalId, projectId) =>
					principalId === "owner" && projectId === "project"
						? {
								project: project(workspace),
								canonicalWorkspace: workspace,
								leaseId: "lease",
								epoch: "epoch",
								assertFence: () => {},
							}
						: undefined,
			},
			runtime: {} as never,
			lifecycle: {} as never,
		});
		const first = await bootstrap.options.legacyEvidence();
		const second = await bootstrap.options.legacyEvidence();
		expect(first).toEqual(second);
		expect(first.records).toEqual([
			{
				principalId: "owner",
				projectId: "project",
				canonicalWorkspace: workspace,
				chatId: "chat",
				sessionId: "session",
			},
		]);
	});

	test("delegates request-scoped lease identities to the live tenant fence", async () => {
		const root = await mkdtemp(join(tmpdir(), "adapter-managed-live-fence-"));
		const sourcePath = join(root, "authority.v2.json");
		await writeFile(sourcePath, "authority");
		const seen: string[] = [];
		const bootstrap = createAdapterManagedBootstrap({
			locations: { agentDir: root, stateRoot: root },
			configuredOwnerUserId: "owner",
			mappings: {
				mappingRecordsIterable: function* () {
					yield {
						principalId: "owner",
						projectId: "project",
						chatId: "chat",
						sessionId: "session",
						operationId: "operation",
					} as SessionMapping;
				},
			},
			sourcePath,
			runtimeLock: { release: async () => {} } as never,
			authority: { resolve: async () => undefined },
			liveTenantFence: async key => {
				seen.push(key.leaseId);
				return key.leaseId === "live-lease";
			},
			runtime: {} as never,
			lifecycle: {} as never,
		});
		await expect(
			bootstrap.options.tenantFence({
				principalId: "owner",
				projectId: "project",
				canonicalWorkspace: root,
				chatId: "chat",
				sessionId: "session",
				generation: 1,
				leaseId: "live-lease",
				epoch: "epoch",
			}),
		).resolves.toBe(true);
		expect(seen).toEqual(["live-lease"]);
	});
});
