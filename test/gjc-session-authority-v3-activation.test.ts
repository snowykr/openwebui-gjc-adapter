import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSessionAuthorityEpoch } from "../src/gjc/session-authority-epoch";
import {
	activateSessionAuthorityV3,
	type SessionAuthorityV3ActivationBoundary,
} from "../src/gjc/session-authority-v3-activation";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gjc-v3-activation-"));
	const canonicalPath = join(root, "authority.json");
	const original = Buffer.from('{"kind":"openwebui-gjc-session-authority","version":2,"mappings":[]}\n');
	await writeFile(canonicalPath, original);
	return {
		root,
		canonicalPath,
		original,
		activate: (afterBoundary?: (boundary: SessionAuthorityV3ActivationBoundary) => void) =>
			activateSessionAuthorityV3({
				canonicalPath,
				stagingRoot: join(root, "private"),
				bindings: [],
				afterBoundary,
			}),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

describe("session authority V3 activation", () => {
	test("replays a private V2 copy before resolving bindings and leaves the source bytes untouched", async () => {
		const f = await fixture();
		const original = Buffer.from(
			`${JSON.stringify({
				kind: "openwebui-gjc-session-authority",
				version: 2,
				mappings: [
					{
						version: 2,
						chatId: "chat-replayed",
						projectId: "project-replayed",
						sessionId: "session-replayed",
						createdAt: "2026-01-01T00:00:00.000Z",
						header: { chatId: "chat-replayed", projectId: "project-replayed", sessionId: "session-replayed" },
						rawFrameCursor: 0,
						eventCursor: 0,
						operationId: "operation-replayed",
						journal: [],
					},
				],
				provisionalOperations: [],
			})}\n`,
		);
		const wal = Buffer.alloc(0);
		try {
			await writeFile(f.canonicalPath, original);
			await writeFile(`${f.canonicalPath}.wal`, wal);
			let callbackObserved = false;
			const result = await activateSessionAuthorityV3({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: async graph => {
					expect(await readFile(f.canonicalPath)).toEqual(original);
					expect(await readFile(`${f.canonicalPath}.wal`)).toEqual(wal);
					expect(graph.mappings).toHaveLength(1);
					callbackObserved = true;
					return [
						{
							chatId: "chat-replayed",
							projectId: "project-replayed",
							sessionId: "session-replayed",
							managedAuthority: {
								principalId: "principal-replayed",
								projectId: "project-replayed",
								canonicalWorkspace: "/workspace/project-replayed",
								chatId: "chat-replayed",
								sessionId: "session-replayed",
								generation: 1,
								leaseId: "lease-replayed",
								epoch: "managed/1",
								requestKey: "request-replayed",
							},
						},
					];
				},
			});
			expect(callbackObserved).toBe(true);
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const backupRoot = join(
				f.root,
				"private",
				`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
			);
			expect(await readFile(join(backupRoot, "source.v2.json"))).toEqual(original);
			expect(await readFile(join(backupRoot, "source.v2.wal"))).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});

	test("blocks when canonical V2 bytes change during binding resolution", async () => {
		const f = await fixture();
		try {
			const result = await activateSessionAuthorityV3({
				canonicalPath: f.canonicalPath,
				stagingRoot: join(f.root, "private"),
				resolveBindings: async () => {
					await writeFile(f.canonicalPath, Buffer.from('{"kind":"changed"}\n'));
					return [];
				},
			});
			expect(result).toMatchObject({ status: "blocked" });
			if (result.status !== "blocked") throw new Error("Changed source unexpectedly activated.");
			expect(result.reasons?.join(" ")).toContain("changed during private replay");
		} finally {
			await f.cleanup();
		}
	});

	test("snapshots V2 and WAL absence, atomically activates deterministic V3, and binds its marker", async () => {
		const f = await fixture();
		try {
			const result = await f.activate();
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const marker = JSON.parse(await readFile(result.markerPath, "utf8")) as Record<string, unknown>;
			expect(marker).toMatchObject({ activationV3Digest: result.activationV3Digest, authorityEpoch: "managed/1" });
			expect(marker.source).toMatchObject({ baseDigest: digest(f.original), walPresent: false });
			expect(probeSessionAuthorityEpoch(f.canonicalPath)).toEqual({
				status: "v3",
				selection: "managed-store",
			});
			new V3FileBackedSessionMappingStore(f.canonicalPath).close();
		} finally {
			await f.cleanup();
		}
	});

	test("preserves original V2 bytes before swap and restores exact bytes after a swap-window restart", async () => {
		for (const boundary of ["snapshot", "backup", "stage", "swap"] as const) {
			const f = await fixture();
			try {
				await expect(
					f.activate(
						current =>
							current === boundary &&
							(() => {
								throw new Error("crash");
							})(),
					),
				).rejects.toThrow("crash");
				if (boundary !== "swap") expect(await readFile(f.canonicalPath)).toEqual(f.original);
				const activated = await f.activate();
				expect(activated.status).toBe("activated");
			} finally {
				await f.cleanup();
			}
		}
	});

	test("keeps the activation marker valid after an ordinary V3 mapping write and restart", async () => {
		const f = await fixture();
		try {
			const activated = await f.activate();
			if (activated.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const store = new V3FileBackedSessionMappingStore(f.canonicalPath);
			store.set({
				chatId: "chat-1",
				projectId: "project-1",
				sessionId: "session-1",
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "operation-1",
				managedAuthority: {
					principalId: "principal-1",
					projectId: "project-1",
					canonicalWorkspace: "/workspace/project-1",
					chatId: "chat-1",
					sessionId: "session-1",
					generation: 1,
					leaseId: "lease-1",
					epoch: "managed/1",
					requestKey: "request-1",
				},
			});
			store.close();
			expect(probeSessionAuthorityEpoch(f.canonicalPath)).toEqual({ status: "v3", selection: "managed-store" });
			const marker = JSON.parse(await readFile(activated.markerPath, "utf8")) as Record<string, unknown>;
			expect(marker.activationV3Digest).toBe(activated.activationV3Digest);
			const restarted = new V3FileBackedSessionMappingStore(f.canonicalPath);
			expect(restarted.get("chat-1")).toMatchObject({ sessionId: "session-1" });
			restarted.close();
		} finally {
			await f.cleanup();
		}
	});

	test("retains a present WAL in immutable backup and is forward-only after the durable marker", async () => {
		const f = await fixture();
		try {
			const wal = Buffer.alloc(0);
			await writeFile(`${f.canonicalPath}.wal`, wal);
			await expect(
				f.activate(
					boundary =>
						boundary === "marker" &&
						(() => {
							throw new Error("crash");
						})(),
				),
			).rejects.toThrow("crash");
			const restarted = await f.activate();
			expect(restarted.status).toBe("activated");
			const backup = await readFile(
				join(
					f.root,
					"private",
					`session-authority-v3-${digest(Buffer.from(f.canonicalPath)).slice(0, 16)}`,
					"source.v2.wal",
				),
			);
			expect(backup).toEqual(wal);
		} finally {
			await f.cleanup();
		}
	});
});
