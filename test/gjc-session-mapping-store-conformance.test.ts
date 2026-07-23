import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAuthority } from "../src/gjc/session-authority";
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
			test(createHarness.name, () => {
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
					const displacedOperation = {
						chatId: source.chatId,
						projectId: source.projectId,
						id: "displaced-operation",
						ingressId: "displaced-ingress",
						kind: "create" as const,
						detail: "request",
					};
					harness.store.reserveProvisionalOperation(displacedOperation);
					harness.store.reassignProjectAuthority(source.chatId, source.projectId, "project-2");
					expect(harness.store.get(source.chatId)).toBeUndefined();
					expect(() => harness.store.publishProvisionalOperation(displacedOperation, source)).toThrow(
						"reconciliation",
					);
					expect(() =>
						harness.store.reserveProvisionalOperation({
							...displacedOperation,
							id: "stale-after-reassignment",
							ingressId: "stale-after-reassignment",
						}),
					).toThrow("assigned to another project");
					expect(() => harness.store.upsert(source)).toThrow("assigned to another project");
					harness.store.upsert({
						...source,
						projectId: "project-2",
						sessionId: "session-2",
						operationId: "project-2-operation",
						attachment: {
							...source.attachment!,
							expectedSessionId: "session-2",
						},
					});
					expect(() =>
						harness.store.reserveProvisionalOperation({
							...displacedOperation,
							id: "stale-after-new-publication",
							ingressId: "stale-after-new-publication",
						}),
					).toThrow("assigned to another project");
					expect(() => harness.store.upsert(source)).toThrow("assigned to another project");

					expect(harness.recover().get(source.chatId)).toMatchObject({
						projectId: "project-2",
						sessionId: "session-2",
						operationId: "project-2-operation",
					});
					const recovered = harness.recover();
					expect(recovered.provisionalOperation(source.chatId, displacedOperation.ingressId)).toBeUndefined();
					expect(() => recovered.publishProvisionalOperation(displacedOperation, source)).toThrow(
						"reconciliation",
					);
					expect(() =>
						recovered.reserveProvisionalOperation({
							...displacedOperation,
							id: "stale-after-recovery",
							ingressId: "stale-after-recovery",
						}),
					).toThrow("assigned to another project");
					expect(() => recovered.upsert(source)).toThrow("assigned to another project");
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
