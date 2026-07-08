import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
	buildProjectionPayloadHash,
	FileBackedOutboxStore,
	InMemoryOutboxStore,
	type OutboxStore,
} from "../src/state/outbox";
import { reconcilePendingOperations } from "../src/state/reconciler";

const createdAt = new Date("2026-07-08T00:00:00.000Z");

function enqueueChatOperation(store: OutboxStore, operationId = "op-1"): void {
	store.enqueue({
		operationId,
		ownerUserId: "user-1",
		projectId: "project-1",
		chatId: "chat-1",
		kind: "chat",
		payloadHash: buildProjectionPayloadHash({ chatId: "chat-1", title: "Example" }),
		now: createdAt,
	});
}

describe("InMemoryOutboxStore", () => {
	test("returns an existing operation when enqueue is retried with the same id", () => {
		const store = new InMemoryOutboxStore();
		enqueueChatOperation(store);

		const retried = store.enqueue({
			operationId: "op-1",
			ownerUserId: "user-1",
			projectId: "project-1",
			chatId: "chat-1",
			kind: "chat",
			payloadHash: buildProjectionPayloadHash({ title: "Different" }),
			now: new Date("2026-07-08T00:01:00.000Z"),
		});

		expect(retried.payloadHash).toBe(buildProjectionPayloadHash({ chatId: "chat-1", title: "Example" }));
		expect(retried.attempts).toBe(0);
		expect(store.listPending()).toHaveLength(1);
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
		expect(store.get("op-1")?.state).toBe("failed");
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
