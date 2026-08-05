import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { SessionMappingStore } from "../src/gjc/session-router";
import {
	createProjectionOperationApplier,
	expectedProjectionRows,
	synthesizeProjectionRows,
} from "../src/live/workflow-gate-projection";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { ProjectLinkService } from "../src/projects/link-service";
import { SqliteProjectRegistrationStore } from "../src/projects/registration-store";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import {
	buildProjectionPayloadHash,
	FileBackedOutboxStore,
	InMemoryOutboxStore,
	nodeOutboxFileSystem,
	type OutboxFileSystem,
	type OutboxStore,
} from "../src/state/outbox";
import { reconcilePendingOperations } from "../src/state/reconciler";
import { messageEntry, writeSessionFile } from "./session-sync-fixtures";

const createdAt = new Date("2026-07-08T00:00:00.000Z");

function enqueueChatOperation(store: OutboxStore, operationId = "op-1", principalId?: string, chatId = "chat-1"): void {
	store.enqueue({
		operationId,
		...(principalId === undefined ? {} : { principalId }),
		ownerUserId: "user-1",
		projectId: "project-1",
		chatId,
		kind: "chat",
		payloadHash: buildProjectionPayloadHash({ chatId, title: "Example" }),
		now: createdAt,
	});
}

describe("InMemoryOutboxStore", () => {
	test("rejects a same-ID enqueue with a different payload only while it is applying", () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);
		store.markApplying({ chatId: "chat-1", operationId: "op-1" });

		expect(() =>
			store.enqueue({
				operationId: "op-1",
				ownerUserId: "user-1",
				projectId: "project-1",
				chatId: "chat-1",
				kind: "chat",
				payloadHash: buildProjectionPayloadHash({ title: "Different" }),
				now: new Date("2026-07-08T00:01:00.000Z"),
			}),
		).toThrow("Projection operation ID conflict: op-1");
		expect(store.listPending()).toHaveLength(0);
	});
	test("supersedes an applied same-ID row whose projection payload evolved", () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);
		store.markApplied({ chatId: "chat-1", operationId: "op-1" });

		const superseded = store.enqueue({
			operationId: "op-1",
			ownerUserId: "user-1",
			projectId: "project-1",
			chatId: "chat-1",
			kind: "chat",
			payloadHash: buildProjectionPayloadHash({ title: "Evolved" }),
			now: new Date("2026-07-08T00:01:00.000Z"),
		});

		expect(superseded).toMatchObject({
			operationId: "op-1",
			state: "pending",
			payloadHash: buildProjectionPayloadHash({ title: "Evolved" }),
		});
		expect(store.listPending()).toHaveLength(1);
	});

	test("accepts an exact same-ID immutable replay", () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);

		const replayed = store.enqueue({
			operationId: "op-1",
			ownerUserId: "user-1",
			projectId: "project-1",
			chatId: "chat-1",
			kind: "chat",
			payloadHash: buildProjectionPayloadHash({ chatId: "chat-1", title: "Example" }),
			now: new Date("2026-07-08T00:01:00.000Z"),
		});

		expect(replayed).toMatchObject({ operationId: "op-1", state: "pending", attempts: 0 });
	});
	test("keeps identical remote identifiers independent across principals", () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store, "shared-operation", "principal-a");
		enqueueChatOperation(store, "shared-operation", "principal-b");

		expect(store.listPending()).toHaveLength(2);
		expect(
			store.get({ principalId: "principal-a", chatId: "chat-1", operationId: "shared-operation" }),
		).toMatchObject({ principalId: "principal-a", chatId: "chat-1", operationId: "shared-operation" });
		expect(
			store.get({ principalId: "principal-b", chatId: "chat-1", operationId: "shared-operation" }),
		).toMatchObject({ principalId: "principal-b", chatId: "chat-1", operationId: "shared-operation" });
		expect(() => store.get("shared-operation")).toThrow("ambiguous");
	});

	test("builds stable canonical payload hashes", () => {
		const left = buildProjectionPayloadHash({
			chatId: "chat-1",
			nested: { b: true, a: [2, "two", null] },
		});
		const right = buildProjectionPayloadHash({
			nested: { a: [2, "two", null], b: true },
			chatId: "chat-1",
		});

		expect(left).toBe(right);
		expect(left).toHaveLength(64);
		expect(left).not.toBe(buildProjectionPayloadHash({ chatId: "chat-2" }));
	});
});

