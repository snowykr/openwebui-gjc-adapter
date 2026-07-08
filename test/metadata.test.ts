import { describe, expect, test } from "bun:test";
import { buildLineageHash, createOperationId } from "../src/state/metadata";

describe("metadata primitives", () => {
	test("creates deterministic operation ids when a date is provided", () => {
		const operationId = createOperationId("sync", new Date("2026-07-08T12:34:56.789Z"));

		expect(operationId).toBe("sync-20260708T123456789Z-0a599f37ee7cb255");
		expect(operationId).toMatch(/^sync-20260708T123456789Z-[a-f0-9]{16}$/);
	});

	test("creates operation ids with random suffixes when date is omitted", () => {
		const firstOperationId = createOperationId("sync");
		const secondOperationId = createOperationId("sync");

		expect(firstOperationId).toMatch(/^sync-\d{8}T\d{9}Z-[a-f0-9]{16}$/);
		expect(secondOperationId).toMatch(/^sync-\d{8}T\d{9}Z-[a-f0-9]{16}$/);
		expect(firstOperationId).not.toBe(secondOperationId);
	});

	test("builds stable framed sha256 lineage hashes", () => {
		expect(buildLineageHash(["chat-1", "message-1", "0"])).toBe(
			"e5ce281361f71bba525a4c3810b9b1c477d06c6eef70646186da1eff2aee90cb",
		);
		expect(buildLineageHash(["ab", "c"])).not.toBe(buildLineageHash(["a", "bc"]));
	});
});
