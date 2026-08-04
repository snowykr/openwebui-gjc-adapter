import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import { buildProjectionPayloadHash, InMemoryOutboxStore } from "../src/state/outbox";
import { FakeGjcTurnRunner } from "./cli-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

function enqueuePendingOperation(store: InMemoryOutboxStore): void {
	store.enqueue({
		operationId: "projection-op-1",
		ownerUserId: "user-1",
		projectId: "project-1",
		chatId: "chat-1",
		kind: "chat",
		payloadHash: buildProjectionPayloadHash({ chatId: "chat-1", title: "Example" }),
		now: new Date("2026-08-03T00:00:00.000Z"),
	});
}

describe("projection outbox startup reconciliation", () => {
	test("retains a failed projection without taking the adapter offline", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-outbox-startup-"));
		const outbox = new InMemoryOutboxStore();
		enqueuePendingOperation(outbox);
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => errors.push(args.join(" "));
		let options: Awaited<ReturnType<typeof buildAdapterServerOptions>> | undefined;
		try {
			options = await buildAdapterServerOptions(
				{
					mode: "existing",
					bindHost: "127.0.0.1",
					bindPort: 8765,
					openWebUIBaseUrl: "http://127.0.0.1:3000",
					allowedProjectRoots: [],
					projects: [],
					statePath: root,
					sessionRoot: join(root, "sessions"),
					gjcCommand: "/opt/gjc",
					turnTimeoutMs: 240_000,
				},
				{
					outbox,
					turnRunner: new FakeGjcTurnRunner(),
					modelReaderFactory: staticModelReaderFactory(),
					projectionOperationApplier: () => {
						throw new Error("remote projection unavailable");
					},
				},
			);
		} finally {
			console.error = originalError;
			await options?.shutdownCleanup?.();
			await options?.runtimeLock.release();
			await rm(root, { force: true, recursive: true });
		}

		expect(outbox.get("projection-op-1")).toMatchObject({ state: "failed", attempts: 1 });
		expect(errors).toEqual(["Projection outbox reconciliation retained 1 failed operation(s); serving continues."]);
		expect(options?.checks).toContainEqual(
			expect.objectContaining({ name: "openwebui-projection-outbox", status: "degraded" }),
		);
	});
});
