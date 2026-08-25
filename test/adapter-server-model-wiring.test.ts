import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import type { ModelReaderFactory } from "../src/live/model-reader";
import { FakeGjcTurnRunner } from "./cli-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

describe("adapter server model wiring", () => {
	test("passes one reader-factory identity and the resolved neutral workspace to shipped routes", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-adapter-model-wiring-"));
		const modelReaderFactory: ModelReaderFactory = staticModelReaderFactory();
		try {
			const options = await buildAdapterServerOptions(
				{
					mode: "existing",
					bindHost: "127.0.0.1",
					bindPort: 8765,
					openWebUIBaseUrl: "http://127.0.0.1:3000",
					allowedProjectRoots: [],
					projects: [],
					statePath: join(root, "state"),
					sessionRoot: join(root, "sessions"),
					gjcCommand: "/opt/gjc",
					turnTimeoutMs: 240_000,
				},
				{ turnRunner: new FakeGjcTurnRunner(), modelReaderFactory },
			);
			expect(options.routes?.modelReaderFactory).toBe(modelReaderFactory);
			expect(options.turnTimeoutMs).toBe(240_000);
			expect(options.routes?.neutralWorkspace).toEndWith("/.gjc/openwebui/default-reader");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
