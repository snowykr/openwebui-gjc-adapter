import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateAdapterSessionAuthorityV3, createAdapterManagedBootstrap } from "../src/adapter-managed-bootstrap";
import type { SessionMapping } from "../src/gjc/session-router";
import type { RegisteredProject } from "../src/projects/registry";

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
		const result = await activateAdapterSessionAuthorityV3({
			locations: { agentDir: root, stateRoot: root },
			configuredOwnerUserId: "owner",
			mappings: { mappingRecordsIterable: function* () {} },
			sourcePath,
			runtimeLock: { release: async () => {} } as never,
			authority: { resolve: async () => undefined },
			runtime,
			lifecycle: {} as never,
		});
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
		const result = await activateAdapterSessionAuthorityV3({
			locations: { agentDir: root, stateRoot: root },
			configuredOwnerUserId: "owner",
			mappings: {
				mappingRecordsIterable: function* () {
					yield { chatId: "chat", projectId: "project", sessionId: "session" } as SessionMapping;
				},
			},
			sourcePath,
			runtimeLock: { release: async () => {} } as never,
			authority: { resolve: async () => undefined },
			runtime: {} as never,
			lifecycle: {} as never,
		});
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
