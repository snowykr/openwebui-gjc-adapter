import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import { SessionMappingStore } from "../src/gjc/session-router";
import { synthesizeProjectionRows } from "../src/live/workflow-gate-projection";
import {
	buildProjectionPayloadHash,
	FileBackedOutboxStore,
	InMemoryOutboxStore,
	type OutboxStore,
} from "../src/state/outbox";
import { FakeManagedSdkRuntime, writeDirectV3Authority } from "./cli-fixtures";

function managedRuntimeFixture() {
	const accounting = new FakeManagedSdkRuntime();
	let state: "new" | "running" | "stopped" = "new";
	let starts = 0;
	let disposes = 0;
	const registrations = new Map<string, Record<string, unknown>>();
	const tenantKey = (tenant: Record<string, unknown>) =>
		JSON.stringify([
			tenant.principalId,
			tenant.projectId,
			tenant.canonicalWorkspace,
			tenant.chatId,
			tenant.sessionId,
			tenant.generation,
			tenant.leaseId,
			tenant.epoch,
		]);
	const runtime = {
		createProducerScope: () => accounting.createProducerScope(),
		get state() {
			return state;
		},
		async start() {
			starts += 1;
			state = "running";
		},
		async dispose() {
			disposes += 1;
			state = "stopped";
		},
		async reconcile() {},
		registerTenant(tenant: Record<string, unknown>) {
			registrations.set(tenantKey(tenant), tenant);
		},
		async acquireAttachment(tenant: Record<string, unknown>) {
			const key = tenantKey(tenant);
			if (!registrations.has(key)) throw new Error("Managed fixture tenant is not registered.");
			return {
				tenant,
				generation: tenant.generation,
				isCurrent: () => state === "running" && registrations.has(key),
			};
		},
		async generationStatus() {
			return { status: "current" as const };
		},
		async request() {
			return { ok: true };
		},
		subscribeFrames() {
			return () => undefined;
		},
		async createLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.create" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
		async resumeLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.resume" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
		async closeLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.close" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
		async deleteLifecycleSession(tenant: Record<string, unknown>) {
			return {
				ok: true as const,
				operation: "session.delete" as const,
				result: { sessionId: tenant.sessionId ?? "managed-session", endpointGeneration: tenant.generation ?? 1 },
			};
		},
	};
	return {
		runtime: runtime as never,
		get starts() {
			return starts;
		},
		get disposes() {
			return disposes;
		},
	};
}

function legacyAuthorityJson(): string {
	const timestamp = "2026-08-03T00:00:00.000Z";
	const chatId = "chat-1";
	const events = [{ type: "assistant" as const, text: "legacy event", payload: { transcript: "legacy" } }];
	const mapping = {
		version: 2,
		chatId,
		projectId: "project-1",
		sessionId: "session-1",
		createdAt: timestamp,
		header: { chatId, projectId: "project-1", sessionId: "session-1" },
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "operation-1",
		assistantText: "done",
		events: [],
		journal: [
			{
				id: "operation-1",
				kind: "prompt",
				state: "complete",
				startedAt: timestamp,
				completedAt: timestamp,
				result: {
					kind: "turn",
					assistantText: "done",
					events,
					mapping: {
						chatId,
						projectId: "project-1",
						sessionId: "session-1",
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: "operation-1",
					},
				},
			},
		],
	};
	return JSON.stringify({
		kind: "openwebui-gjc-session-authority",
		version: 2,
		mappings: [mapping],
		provisionalOperations: [],
	});
}
function enqueuePendingOperation(store: OutboxStore): void {
	store.enqueue({
		operationId: "projection-op-1",
		principalId: "user-1",
		ownerUserId: "user-1",
		projectId: "project-1",
		chatId: "chat-1",
		kind: "chat",
		payloadHash: buildProjectionPayloadHash({ chatId: "chat-1", title: "Example" }),
		now: new Date("2026-08-03T00:00:00.000Z"),
	});
}

