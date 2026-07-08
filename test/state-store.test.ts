import { describe, expect, test } from "bun:test";
import { ADAPTER_STATE_SCHEMA_VERSION, buildInitialStateStoreDefinition } from "../src/state/store";

describe("adapter state store definition", () => {
	test("starts at current Phase 0 schema version with no migrations", () => {
		expect(ADAPTER_STATE_SCHEMA_VERSION).toBe(0);
		expect(buildInitialStateStoreDefinition()).toEqual({
			schemaVersion: ADAPTER_STATE_SCHEMA_VERSION,
			migrations: [],
		});
	});
});
