import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionMappingKey, SessionAuthority } from "../src/gjc/session-authority";
import { appendJournal } from "../src/gjc/session-operation-codec";
import { FileBackedSessionMappingStore, type SessionMapping, SessionMappingStore } from "../src/gjc/session-router";

interface StoreHarness {
	readonly name: string;
	readonly store: SessionMappingStore;
	recover(): SessionMappingStore;
	cleanup(): void;
}

const mapping = (): SessionMapping => ({
	chatId: "chat-1",
	projectId: "project-1",
	sessionId: "session-1",
	rawFrameCursor: 1,
	eventCursor: 2,
	operationId: "initial-operation",
	events: [{ type: "assistant", text: "done", payload: { nested: "original" } }],
	attachment: {
		descriptorPath: "/tmp/session.jsonl",
		descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		payloadDigest: "a".repeat(64),
		generation: 4,
		expectedSessionId: "session-1",
		expectedCwd: "/tmp",
	},
});

function memoryHarness(): StoreHarness {
	const authority = new SessionAuthority();
	return {
		name: "memory",
		store: new SessionMappingStore(authority),
		recover: () => {
			authority.reconcileRestart();
			return new SessionMappingStore(authority);
		},
		cleanup: () => {},
	};
}

function fileHarness(): StoreHarness {
	const directory = mkdtempSync(join(tmpdir(), "gjc-mapping-conformance-"));
	const filePath = join(directory, "authority.json");
	return {
		name: "file",
		store: new FileBackedSessionMappingStore(filePath),
		recover: () => new FileBackedSessionMappingStore(filePath),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

describe("session mapping store authority conformance", () => {
	describe("project reassignment", () => {
		for (const createHarness of [memoryHarness, fileHarness]) {
			test(`${createHarness.name} commits only the exact target and retains source operation authority`, () => {
				const harness = createHarness();
				try {
					const source = mapping();
					harness.store.set(source);
					harness.store.beginOperation(source.chatId, {
						id: "completed-operation",
						kind: "prompt",
						detail: "hash",
					});
					harness.store.transitionOperation(source.chatId, "completed-operation", "complete", "hash", {
						kind: "turn",
						assistantText: "done",
						events: [],
						mapping: {
							chatId: source.chatId,
							projectId: source.projectId,
							sessionId: source.sessionId,
							rawFrameCursor: source.rawFrameCursor,
							eventCursor: source.eventCursor,
							operationId: "completed-operation",
						},
					});
					const targetOperation = {
						chatId: source.chatId,
						projectId: "project-2",
						id: "project-2-operation",
						ingressId: "project-2-operation",
						kind: "create" as const,
						detail: "project-2-request",
					};
					harness.store.beginProjectReassignment(source.chatId, source.projectId, "project-2", {
						id: targetOperation.id,
						ingressId: targetOperation.ingressId,
						kind: targetOperation.kind,
						detail: targetOperation.detail,
					});
					expect(harness.store.get(source.chatId)).toMatchObject({
						projectId: source.projectId,
						sessionId: source.sessionId,
					});
					harness.store.reserveProvisionalOperation(targetOperation);
					harness.store.publishProvisionalOperation(targetOperation, {
						...source,
						projectId: "project-2",
						sessionId: "session-2",
						operationId: targetOperation.id,
						attachment: {
							...source.attachment!,
							expectedSessionId: "session-2",
						},
					});

					expect(harness.store.get(source.chatId)).toMatchObject({
						projectId: "project-2",
						sessionId: "session-2",
					});
					expect(() => harness.store.set(harness.store.get(source.chatId)!)).not.toThrow();
					expect(harness.store.operation(source.chatId, "completed-operation")).toMatchObject({
						state: "complete",
						result: { mapping: { projectId: source.projectId } },
					});
					expect(harness.store.operationAuthority(source.chatId, "completed-operation")).toMatchObject({
						projectId: source.projectId,
						retiredAt: expect.any(String),
					});
					expect(() =>
						harness.store.assertOperationProject(source.chatId, "project-2", "completed-operation"),
					).toThrow("not authorized");

					const recovered = harness.recover();
					expect(recovered.get(source.chatId)).toMatchObject({
						projectId: "project-2",
						sessionId: "session-2",
					});
					expect(recovered.operationAuthority(source.chatId, "completed-operation")).toMatchObject({
						projectId: source.projectId,
						retiredAt: expect.any(String),
					});
				} finally {
					harness.cleanup();
				}
			});
			test(`${createHarness.name} retains older source tombstones after retrying a rolled-back reassignment`, () => {
				const harness = createHarness();
				try {
					const source = mapping();
					harness.store.set(source);
					harness.store.beginOperation(source.chatId, {
						id: "operation-a",
						kind: "prompt",
						detail: "source request",
					});
					harness.store.transitionOperation(source.chatId, "operation-a", "complete", "source request", {
						kind: "turn",
						assistantText: "source result",
						events: [],
						mapping: {
							chatId: source.chatId,
							projectId: source.projectId,
							sessionId: source.sessionId,
							rawFrameCursor: source.rawFrameCursor,
							eventCursor: source.eventCursor,
							operationId: "operation-a",
						},
					});

					const targetB = {
						chatId: source.chatId,
						projectId: "project-2",
						id: "operation-b",
						ingressId: "operation-b",
						kind: "create" as const,
						detail: "move to B",
					};
					harness.store.beginProjectReassignment(source.chatId, source.projectId, targetB.projectId, {
						id: targetB.id,
						ingressId: targetB.ingressId,
						kind: targetB.kind,
						detail: targetB.detail,
					});
					harness.store.reserveProvisionalOperation(targetB);
					harness.store.publishProvisionalOperation(targetB, {
						...source,
						projectId: targetB.projectId,
						sessionId: "session-b",
						operationId: targetB.id,
						attachment: {
							...source.attachment!,
							expectedSessionId: "session-b",
						},
					});

					harness.store.beginProjectReassignment(source.chatId, targetB.projectId, "project-3");
					harness.store.rollbackProjectReassignment(source.chatId, targetB.projectId);
					expect(harness.store.operationAuthority(source.chatId, "operation-a")).toMatchObject({
						projectId: source.projectId,
						retiredAt: expect.any(String),
					});
					expect(() =>
						harness.store.set({
							...harness.store.get(source.chatId)!,
							operationId: "project-2-follow-up",
						}),
					).not.toThrow();

					const targetC = {
						chatId: source.chatId,
						projectId: "project-3",
						id: "operation-c",
						ingressId: "operation-c",
						kind: "create" as const,
						detail: "retry move to C",
					};
					harness.store.beginProjectReassignment(source.chatId, targetB.projectId, targetC.projectId, {
						id: targetC.id,
						ingressId: targetC.ingressId,
						kind: targetC.kind,
						detail: targetC.detail,
					});
					harness.store.reserveProvisionalOperation(targetC);
					harness.store.publishProvisionalOperation(targetC, {
						...source,
						projectId: targetC.projectId,
						sessionId: "session-c",
						operationId: targetC.id,
						attachment: {
							...source.attachment!,
							expectedSessionId: "session-c",
						},
					});

					expect(harness.store.operationAuthority(source.chatId, "operation-a")).toMatchObject({
						projectId: source.projectId,
						retiredAt: expect.any(String),
					});
					expect(harness.recover().operationAuthority(source.chatId, "operation-a")).toMatchObject({
						projectId: source.projectId,
						retiredAt: expect.any(String),
					});
				} finally {
					harness.cleanup();
				}
			});

			test(`${createHarness.name} rejects reassignment while a source operation is in flight`, () => {
				const harness = createHarness();
				try {
					const source = mapping();
					harness.store.set(source);
					harness.store.beginOperation(source.chatId, {
						id: "in-flight-source-operation",
						kind: "prompt",
						detail: "source request",
					});
					expect(() =>
						harness.store.beginProjectReassignment(source.chatId, source.projectId, "project-2"),
					).toThrow("in-flight-source-operation requires reconciliation");
				} finally {
					harness.cleanup();
				}
			});
			test(`${createHarness.name} rejects a source operation after reassignment begins`, () => {
				const harness = createHarness();
				try {
					const source = mapping();
					harness.store.set(source);
					harness.store.beginProjectReassignment(source.chatId, source.projectId, "project-2");
					expect(() =>
						harness.store.beginOperation(source.chatId, {
							id: "late-source-operation",
							kind: "prompt",
							detail: "source request",
						}),
					).toThrow("pending project reassignment");
				} finally {
					harness.cleanup();
				}
			});
			test(`${createHarness.name} rolls an interrupted target back without deleting source authority`, () => {
				const harness = createHarness();
				try {
					const source = mapping();
					const targetOperation = {
						chatId: source.chatId,
						projectId: "project-2",
						id: "project-2-operation",
						ingressId: "project-2-operation",
						kind: "create" as const,
						detail: "project-2-request",
					};
					harness.store.set(source);
					harness.store.beginProjectReassignment(source.chatId, source.projectId, "project-2");
					harness.store.reserveProvisionalOperation(targetOperation);

					const recovered = harness.recover();
					expect(recovered.get(source.chatId)).toMatchObject({
						projectId: source.projectId,
						sessionId: source.sessionId,
					});
					expect(recovered.provisionalOperation(source.chatId, targetOperation.ingressId)).toMatchObject({
						projectId: "project-2",
						state: "uncertain",
					});
					expect(() =>
						recovered.publishProvisionalOperation(targetOperation, {
							...source,
							projectId: "project-2",
							sessionId: "session-2",
							operationId: targetOperation.id,
						}),
					).toThrow();
				} finally {
					harness.cleanup();
				}
			});
		}
	});
	for (const createHarness of [memoryHarness, fileHarness]) {
		test(createHarness.name, () => {
			const harness = createHarness();
			try {
				const source = mapping();
				harness.store.set(source);
				(source.events?.[0]?.payload as { nested: string }).nested = "mutated-source";
				(source.attachment!.descriptorStat as { size: number }).size = 99;
				expect(harness.store.get("chat-1")).toMatchObject({
					events: [{ payload: { nested: "original" } }],
					attachment: { descriptorStat: { size: 3 } },
				});

				const read = harness.store.get("chat-1")!;
				(read.events?.[0]?.payload as { nested: string }).nested = "mutated-read";
				(read.attachment!.descriptorStat as { size: number }).size = 98;
				expect(harness.store.get("chat-1")).toMatchObject({
					events: [{ payload: { nested: "original" } }],
					attachment: { descriptorStat: { size: 3 } },
				});

				expect(() => harness.store.transitionOperation("missing", "operation", "complete")).toThrow(
					"Unknown session authority",
				);
				harness.store.beginOperation("chat-1", { id: "operation-1", kind: "create", detail: "hash" });
				harness.store.beginOperation("chat-1", { id: "operation-1", kind: "create", detail: "hash" });
				expect(() =>
					harness.store.beginOperation("chat-1", { id: "operation-1", kind: "close", detail: "hash" }),
				).toThrow("conflicts");
				harness.store.beginOperation("chat-1", {
					id: "id-before-ingress",
					ingressId: "ingress-after-id",
					kind: "prompt",
				});
				expect(() =>
					harness.store.beginOperation("chat-1", {
						id: "ingress-after-id",
						ingressId: "unrelated-ingress",
						kind: "prompt",
					}),
				).toThrow("conflicts");
				harness.store.beginOperation("chat-1", {
					id: "id-after-ingress",
					ingressId: "ingress-before-id",
					kind: "prompt",
				});
				expect(() =>
					harness.store.beginOperation("chat-1", {
						id: "unrelated-id",
						ingressId: "id-after-ingress",
						kind: "prompt",
					}),
				).toThrow("conflicts");
				for (const operation of [
					{ id: "other-journal-id", ingressId: "ingress-after-id" },
					{ id: "id-before-ingress", ingressId: "other-journal-ingress" },
				])
					expect(() =>
						harness.store.reserveProvisionalOperation({
							chatId: "chat-1",
							projectId: "project-1",
							kind: "create",
							detail: "request",
							...operation,
						}),
					).toThrow("conflicts");
				harness.store.reserveProvisionalOperation({
					chatId: "chat-1",
					projectId: "project-1",
					id: "provisional-1",
					ingressId: "ingress-1",
					kind: "create",
					detail: "request",
				});
				expect(() =>
					harness.store.reserveProvisionalOperation({
						chatId: "chat-1",
						projectId: "project-1",
						id: "provisional-1",
						ingressId: "ingress-1",
						kind: "create",
						detail: "different-request",
					}),
				).toThrow("conflicts");
				for (const operation of [
					{ id: "other-provisional-id", ingressId: "provisional-1" },
					{ id: "provisional-1", ingressId: "other-provisional-ingress" },
				]) {
					expect(() =>
						harness.store.reserveProvisionalOperation({
							chatId: "chat-1",
							projectId: "project-1",
							kind: "create",
							detail: "request",
							...operation,
						}),
					).toThrow("conflicts");
					expect(() => harness.store.beginOperation("chat-1", { ...operation, kind: "prompt" })).toThrow(
						"conflicts",
					);
				}
				harness.store.reserveProvisionalOperation({
					chatId: "chat-1",
					projectId: "project-1",
					id: "publish-id",
					ingressId: "publish-ingress",
					kind: "create",
					detail: "request",
				});
				for (const operation of [
					{ id: "provisional-1", ingressId: "publish-ingress", chatId: "chat-1", projectId: "project-1" },
					{ id: "publish-id", ingressId: "provisional-1", chatId: "chat-1", projectId: "project-1" },
				])
					expect(() =>
						harness.store.publishProvisionalOperation(
							{ ...operation, kind: "create", detail: "request" },
							source,
						),
					).toThrow("reconciliation");

				const recovered = harness.recover();
				expect(recovered.operation("chat-1", "operation-1")).toMatchObject({ state: "uncertain" });
				expect(recovered.provisionalOperation("chat-1", "ingress-1")).toMatchObject({ state: "uncertain" });
			} finally {
				harness.cleanup();
			}
		});
	}
});
test("file rejects an invalid retained prior tombstone during a pending reassignment", () => {
	const directory = mkdtempSync(join(tmpdir(), "gjc-mapping-prior-tombstone-"));
	const filePath = join(directory, "authority.json");
	try {
		const store = new FileBackedSessionMappingStore(filePath);
		const source = mapping();
		const target = {
			chatId: source.chatId,
			projectId: "project-2",
			id: "operation-b",
			ingressId: "operation-b",
			kind: "create" as const,
			detail: "move to B",
		};
		store.set(source);
		store.beginProjectReassignment(source.chatId, source.projectId, target.projectId, {
			id: target.id,
			ingressId: target.ingressId,
			kind: target.kind,
			detail: target.detail,
		});
		store.reserveProvisionalOperation(target);
		store.publishProvisionalOperation(target, {
			...source,
			projectId: target.projectId,
			sessionId: "session-b",
			operationId: target.id,
			attachment: { ...source.attachment!, expectedSessionId: "session-b" },
		});
		store.beginProjectReassignment(source.chatId, target.projectId, "project-3");

		const document = JSON.parse(readFileSync(filePath, "utf8"));
		document.mappings[0].reassignment.priorTombstone.chatId = "other-chat";
		writeFileSync(filePath, JSON.stringify(document));

		expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
test("file accepts reassignment back to a prior project", () => {
	const directory = mkdtempSync(join(tmpdir(), "gjc-mapping-return-project-"));
	const filePath = join(directory, "authority.json");
	try {
		const store = new FileBackedSessionMappingStore(filePath);
		const source = mapping();
		const move = (projectId: string, id: string, sessionId: string) => {
			const target = {
				chatId: source.chatId,
				projectId,
				id,
				ingressId: id,
				kind: "create" as const,
				detail: `move to ${projectId}`,
			};
			const active = store.get(source.chatId)!;
			store.beginProjectReassignment(source.chatId, active.projectId, target.projectId, {
				id: target.id,
				ingressId: target.ingressId,
				kind: target.kind,
				detail: target.detail,
			});
			store.reserveProvisionalOperation(target);
			store.publishProvisionalOperation(target, {
				...active,
				projectId: target.projectId,
				sessionId,
				operationId: target.id,
				attachment: { ...active.attachment!, expectedSessionId: sessionId },
			});
		};

		store.set(source);
		move("project-2", "operation-b", "session-b");
		move(source.projectId, "operation-return", "session-return");

		expect(store.get(source.chatId)).toMatchObject({
			projectId: source.projectId,
			sessionId: "session-return",
		});
		expect(new FileBackedSessionMappingStore(filePath).get(source.chatId)).toMatchObject({
			projectId: source.projectId,
			sessionId: "session-return",
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
test("file rejects persisted journal/provisional cross-field collisions in either order", () => {
	for (const operation of [
		{ id: "other-provisional-id", ingressId: "initial-operation" },
		{ id: "initial-operation", ingressId: "other-provisional-ingress" },
	]) {
		const directory = mkdtempSync(join(tmpdir(), "gjc-mapping-identity-"));
		const filePath = join(directory, "authority.json");
		try {
			const store = new FileBackedSessionMappingStore(filePath);
			store.set(mapping());
			const document = JSON.parse(readFileSync(filePath, "utf8"));
			document.provisionalOperations = [
				{
					...operation,
					kind: "create",
					state: "pending",
					startedAt: "2026-01-01T00:00:00.000Z",
					chatId: "chat-1",
					projectId: "project-1",
				},
			];
			writeFileSync(filePath, JSON.stringify(document));
			expect(() => new FileBackedSessionMappingStore(filePath)).toThrow("not a valid v2 authority");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
test("journal merge rejects cross-field collisions in either order", () => {
	const operation = {
		id: "operation-id",
		ingressId: "ingress-id",
		kind: "prompt" as const,
		state: "pending" as const,
		startedAt: "2026-01-01T00:00:00.000Z",
	};
	expect(() => appendJournal([operation], [{ ...operation, id: "ingress-id", ingressId: "other-ingress" }])).toThrow(
		"conflicts",
	);
	expect(() => appendJournal([operation], [{ ...operation, id: "other-id", ingressId: "operation-id" }])).toThrow(
		"conflicts",
	);
});
test("canonical session mapping keys preserve tuple boundaries", () => {
	expect(canonicalSessionMappingKey("principal|one", "chat")).not.toBe(
		canonicalSessionMappingKey("principal", "one|chat"),
	);
	expect(() => canonicalSessionMappingKey("", "chat")).toThrow("non-empty principal ID");
});

test("memory scoped mappings isolate same-chat principals and operations", () => {
	const store = new SessionMappingStore();
	const alice = { principalId: "alice", chatId: "shared-chat" };
	const bob = { principalId: "bob", chatId: "shared-chat" };
	const aliceMapping = {
		...mapping(),
		...alice,
		sessionId: "alice-session",
		operationId: "alice-initial",
	};
	const bobMapping = {
		...mapping(),
		...bob,
		sessionId: "bob-session",
		operationId: "bob-initial",
	};

	expect(store.setScoped(alice, aliceMapping)).toMatchObject(alice);
	expect(store.setScoped(bob, bobMapping)).toMatchObject(bob);
	expect(store.getScoped(alice)).toMatchObject({
		principalId: "alice",
		chatId: "shared-chat",
		sessionId: "alice-session",
	});
	expect(store.getScoped(bob)).toMatchObject({
		principalId: "bob",
		chatId: "shared-chat",
		sessionId: "bob-session",
	});
	expect(store.get("shared-chat")).toBeUndefined();

	store.beginOperationScoped(alice, { id: "same-operation", kind: "prompt", detail: "alice" });
	store.beginOperationScoped(bob, { id: "same-operation", kind: "prompt", detail: "bob" });
	expect(store.operationScoped(alice, "same-operation")).toMatchObject({
		id: "same-operation",
		detail: "alice",
	});
	expect(store.operationScoped(bob, "same-operation")).toMatchObject({
		id: "same-operation",
		detail: "bob",
	});
	expect(store.operationsScoped(alice).some(operation => operation.detail === "alice")).toBe(true);
	expect(store.operationsScoped(bob).some(operation => operation.detail === "bob")).toBe(true);
});
test("scoped cleanup enumerates and retires only the requested principal", () => {
	for (const createHarness of [memoryHarness, fileHarness]) {
		const harness = createHarness();
		try {
			const alice = { principalId: "alice", chatId: "shared-chat" };
			const bob = { principalId: "bob", chatId: "shared-chat" };
			harness.store.setScoped(alice, {
				...mapping(),
				...alice,
				operationId: "initial-operation",
			});
			harness.store.setScoped(bob, {
				...mapping(),
				...bob,
				operationId: "initial-operation",
			});
			expect(harness.store.entriesForPrincipal("alice")).toHaveLength(1);
			expect(harness.store.entriesForPrincipal("bob")).toHaveLength(1);
			harness.store.retireScoped(alice);
			expect(harness.store.getScoped(alice)).toBeUndefined();
			expect(harness.store.entriesForPrincipal("alice")).toEqual([]);
			expect(harness.store.operationsScoped(alice)).toEqual([]);
			expect(harness.store.operationScoped(alice, "initial-operation")).toBeUndefined();
			expect(harness.store.getScoped(bob)).toMatchObject({ sessionId: "session-1" });
			expect(harness.store.entriesForPrincipal("bob")).toHaveLength(1);
			expect(() => harness.store.retireScoped(alice)).toThrow("already retired");
			expect(() =>
				harness.store.setScoped(alice, {
					...mapping(),
					...alice,
					sessionId: "alice-resumed",
					operationId: "alice-resumed",
				}),
			).toThrow("cannot be mutated");

			const recovered = harness.recover();
			expect(recovered.getScoped(alice)).toBeUndefined();
			expect(recovered.operationScoped(alice, "initial-operation")).toBeUndefined();
			expect(recovered.getScoped(bob)).toMatchObject({ sessionId: "session-1" });
		} finally {
			harness.cleanup();
		}
	}
});
test("principal enumeration isolates normal mappings and opts into legacy admin records", () => {
	for (const createHarness of [memoryHarness, fileHarness]) {
		const harness = createHarness();
		try {
			const projectId = "shared-project";
			const adminScope = { principalId: "admin", chatId: "admin-scoped" };
			const userScope = { principalId: "user", chatId: "user-scoped" };
			harness.store.setScoped(adminScope, {
				...mapping(),
				...adminScope,
				projectId,
				operationId: "admin-scoped-operation",
			});
			harness.store.setScoped(userScope, {
				...mapping(),
				...userScope,
				projectId,
				operationId: "user-scoped-operation",
			});
			harness.store.set({
				...mapping(),
				chatId: "admin-legacy",
				principalId: "admin",
				projectId,
				operationId: "admin-legacy-operation",
			});
			harness.store.set({
				...mapping(),
				chatId: "user-legacy",
				principalId: "user",
				projectId,
				operationId: "user-legacy-operation",
			});
			harness.store.set({
				...mapping(),
				chatId: "legacy-unscoped",
				projectId,
				operationId: "legacy-unscoped-operation",
			});

			expect(harness.store.entriesForPrincipal("admin").map(entry => entry.chatId)).toEqual(["admin-scoped"]);
			expect(
				harness.store.entriesForPrincipal("admin", { includeLegacyAdmin: true }).map(entry => entry.chatId),
			).toEqual(["admin-scoped", "admin-legacy", "legacy-unscoped"]);
			expect(harness.store.entriesForPrincipal("user").map(entry => entry.chatId)).toEqual(["user-scoped"]);

			const recovered = harness.recover();
			expect(
				recovered.entriesForPrincipal("admin", { includeLegacyAdmin: true }).map(entry => entry.chatId),
			).toEqual(["admin-scoped", "admin-legacy", "legacy-unscoped"]);
			expect(
				recovered
					.entriesForPrincipal("admin", { includeLegacyAdmin: true })
					.every(entry => entry.projectId === projectId),
			).toBe(true);
		} finally {
			harness.cleanup();
		}
	}
});
test("scoped lookups fall back to legacy mappings only for the configured admin", () => {
	for (const createHarness of [memoryHarness, fileHarness]) {
		const harness = createHarness();
		try {
			harness.store.set({
				...mapping(),
				chatId: "legacy-admin-chat",
				operationId: "legacy-admin-operation",
			});
			harness.store.setLegacyAdminPrincipalId("admin-1");

			expect(harness.store.getScoped({ principalId: "admin-1", chatId: "legacy-admin-chat" })).toMatchObject({
				chatId: "legacy-admin-chat",
				principalId: "admin-1",
				operationId: "legacy-admin-operation",
			});
			expect(harness.store.getScoped({ principalId: "normal-1", chatId: "legacy-admin-chat" })).toBeUndefined();

			harness.store.upsertScoped(
				{ principalId: "admin-1", chatId: "legacy-admin-chat" },
				{ ...mapping(), chatId: "legacy-admin-chat", operationId: "admin-scoped-operation" },
			);
			expect(harness.store.getScoped({ principalId: "admin-1", chatId: "legacy-admin-chat" })).toMatchObject({
				operationId: "admin-scoped-operation",
			});
		} finally {
			harness.cleanup();
		}
	}
});