describe("projection outbox startup reconciliation", () => {
	test("retains a failed projection as retryable without taking the adapter offline", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-outbox-startup-"));
		const outbox = new InMemoryOutboxStore();
		enqueuePendingOperation(outbox);
		await writeDirectV3Authority(join(root, "sessions"));
		const managedSdkRuntime = managedRuntimeFixture();
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
					managedSdkRuntime: managedSdkRuntime.runtime,
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

		expect(outbox.get({ principalId: "user-1", chatId: "chat-1", operationId: "projection-op-1" })).toMatchObject({
			principalId: "user-1",
			state: "reconcile",
			attempts: 1,
		});
		expect(errors).toEqual(["Projection outbox reconciliation retained 1 failed operation(s); serving continues."]);
		expect(options?.checks).toContainEqual(
			expect.objectContaining({ name: "openwebui-projection-outbox", status: "degraded" }),
		);
	});
	test("retries a failed projection after a healthy restart exactly once", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-outbox-retry-"));
		const outboxPath = join(root, "projection-outbox.json");
		const persisted = new FileBackedOutboxStore(outboxPath);
		enqueuePendingOperation(persisted);
		await writeDirectV3Authority(join(root, "sessions"));
		const failedRuntime = managedRuntimeFixture();
		const healthyRuntime = managedRuntimeFixture();
		const config = {
			mode: "existing" as const,
			bindHost: "127.0.0.1",
			bindPort: 8765,
			openWebUIBaseUrl: "http://127.0.0.1:3000",
			allowedProjectRoots: [],
			projects: [],
			statePath: root,
			sessionRoot: join(root, "sessions"),
			gjcCommand: "/opt/gjc",
			turnTimeoutMs: 240_000,
		};
		let failedOptions: Awaited<ReturnType<typeof buildAdapterServerOptions>> | undefined;
		try {
			failedOptions = await buildAdapterServerOptions(config, {
				outbox: new FileBackedOutboxStore(outboxPath),
				managedSdkRuntime: failedRuntime.runtime,
				projectionOperationApplier: () => {
					throw new Error("temporary projection outage");
				},
			});
		} finally {
			await failedOptions?.shutdownCleanup?.();
			await failedOptions?.runtimeLock.release();
		}
		expect(new FileBackedOutboxStore(outboxPath).get("projection-op-1")).toMatchObject({
			operationId: "projection-op-1",
			state: "reconcile",
			attempts: 1,
			lastError: "temporary projection outage",
		});

		const replayed: string[] = [];
		let healthyOptions: Awaited<ReturnType<typeof buildAdapterServerOptions>> | undefined;
		try {
			healthyOptions = await buildAdapterServerOptions(config, {
				outbox: new FileBackedOutboxStore(outboxPath),
				managedSdkRuntime: healthyRuntime.runtime,
				projectionOperationApplier: operation => {
					replayed.push(operation.operationId);
				},
			});
		} finally {
			await healthyOptions?.shutdownCleanup?.();
			await healthyOptions?.runtimeLock.release();
		}

		expect(replayed).toEqual(["projection-op-1"]);
		expect(new FileBackedOutboxStore(outboxPath).get("projection-op-1")).toMatchObject({
			operationId: "projection-op-1",
			state: "applied",
			attempts: 2,
		});
		await rm(root, { force: true, recursive: true });
	});
	test("rejects a V2 authority without migration or compaction side effects", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-authority-v2-rejection-"));
		const authorityPath = join(root, "sessions", "openwebui-session-mappings.json");
		await mkdir(join(root, "sessions"), { recursive: true });
		await writeFile(authorityPath, legacyAuthorityJson());
		const before = await Bun.file(authorityPath).text();
		try {
			await expect(
				buildAdapterServerOptions({
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
				}),
			).rejects.toThrow("Canonical session authority activation is blocked.");
			expect(await Bun.file(authorityPath).text()).toBe(before);
			expect(await Bun.file(join(root, "state")).exists()).toBe(false);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
	test("skips unsupported normal-principal projection rows instead of retrying them forever", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-outbox-normal-skip-"));
		try {
			await writeDirectV3Authority(join(root, "sessions"));
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
			};
			const scope = { principalId: "normal-user", chatId: "chat-1" };
			mappings.setScoped(scope, { ...mapping, operationId: "bootstrap" });
			mappings.beginOperationScoped(scope, { id: "op-1", kind: "prompt", detail: "request" });
			mappings.completeOperationWithMappingScoped(scope, "op-1", "request", mapping, "turn");
			const outbox = new InMemoryOutboxStore();
			synthesizeProjectionRows(outbox, mappings, "owner-1", "owner-1");

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
						openWebUIApiToken: "token",
						ownerUserId: "owner-1",
						allowedProjectRoots: [],
						projects: [],
						statePath: root,
						sessionRoot: join(root, "sessions"),
						gjcCommand: "/opt/gjc",
						turnTimeoutMs: 240_000,
					},
					{
						outbox,
						managedSdkRuntime: managedRuntimeFixture().runtime,
					},
					{ deferOpenWebUIInitialization: true },
				);
			} finally {
				console.error = originalError;
				await options?.shutdownCleanup?.();
				await options?.runtimeLock.release();
			}

			expect(outbox.get({ principalId: "normal-user", chatId: "chat-1", operationId: "op-1" })).toMatchObject({
				state: "applied",
			});
			expect(outbox.get({ principalId: "normal-user", chatId: "chat-1", operationId: "op-1:event" })).toMatchObject({
				state: "applied",
			});
			expect(errors).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
