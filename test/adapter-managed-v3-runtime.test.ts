import { describe, expect, test } from "bun:test";
import { startActiveManagedRuntime } from "../src/adapter-managed-v3-runtime";
import type { ManagedSdkRuntime, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type { SessionMapping } from "../src/gjc/session-mapping-store";
import type { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

function mapping(overrides: Partial<SessionMapping> = {}): SessionMapping {
	const authority = {
		principalId: "principal-1",
		projectId: "project-1",
		canonicalWorkspace: "/workspace/project-1",
		chatId: "chat-1",
		sessionId: "session-1",
		generation: 7,
		leaseId: "lease-1",
		epoch: "epoch-1",
		requestKey: "request-1",
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	};
	return {
		principalId: authority.principalId,
		chatId: authority.chatId,
		projectId: authority.projectId,
		sessionId: authority.sessionId,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "operation-1",
		managedAuthority: authority,
		...overrides,
	};
}

function store(mappings: readonly SessionMapping[]): SessionV3FileBackedMappingStore {
	return {
		epoch: SESSION_AUTHORITY_V3_EPOCH,
		*mappingRecordsIterable() {
			yield* mappings;
		},
	} as unknown as SessionV3FileBackedMappingStore;
}

function runtime(status: "current" | "replaced" | "unknown" = "current", current = true) {
	const calls: string[] = [];
	const registrations: TenantSessionKey[] = [];
	const attachment = { isCurrent: () => current };
	const fake = {
		async start() {
			calls.push("start");
		},
		registerTenant(key: TenantSessionKey) {
			calls.push(`register:${key.chatId}`);
			registrations.push(key);
		},
		async reconcile() {
			calls.push("reconcile");
		},
		async acquireAttachment(key: TenantSessionKey) {
			calls.push(`acquire:${key.chatId}`);
			return { tenant: key, generation: key.generation, attachment };
		},
		async generationStatus() {
			calls.push("status");
			return { status };
		},
		async dispose() {
			calls.push("dispose");
		},
	};
	return { runtime: fake as unknown as ManagedSdkRuntime, calls, registrations };
}

describe("startActiveManagedRuntime", () => {
	test("starts once and exposes only a reconciled, fenced direct V3 runtime", async () => {
		const fake = runtime();
		const fenceKeys: TenantSessionKey[] = [];
		const options = {
			mappings: store([mapping()]),
			runtime: fake.runtime,
			liveTenantFence: async (key: TenantSessionKey) => {
				fenceKeys.push(key);
				return true;
			},
		};
		const [first, second] = await Promise.all([
			startActiveManagedRuntime(options),
			startActiveManagedRuntime(options),
		]);
		expect(first).toBe(second);
		expect(fake.calls).toEqual(["start", "register:chat-1", "reconcile", "acquire:chat-1", "status"]);
		expect(fenceKeys).toHaveLength(1);
		await first.dispose();
		await first.dispose();
		expect(fake.calls.filter(call => call === "dispose")).toHaveLength(1);
	});

	test("registers and reconciles every distinct tenant before publishing dependencies", async () => {
		const fake = runtime();
		const second = mapping({
			principalId: "principal-2",
			chatId: "chat-2",
			projectId: "project-2",
			sessionId: "session-2",
			managedAuthority: {
				...mapping().managedAuthority!,
				principalId: "principal-2",
				chatId: "chat-2",
				projectId: "project-2",
				sessionId: "session-2",
			},
		});
		const active = await startActiveManagedRuntime({
			mappings: store([mapping(), second]),
			runtime: fake.runtime,
			liveTenantFence: () => true,
		});
		expect(fake.registrations.map(key => key.chatId)).toEqual(["chat-1", "chat-2"]);
		expect(fake.calls.filter(call => call === "reconcile")).toHaveLength(2);
		await active.dispose();
	});

	test.each(["replaced", "unknown"] as const)("fails closed for a %s generation", async status => {
		const fake = runtime(status);
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("requires recovery");
		expect(fake.calls).toContain("dispose");
	});

	test("fails closed for a stale attachment after reconciliation", async () => {
		const fake = runtime("current", false);
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("attachment is stale");
		expect(fake.calls).toContain("dispose");
	});

	test("fails closed when the external live lease/epoch fence is lost", async () => {
		const fake = runtime();
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => false,
			}),
		).rejects.toThrow("fence was lost");
		expect(fake.calls).toContain("dispose");
	});

	test("rejects duplicate canonical mapping identities", async () => {
		const fake = runtime();
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping(), mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("Duplicate or conflicting");
		expect(fake.calls).toContain("dispose");
	});

	test("rejects legacy attachment evidence before it can become a dependency", async () => {
		const fake = runtime();
		await expect(
			startActiveManagedRuntime({
				mappings: store([
					mapping({
						attachment: {
							descriptorPath: "/private/legacy.json",
							descriptorStat: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
							payloadDigest: "digest",
							generation: 7,
							expectedSessionId: "session-1",
							expectedCwd: "/workspace/project-1",
						},
					}),
				]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("legacy attachment");
		expect(fake.calls).toContain("dispose");
	});

	test("disposes the process-owned runtime when a provisional generation cannot be proven current", async () => {
		const fake = runtime("unknown");
		await expect(
			startActiveManagedRuntime({
				mappings: store([mapping()]),
				runtime: fake.runtime,
				liveTenantFence: () => true,
			}),
		).rejects.toThrow("provisional");
		expect(fake.calls.at(-1)).toBe("dispose");
	});
});
