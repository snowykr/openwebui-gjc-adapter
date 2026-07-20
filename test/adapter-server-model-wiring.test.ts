import { describe, expect, test } from "bun:test";
import { buildAdapterServerOptions } from "../src/adapter-server-options";
import type { ModelReaderFactory } from "../src/live/model-reader";
import { FakeGjcTurnRunner } from "./cli-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

describe("adapter server model wiring", () => {
	test("passes one reader-factory identity and the resolved neutral workspace to shipped routes", async () => {
		const modelReaderFactory: ModelReaderFactory = staticModelReaderFactory();
		const options = await buildAdapterServerOptions(
			{
				mode: "existing",
				bindHost: "127.0.0.1",
				bindPort: 8765,
				openWebUIBaseUrl: "http://127.0.0.1:3000",
				allowedProjectRoots: [],
				projects: [],
				statePath: "/tmp/gjc-adapter-model-wiring-state",
				sessionRoot: "/tmp/gjc-adapter-model-wiring-sessions",
				gjcCommand: "/opt/gjc",
				turnTimeoutMs: 240_000,
			},
			{ turnRunner: new FakeGjcTurnRunner(), modelReaderFactory },
		);
		expect(options.routes?.modelReaderFactory).toBe(modelReaderFactory);
		expect(options.turnTimeoutMs).toBe(240_000);
		expect(options.routes?.neutralWorkspace).toEndWith("/.gjc/openwebui/default-reader");
	});
});
