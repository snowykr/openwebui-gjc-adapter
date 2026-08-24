import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeSessionAuthorityEpoch, selectSessionAuthorityStore } from "../src/gjc/session-authority-epoch";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";

const digestOf = (value: string) => createHash("sha256").update(value).digest("hex");
function v3(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		kind: "openwebui-gjc-session-authority",
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		mappings: [],
		provisionalOperations: [],
		...overrides,
	});
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "gjc-authority-epoch-"));
	const authority = join(root, "authority.json");
	return { root, authority, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("session authority epoch probe", () => {
	test("selects managed bootstrap for absent and v2 sources", async () => {
		const f = await fixture();
		try {
			expect(probeSessionAuthorityEpoch(f.authority)).toEqual({ status: "absent", selection: "managed-bootstrap" });
			await writeFile(f.authority, '{"kind":"openwebui-gjc-session-authority","version":2,"records":[]}');
			expect(probeSessionAuthorityEpoch(f.authority)).toEqual({ status: "v2", selection: "managed-bootstrap" });
		} finally {
			await f.cleanup();
		}
	});

	test("selects the managed store only for the exact trusted full-graph v3 bytes", async () => {
		const f = await fixture();
		try {
			const bytes = v3();
			await writeFile(f.authority, bytes);
			const probe = probeSessionAuthorityEpoch(f.authority, { managedDigest: digestOf(bytes) });
			expect(probe).toEqual({ status: "v3", selection: "managed-store" });
			expect(selectSessionAuthorityStore(probe)).toBe("managed-store");
			expect(probeSessionAuthorityEpoch(f.authority)).toEqual({ status: "blocked", selection: "blocked" });
			expect(probeSessionAuthorityEpoch(f.authority, { managedDigest: "0".repeat(64) })).toEqual({
				status: "blocked",
				selection: "blocked",
			});
		} finally {
			await f.cleanup();
		}
	});

	test("blocks malformed, unknown, invalid-v3, symlink, nonregular, and oversized authority paths", async () => {
		const f = await fixture();
		try {
			for (const bytes of [
				"not json",
				'{"kind":"other","version":2}',
				v3({ authorityEpoch: "wrong" }),
				v3({ mappings: "invalid" }),
			]) {
				await writeFile(f.authority, bytes);
				expect(probeSessionAuthorityEpoch(f.authority, { managedDigest: digestOf(bytes) })).toEqual({
					status: "blocked",
					selection: "blocked",
				});
			}
			await rm(f.authority);
			await symlink("/dev/null", f.authority);
			expect(probeSessionAuthorityEpoch(f.authority)).toEqual({ status: "blocked", selection: "blocked" });
			await rm(f.authority);
			await mkdir(f.authority);
			expect(probeSessionAuthorityEpoch(f.authority)).toEqual({ status: "blocked", selection: "blocked" });
			await rm(f.authority, { recursive: true });
			await writeFile(f.authority, Buffer.alloc(16 * 1024 * 1024 + 1));
			expect(probeSessionAuthorityEpoch(f.authority, { managedDigest: "0".repeat(64) })).toEqual({
				status: "blocked",
				selection: "blocked",
			});
		} finally {
			await f.cleanup();
		}
	});

	test("does not follow a replacement after the named authority is replaced", async () => {
		const f = await fixture();
		try {
			const replacement = join(f.root, "replacement.json");
			await writeFile(f.authority, v3());
			await writeFile(replacement, '{"kind":"openwebui-gjc-session-authority","version":2,"records":[]}');
			await rename(replacement, f.authority);
			expect(probeSessionAuthorityEpoch(f.authority, { managedDigest: "0".repeat(64) })).toEqual({
				status: "v2",
				selection: "managed-bootstrap",
			});
		} finally {
			await f.cleanup();
		}
	});

	test("never reads adjacent transcript or artifact paths", async () => {
		const f = await fixture();
		try {
			await writeFile(f.authority, '{"kind":"openwebui-gjc-session-authority","version":2,"records":[]}');
			await writeFile(join(f.root, "session.jsonl"), "not an authority document");
			await writeFile(join(f.root, "artifact.bin"), "not an authority document");
			expect(probeSessionAuthorityEpoch(f.authority)).toEqual({ status: "v2", selection: "managed-bootstrap" });
		} finally {
			await f.cleanup();
		}
	});
});
