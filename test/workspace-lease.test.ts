import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceLeaseManager } from "../src/security/workspace-lease";

const SAFE_KEY = "a".repeat(64);

async function createManager(start = 1_000): Promise<{
	manager: WorkspaceLeaseManager;
	getNow: () => number;
	setNow: (value: number) => void;
	stateRoot: string;
}> {
	const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workspace-lease-"));
	let now = start;
	return {
		manager: new WorkspaceLeaseManager({
			stateRoot,
			now: () => now,
			monotonicNow: () => now,
			bootId: () => "test-boot",
		}),
		getNow: () => now,
		setNow: (value: number) => {
			now = value;
		},
		stateRoot,
	};
}

describe("durable workspace leases", () => {
	test("uses a safe lock path outside user workspace roots and private records", async () => {
		const { manager, stateRoot } = await createManager();
		const lockPath = manager.lockPath(SAFE_KEY);
		const userWorkspaceRoot = path.join(stateRoot, "workspaces", SAFE_KEY, "workspace");

		expect(lockPath).toBe(path.join(stateRoot, "locks", "workspaces", `${SAFE_KEY}.lock`));
		expect(path.relative(userWorkspaceRoot, lockPath)).not.toBe("");
		expect(path.relative(lockPath, userWorkspaceRoot)).not.toBe("");

		const lease = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-a",
			operation: "turn",
			leaseMs: 1_000,
		});
		const record = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
		expect(record).toMatchObject({
			schemaVersion: 1,
			generation: 1,
			holderId: "holder-a",
			operation: "turn",
			cleanupPending: false,
			observedAt: 1_000,
		});
		expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
		for (const directory of [stateRoot, path.join(stateRoot, "locks"), path.join(stateRoot, "locks", "workspaces")]) {
			expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		}
		await lease.release();
	});

	test("takes over after expiry with a higher generation and fences stale holders", async () => {
		const { manager, setNow } = await createManager();
		const first = await manager.acquire({ safeKey: SAFE_KEY, holderId: "holder-a", operation: "turn", leaseMs: 100 });
		setNow(1_100);
		const second = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-b",
			operation: "control",
			leaseMs: 100,
		});

		expect(second.generation).toBe(first.generation + 1);
		await expect(manager.assertFence(first)).rejects.toThrow(/stale|expired/i);
		await expect(manager.renew(first, 100)).rejects.toThrow(/stale|expired/i);
		await expect(manager.release(first)).rejects.toThrow(/stale|expired/i);
		await second.release();
	});

	test("renews an active lease but cannot renew after its expiration", async () => {
		const { manager, setNow } = await createManager();
		const lease = await manager.acquire({ safeKey: SAFE_KEY, holderId: "holder-a", operation: "turn", leaseMs: 100 });
		setNow(1_050);
		const renewed = await manager.renew(lease, 200);

		expect(renewed).toBe(lease);
		expect(lease.leaseExpiresAt).toBe(1_250);
		setNow(1_249);
		await expect(manager.assertFence(lease)).resolves.toMatchObject({ generation: lease.generation });
		setNow(1_250);
		await expect(manager.renew(lease, 100)).rejects.toThrow(/expired/i);
	});

	test("does not resurrect an expired lease when its clock moves backward", async () => {
		const { manager, stateRoot, getNow, setNow } = await createManager();
		const lease = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-a",
			operation: "turn",
			leaseMs: 100,
		});

		setNow(1_100);
		await expect(manager.assertFence(lease)).rejects.toThrow(/expired/i);

		setNow(900);
		const restartedManager = new WorkspaceLeaseManager({
			stateRoot,
			now: getNow,
			monotonicNow: () => 1_100,
			bootId: () => "test-boot",
		});
		await expect(restartedManager.assertFence(lease)).rejects.toThrow(/expired/i);
	});
	test("fences an unobserved wall-clock expiry after manager restart with boot monotonic time", async () => {
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-workspace-lease-monotonic-"));
		let wallNow = 1_000;
		let monotonicNow = 1_000;
		const manager = new WorkspaceLeaseManager({
			stateRoot,
			now: () => wallNow,
			monotonicNow: () => monotonicNow,
			bootId: () => "test-boot",
		});
		const lease = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-a",
			operation: "turn",
			leaseMs: 100,
		});

		wallNow = 900;
		monotonicNow = 1_200;
		const restartedManager = new WorkspaceLeaseManager({
			stateRoot,
			now: () => wallNow,
			monotonicNow: () => monotonicNow,
			bootId: () => "test-boot",
		});

		await expect(restartedManager.assertFence(lease)).rejects.toThrow(/expired/i);
		const replacement = await restartedManager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-b",
			operation: "turn",
			leaseMs: 100,
		});
		expect(replacement.generation).toBe(lease.generation + 1);
	});
	test("cleanup-pending denies non-cleanup admission and can be cleared by a fenced holder", async () => {
		const { manager, setNow } = await createManager();
		const holder = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-a",
			operation: "reaper",
			leaseMs: 100,
		});
		await manager.setCleanupPending(holder);
		expect(holder.cleanupPending).toBe(true);
		await expect(
			manager.acquire({ safeKey: SAFE_KEY, holderId: "holder-b", operation: "turn", leaseMs: 100 }),
		).rejects.toThrow(/cleanup.*pending/i);

		setNow(1_100);
		const cleanup = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "cleanup-holder",
			operation: "cleanup",
			leaseMs: 100,
		});
		expect(cleanup.cleanupPending).toBe(true);
		await manager.clearCleanupPending(cleanup);
		expect(cleanup.cleanupPending).toBe(false);
		await cleanup.release();
		const admitted = await manager.acquire({
			safeKey: SAFE_KEY,
			holderId: "holder-c",
			operation: "turn",
			leaseMs: 100,
		});
		expect(admitted.generation).toBe(cleanup.generation + 1);
		await admitted.release();
	});

	test("serializes concurrent admission for one workspace", async () => {
		const { manager } = await createManager();
		const outcomes = await Promise.allSettled([
			manager.acquire({ safeKey: SAFE_KEY, holderId: "holder-a", operation: "turn", leaseMs: 1_000 }),
			manager.acquire({ safeKey: SAFE_KEY, holderId: "holder-b", operation: "turn", leaseMs: 1_000 }),
		]);

		expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
	});
});
