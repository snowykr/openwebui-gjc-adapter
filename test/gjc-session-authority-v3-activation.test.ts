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
	test("snapshots V2 and WAL absence, atomically activates deterministic V3, and binds its marker", async () => {
		const f = await fixture();
		try {
			const result = f.activate();
			expect(result.status).toBe("activated");
			if (result.status !== "activated") throw new Error("Activation was unexpectedly blocked.");
			const marker = JSON.parse(await readFile(result.markerPath, "utf8")) as Record<string, unknown>;
			expect(marker).toMatchObject({ canonicalDigest: result.canonicalDigest, authorityEpoch: "managed/1" });
			expect(marker.source).toMatchObject({ baseDigest: digest(f.original), walPresent: false });
			expect(probeSessionAuthorityEpoch(f.canonicalPath, { managedDigest: result.canonicalDigest })).toEqual({
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
				expect(() =>
					f.activate(
						current =>
							current === boundary &&
							(() => {
								throw new Error("crash");
							})(),
					),
				).toThrow("crash");
				if (boundary !== "swap") expect(await readFile(f.canonicalPath)).toEqual(f.original);
				const activated = f.activate();
				expect(activated.status).toBe("activated");
			} finally {
				await f.cleanup();
			}
		}
	});

	test("retains a present WAL in immutable backup and is forward-only after the durable marker", async () => {
		const f = await fixture();
		try {
			const wal = Buffer.alloc(0);
			await writeFile(`${f.canonicalPath}.wal`, wal);
			expect(() =>
				f.activate(
					boundary =>
						boundary === "marker" &&
						(() => {
							throw new Error("crash");
						})(),
				),
			).toThrow("crash");
			const restarted = f.activate();
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
