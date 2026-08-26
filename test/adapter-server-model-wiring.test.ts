import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";

async function writeV3Authority(root: string, document: unknown): Promise<void> {
	const canonicalPath = join(root, "openwebui-session-mappings.json");
	const canonical = Buffer.from(`${JSON.stringify(document)}\n`);
	await writeFile(canonicalPath, canonical);
	await writeFile(
		`${canonicalPath}.v3-active.json`,
		`${JSON.stringify({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: createHash("sha256").update(canonical).digest("hex"),
			source: { baseDigest: "0".repeat(64), walDigest: "0".repeat(64), walPresent: false },
		})}\n`,
	);
}

describe("adapter server model wiring", () => {
	test("selects only the managed runner and model reader for an active V3 authority", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-managed-model-wiring-"));
		const calls: string[] = [];
		const managedRuntime = {
			state: "new",
			start: async () => void calls.push("managed-start"),
			dispose: async () => void calls.push("managed-dispose"),
			reconcile: async () => undefined,
			registerTenant: () => undefined,
			acquireAttachment: async () => undefined,
			generationStatus: async () => ({ status: "current" as const }),
		};
		try {
			const sessionRoot = join(root, "sessions");
			await mkdir(sessionRoot, { recursive: true });
			await writeV3Authority(sessionRoot, {
				kind: "openwebui-gjc-session-authority",
				version: 3,
				authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
				mappings: [],
				provisionalOperations: [],
			});
			const options = await buildAdapterServerOptions(
				{
					mode: "existing",
					bindHost: "127.0.0.1",
					bindPort: 8765,
					openWebUIBaseUrl: "http://127.0.0.1:3000",
					allowedProjectRoots: [],
					projects: [],
					statePath: join(root, "state"),
					sessionRoot,
					gjcCommand: "/not-used-for-managed-v3",
					turnTimeoutMs: 240_000,
				},
				{ managedSdkRuntime: managedRuntime as never },
			);

			expect(options.routes?.runner).toBeDefined();
			const selectedModelReaderFactory = options.routes?.modelReaderFactory;
			expect(selectedModelReaderFactory).toBeDefined();
			expect(options.turnTimeoutMs).toBe(240_000);
			expect(options.routes?.neutralWorkspace).toEndWith("/.gjc/openwebui/default-reader");
			await expect(selectedModelReaderFactory!()).rejects.toThrow(
				"Managed model catalog access requires explicit tenant or temporary service authority.",
			);
			expect(calls).toEqual(["managed-start"]);
			await options.shutdownCleanup?.();
			expect(calls).toEqual(["managed-start", "managed-dispose"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed for malformed V3 authority before startup effects", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-malformed-v3-"));
		const calls: string[] = [];
		try {
			const sessionRoot = join(root, "sessions");
			await mkdir(sessionRoot, { recursive: true });
			await writeV3Authority(sessionRoot, {
				kind: "openwebui-gjc-session-authority",
				version: 3,
				authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
				mappings: [{}],
				provisionalOperations: [],
			});
			await expect(
				buildAdapterServerOptions(
					{
						mode: "existing",
						bindHost: "127.0.0.1",
						bindPort: 8765,
						openWebUIBaseUrl: "http://127.0.0.1:3000",
						allowedProjectRoots: [],
						projects: [],
						statePath: join(root, "state"),
						sessionRoot,
						gjcCommand: "/not-used-for-malformed-v3",
						turnTimeoutMs: 240_000,
					},
					{ managedSdkRuntime: { start: async () => void calls.push("managed-start") } as never },
				),
			).rejects.toThrow("Canonical session authority activation is blocked.");
			expect(calls).toEqual([]);
			await expect(stat(join(root, "state"))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