describe("FileBackedOutboxStore", () => {
	test("persists operations across new store instances", () => {
		const filePath = `${tmpdir()}/openwebui-gjc-adapter-outbox-${Date.now()}.json`;
		const first = new FileBackedOutboxStore(filePath);
		enqueueChatOperation(first);

		const second = new FileBackedOutboxStore(filePath);

		expect(second.get("op-1")).toMatchObject({ operationId: "op-1", state: "pending" });
		expect(second.listPending().map(operation => operation.operationId)).toEqual(["op-1"]);
	});
	test("persists principal scope across store restarts", () => {
		const filePath = `${tmpdir()}/openwebui-gjc-adapter-scoped-restart-${Date.now()}.json`;
		const first = new FileBackedOutboxStore(filePath);
		try {
			enqueueChatOperation(first, "shared-operation", "principal-a");
			enqueueChatOperation(first, "shared-operation", "principal-b");

			const second = new FileBackedOutboxStore(filePath);
			expect(second.listPending().map(operation => operation.principalId)).toEqual(["principal-a", "principal-b"]);
			expect(
				second.get({ principalId: "principal-a", chatId: "chat-1", operationId: "shared-operation" }),
			).toMatchObject({ principalId: "principal-a" });
			expect(
				second.get({ principalId: "principal-b", chatId: "chat-1", operationId: "shared-operation" }),
			).toMatchObject({ principalId: "principal-b" });
		} finally {
			rmSync(filePath, { force: true });
		}
	});
	test("rejects corrupt or unversioned persisted documents", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-"));
		try {
			const filePath = join(directory, "outbox.json");
			writeFileSync(filePath, JSON.stringify({ operations: [] }));

			expect(() => new FileBackedOutboxStore(filePath)).toThrow("Invalid outbox document");

			writeFileSync(filePath, JSON.stringify({ version: 2, operations: [] }));
			expect(() => new FileBackedOutboxStore(filePath)).toThrow("Invalid outbox document");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
	test("parses legacy persisted rows without a principal scope", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-legacy-"));
		try {
			const filePath = join(directory, "outbox.json");
			writeFileSync(
				filePath,
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "legacy-op",
							ownerUserId: "admin",
							projectId: "project-1",
							chatId: "chat-1",
							kind: "chat",
							state: "pending",
							payloadHash: buildProjectionPayloadHash({ chatId: "chat-1", title: "Legacy" }),
							attempts: 0,
							createdAt: createdAt.toISOString(),
							updatedAt: createdAt.toISOString(),
						},
					],
				}),
			);

			const store = new FileBackedOutboxStore(filePath);
			const legacy = store.get("legacy-op");
			expect(legacy).toMatchObject({
				operationId: "legacy-op",
				chatId: "chat-1",
			});
			expect(legacy).not.toHaveProperty("principalId");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("rejects malformed present principal metadata", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-principal-"));
		try {
			const filePath = join(directory, "outbox.json");
			writeFileSync(
				filePath,
				JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "bad-principal",
							principalId: " ",
							ownerUserId: "admin",
							projectId: "project-1",
							chatId: "chat-1",
							kind: "chat",
							state: "pending",
							payloadHash: buildProjectionPayloadHash({ chatId: "chat-1", title: "Bad" }),
							attempts: 0,
							createdAt: createdAt.toISOString(),
							updatedAt: createdAt.toISOString(),
						},
					],
				}),
			);

			expect(() => new FileBackedOutboxStore(filePath)).toThrow("Invalid outbox operation");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
	test("ignores incomplete temporary files left by an interrupted persistence", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-"));
		try {
			const filePath = join(directory, "outbox.json");
			writeFileSync(filePath, JSON.stringify({ version: 1, operations: [] }));
			writeFileSync(join(directory, ".outbox-interrupted.tmp"), "{");
			const store = new FileBackedOutboxStore(filePath);

			enqueueChatOperation(store);

			expect(new FileBackedOutboxStore(filePath).get("op-1")?.state).toBe("pending");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("rejects symlink and nonregular outbox paths", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-"));
		try {
			const target = join(directory, "target.json");
			const symlink = join(directory, "outbox-link.json");
			writeFileSync(target, JSON.stringify({ operations: [] }));
			symlinkSync(target, symlink);

			expect(() => new FileBackedOutboxStore(symlink)).toThrow("regular file");
			expect(() => new FileBackedOutboxStore(directory)).toThrow("regular file");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("rejects a symlink introduced after the store is loaded", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-"));
		try {
			const filePath = join(directory, "outbox.json");
			const target = join(directory, "target.json");
			const store = new FileBackedOutboxStore(filePath);
			enqueueChatOperation(store);
			writeFileSync(target, JSON.stringify({ operations: [] }));
			rmSync(filePath);
			symlinkSync(target, filePath);

			expect(() => enqueueChatOperation(store, "op-2")).toThrow("regular file");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
	test("keeps enqueue memory unchanged and retries durability after every persistence boundary fails", () => {
		const boundaries = ["open", "write", "file fsync", "rename", "directory fsync"] as const;

		for (const boundary of boundaries) {
			const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-"));
			try {
				const filePath = join(directory, "outbox.json");
				let failed = false;
				let fsyncCalls = 0;
				const fileSystem: OutboxFileSystem = {
					...nodeOutboxFileSystem,
					open: (path, flags, mode) => {
						if (!failed && boundary === "open" && flags === "wx") {
							failed = true;
							throw new Error("injected open failure");
						}
						return nodeOutboxFileSystem.open(path, flags, mode);
					},
					writeFile: (fileDescriptor, data) => {
						if (!failed && boundary === "write") {
							failed = true;
							throw new Error("injected write failure");
						}
						nodeOutboxFileSystem.writeFile(fileDescriptor, data);
					},
					fsync: fileDescriptor => {
						fsyncCalls += 1;
						if (
							!failed &&
							((boundary === "file fsync" && fsyncCalls === 1) ||
								(boundary === "directory fsync" && fsyncCalls === 2))
						) {
							failed = true;
							throw new Error(`injected ${boundary} failure`);
						}
						nodeOutboxFileSystem.fsync(fileDescriptor);
					},
					rename: (from, to) => {
						if (!failed && boundary === "rename") {
							failed = true;
							throw new Error("injected rename failure");
						}
						nodeOutboxFileSystem.rename(from, to);
					},
				};
				const store = new FileBackedOutboxStore(filePath, fileSystem);

				expect(() => enqueueChatOperation(store)).toThrow(`injected ${boundary} failure`);
				expect(store.get("op-1")).toBeUndefined();
				expect(store.listPending()).toEqual([]);

				enqueueChatOperation(store);
				expect(new FileBackedOutboxStore(filePath).get("op-1")).toMatchObject({ state: "pending" });
			} finally {
				rmSync(directory, { force: true, recursive: true });
			}
		}
	});

	test("keeps mark mutations in memory unchanged when persistence fails", () => {
		const directory = mkdtempSync(join(tmpdir(), "openwebui-gjc-adapter-outbox-"));
		try {
			const filePath = join(directory, "outbox.json");
			let failed = false;
			let armed = false;
			const fileSystem: OutboxFileSystem = {
				...nodeOutboxFileSystem,
				writeFile: (fileDescriptor, data) => {
					if (armed && !failed) {
						failed = true;
						throw new Error("injected write failure");
					}
					nodeOutboxFileSystem.writeFile(fileDescriptor, data);
				},
			};
			const store = new FileBackedOutboxStore(filePath, fileSystem);
			enqueueChatOperation(store);
			armed = true;

			expect(() => store.markApplying("op-1")).toThrow("injected write failure");
			expect(store.get("op-1")).toMatchObject({ state: "pending", attempts: 0 });

			store.markApplying("op-1");
			expect(new FileBackedOutboxStore(filePath).get("op-1")).toMatchObject({ state: "applying", attempts: 1 });
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});

describe("reconcilePendingOperations", () => {
	test("applies pending operations once and skips applied operations on later runs", async () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);
		const appliedOperationIds: string[] = [];

		const first = await reconcilePendingOperations(store, operation => {
			appliedOperationIds.push(operation.operationId);
		});
		const second = await reconcilePendingOperations(store, operation => {
			appliedOperationIds.push(operation.operationId);
		});

		expect(first.applied.map(operation => operation.operationId)).toEqual(["op-1"]);
		expect(second.applied).toEqual([]);
		expect(appliedOperationIds).toEqual(["op-1"]);
		expect(store.get("op-1")?.state).toBe("applied");
		expect(store.get("op-1")?.attempts).toBe(1);
	});

	test("retries crash-style pending operations left unapplied", async () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);
		const result = await reconcilePendingOperations(store, () => undefined);

		expect(result.applied.map(operation => operation.operationId)).toEqual(["op-1"]);
		expect(store.get("op-1")?.state).toBe("applied");
		expect(store.get("op-1")?.attempts).toBe(1);
	});

	test("captures failed applier errors", async () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);

		const result = await reconcilePendingOperations(store, () => {
			throw new Error("OpenWebUI unavailable");
		});

		expect(result.applied).toEqual([]);
		expect(result.failed.map(operation => operation.operationId)).toEqual(["op-1"]);
		expect(store.get("op-1")?.state).toBe("reconcile");
		expect(store.get("op-1")?.attempts).toBe(1);
		expect(store.get("op-1")?.lastError).toBe("OpenWebUI unavailable");
	});

	test("applies reconcile operations", async () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);
		store.markReconcile("op-1");

		const result = await reconcilePendingOperations(store, () => undefined);

		expect(result.applied.map(operation => operation.operationId)).toEqual(["op-1"]);
		expect(store.get("op-1")?.state).toBe("applied");
		expect(store.get("op-1")?.attempts).toBe(1);
	});

	test("recovers applying operations after a crash before applying pending work", async () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);
		store.markApplying("op-1");
		const appliedOperationIds: string[] = [];

		const result = await reconcilePendingOperations(store, operation => {
			appliedOperationIds.push(operation.operationId);
		});

		expect(appliedOperationIds).toEqual(["op-1"]);
		expect(result.applied.map(operation => operation.operationId)).toEqual(["op-1"]);
		expect(store.get("op-1")?.state).toBe("applied");
		expect(store.get("op-1")?.attempts).toBe(2);
	});
});
describe("durable projection reconciliation", () => {
	test("reconstructs exact mapping and event rows from a completed superseded operation", async () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "op-1",
			assistantText: "done",
			modelSelection: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "medium" as const },
			events: [{ type: "tool_start", id: "tool-1" }],
		};
		mappings.set({ ...mapping, operationId: "bootstrap" });
		mappings.beginOperation("chat-1", { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMapping("chat-1", "op-1", "request", mapping, "turn");
		mappings.set({ ...mapping, operationId: "op-2" });
		const outbox = new InMemoryOutboxStore();
		for (const row of expectedProjectionRows(mapping, "user-1")) outbox.enqueue(row);

		const synchronizedProjectIds: string[] = [];
		const result = await reconcilePendingOperations(
			outbox,
			createProjectionOperationApplier(
				mappings,
				{
					syncLinkedProject: async projectId => {
						synchronizedProjectIds.push(projectId);
					},
				},
				"user-1",
			),
		);

		expect(result.failed).toEqual([]);
		expect(result.applied.map(operation => operation.kind)).toEqual(["session_mapping", "event"]);
		expect(synchronizedProjectIds).toEqual(["project-1", "project-1"]);
	});
	test("replays normal-principal rows through a scoped capability", async () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			principalId: "normal-user",
			chatId: "chat-1",
			projectId: "openwebui",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "op-1",
			assistantText: "done",
			events: [{ type: "tool_start", id: "tool-1" }],
		};
		const scope = { principalId: "normal-user", chatId: "chat-1" };
		mappings.setScoped(scope, { ...mapping, operationId: "bootstrap" });
		mappings.beginOperationScoped(scope, { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMappingScoped(scope, "op-1", "request", mapping, "turn");
		const outbox = new InMemoryOutboxStore();
		synthesizeProjectionRows(outbox, mappings, "admin-user", "admin-user");
		const linkedProjectIds: string[] = [];
		const principalRows: string[] = [];
		const result = await reconcilePendingOperations(
			outbox,
			createProjectionOperationApplier(
				mappings,
				{
					syncLinkedProject: async projectId => {
						linkedProjectIds.push(projectId);
					},
					syncPrincipalProjection: async input => {
						principalRows.push(`${input.principalId}:${input.mapping.chatId}`);
					},
				},
				"admin-user",
			),
		);

		expect(result.failed).toEqual([]);
		expect(result.applied.map(operation => operation.kind)).toEqual(["session_mapping", "event"]);
		expect(principalRows).toEqual(["normal-user:chat-1", "normal-user:chat-1"]);
		expect(linkedProjectIds).toEqual([]);
		expect(outbox.listPending()).toEqual([]);
	});
	test("settles admin projection rows for unlinked projects as obsolete", async () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "op-1",
		};
		mappings.set({ ...mapping, operationId: "bootstrap" });
		mappings.beginOperation("chat-1", { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMapping("chat-1", "op-1", "request", mapping, "turn");
		const outbox = new InMemoryOutboxStore();
		synthesizeProjectionRows(outbox, mappings, "user-1", "user-1");

		const result = await reconcilePendingOperations(
			outbox,
			createProjectionOperationApplier(
				mappings,
				{
					syncLinkedProject: async () => {
						throw new Error("Linked project is unavailable for projection: project-1");
					},
				},
				"user-1",
			),
		);

		expect(result.failed).toEqual([]);
		expect(result.applied.map(operation => operation.kind)).toEqual(["session_mapping", "event"]);
		expect(outbox.listPending()).toEqual([]);
	});

	test("settles projection rows whose mapping was retired as obsolete", async () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			principalId: "normal-user",
			chatId: "chat-1",
			projectId: "openwebui",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "op-1",
		};
		const scope = { principalId: "normal-user", chatId: "chat-1" };
		mappings.setScoped(scope, { ...mapping, operationId: "bootstrap" });
		mappings.beginOperationScoped(scope, { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMappingScoped(scope, "op-1", "request", mapping, "turn");
		const outbox = new InMemoryOutboxStore();
		synthesizeProjectionRows(outbox, mappings, "owner-1", "owner-1");
		mappings.retireScoped(scope);

		const result = await reconcilePendingOperations(
			outbox,
			createProjectionOperationApplier(
				mappings,
				{
					syncLinkedProject: async () => {},
					syncPrincipalProjection: async () => {},
				},
				"owner-1",
			),
		);

		expect(result.failed).toEqual([]);
		expect(result.applied.map(operation => operation.kind)).toEqual(["session_mapping", "event"]);
		expect(outbox.listPending()).toEqual([]);
	});
	test("synthesizes missing rows from completed durable mappings", () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "op-1",
		};
		mappings.set({ ...mapping, operationId: "bootstrap" });
		mappings.beginOperation("chat-1", { id: "op-1", kind: "prompt", detail: "request" });
		mappings.completeOperationWithMapping("chat-1", "op-1", "request", mapping, "turn");
		const outbox = new InMemoryOutboxStore();

		synthesizeProjectionRows(outbox, mappings, "user-1", "user-1");
		synthesizeProjectionRows(outbox, mappings, "user-1", "user-1");

		expect(outbox.listPending().map(row => row.operationId)).toEqual(["op-1", "op-1:event"]);
	});
	test("replays completed session state into the OpenWebUI repository", async () => {
		const workspace = await fs.mkdtemp(path.join(tmpdir(), "gjc-outbox-projection-"));
		try {
			const projectDirectory = path.join(workspace, "project");
			const sessionFile = path.join(projectDirectory, ".gjc", "sessions", "session-1.jsonl");
			await fs.mkdir(path.dirname(sessionFile), { recursive: true });
			await writeSessionFile(sessionFile, {
				header: { id: "session-1", title: "Replay", cwd: projectDirectory },
				entries: [messageEntry("message-1", null, "user", "replayed message")],
			});
			const project = await registerProjectDirectory(
				{ cwd: projectDirectory, name: "Replay", sessionRoot: path.dirname(sessionFile) },
				await resolveAllowedRoots([workspace]),
			);
			const mappings = new SessionMappingStore();
			const mapping = {
				chatId: "chat-1",
				projectId: project.id,
				sessionId: "session-1",
				sessionFile,
				rawFrameCursor: 1,
				eventCursor: 1,
				operationId: "op-1",
			};
			mappings.set({ ...mapping, operationId: "bootstrap" });
			mappings.beginOperation("chat-1", { id: "op-1", kind: "prompt", detail: "request" });
			mappings.completeOperationWithMapping("chat-1", "op-1", "request", mapping, "turn");
			const repository = new InMemoryOpenWebUIProjectionRepository();
			const registrationStore = new SqliteProjectRegistrationStore(":memory:");
			registrationStore.linkProject(project, "admin");
			const service = new ProjectLinkService({
				allowedRoots: await resolveAllowedRoots([workspace]),
				store: registrationStore,
				ownerUserId: "user-1",
				repository,
				mappings,
				protectedPaths: ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d"],
			});
			const outbox = new InMemoryOutboxStore();
			synthesizeProjectionRows(outbox, mappings, "user-1", "user-1");

			const result = await reconcilePendingOperations(
				outbox,
				createProjectionOperationApplier(mappings, service, "user-1"),
			);

			expect(result.failed).toEqual([]);
			expect(outbox.listPending()).toEqual([]);
			const chat = await repository.getChat("user-1", "chat-1");
			expect(Object.values(chat?.history.messages ?? {})).toHaveLength(1);
			expect(Object.values(chat?.history.messages ?? {})[0]?.content).toBe("replayed message");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	test("fails closed when a row cannot be reconstructed exactly", async () => {
		const mappings = new SessionMappingStore();
		const mapping = {
			chatId: "chat-1",
			projectId: "project-1",
			sessionId: "session-1",
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "op-1",
		};
		mappings.set(mapping);
		const outbox = new InMemoryOutboxStore();
		const row = expectedProjectionRows(mapping, "user-1")[1]!;
		outbox.enqueue({ ...row, payloadHash: buildProjectionPayloadHash({ tampered: true }) });

		const result = await reconcilePendingOperations(
			outbox,
			createProjectionOperationApplier(
				mappings,
				{
					syncLinkedProject: async () => undefined,
				},
				"user-1",
			),
		);

		expect(result.applied).toEqual([]);
		expect(result.failed.map(operation => operation.operationId)).toEqual(["op-1:event"]);
	});
});
