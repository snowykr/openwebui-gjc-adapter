import { describe, expect, test } from "bun:test";
import {
	assertManagedLifecycleTransition,
	canTransitionManagedLifecycleState,
	decodeManagedLifecycleState,
	encodeManagedLifecycleState,
	MANAGED_LIFECYCLE_STATES,
	MANAGED_LIFECYCLE_TRANSITIONS,
	ManagedLifecycleStateError,
	parseManagedLifecycleState,
} from "../src/gjc/managed-lifecycle-state";

const EXPECTED_TRANSITIONS = {
	intent_prepared: ["invoking", "terminal_failure"],
	invoking: ["acknowledged_unproven", "terminal_failure", "uncertain", "cleanup_pending"],
	acknowledged_unproven: ["active_generation_proven", "cleanup_pending", "uncertain", "retired", "cleanup_uncertain"],
	active_generation_proven: ["closing"],
	closing: ["active_generation_proven", "retired", "uncertain"],
	retired: [],
	terminal_failure: [],
	uncertain: [
		"acknowledged_unproven",
		"active_generation_proven",
		"retired",
		"terminal_failure",
		"cleanup_pending",
		"cleanup_uncertain",
	],
	cleanup_pending: ["invoking", "cleanup_uncertain"],
	cleanup_uncertain: ["cleanup_pending", "retired", "uncertain"],
} as const;

describe("managed lifecycle state", () => {
	test("retains ambiguous temporary cleanup after acknowledgement without restoring routing", () => {
		expect(() => assertManagedLifecycleTransition("acknowledged_unproven", "cleanup_uncertain")).not.toThrow();
		expect(decodeManagedLifecycleState(encodeManagedLifecycleState("cleanup_uncertain"))).toBe("cleanup_uncertain");
		expect(() => assertManagedLifecycleTransition("cleanup_uncertain", "active_generation_proven")).toThrow(
			ManagedLifecycleStateError,
		);
		expect(() => assertManagedLifecycleTransition("retired", "cleanup_uncertain")).toThrow(
			ManagedLifecycleStateError,
		);
	});
	test("accepts every and only normative lifecycle edge", () => {
		expect(MANAGED_LIFECYCLE_TRANSITIONS).toEqual(EXPECTED_TRANSITIONS);
		for (const from of MANAGED_LIFECYCLE_STATES) {
			for (const to of MANAGED_LIFECYCLE_STATES) {
				const legal = (EXPECTED_TRANSITIONS[from] as readonly string[]).includes(to);
				expect(canTransitionManagedLifecycleState(from, to)).toBe(legal);
				if (legal) expect(() => assertManagedLifecycleTransition(from, to)).not.toThrow();
				else expect(() => assertManagedLifecycleTransition(from, to)).toThrow(ManagedLifecycleStateError);
			}
		}
	});

	test("round-trips only the credential-free state codec", () => {
		for (const state of MANAGED_LIFECYCLE_STATES) {
			const encoded = encodeManagedLifecycleState(state);
			expect(encoded).toBe(JSON.stringify({ state }));
			expect(decodeManagedLifecycleState(encoded)).toBe(state);
			expect(encoded).not.toContain("token");
			expect(encoded).not.toContain("url");
		}
	});

	test("rejects malformed and unknown codec values", () => {
		for (const malformed of [
			undefined,
			null,
			"",
			"{}",
			"[]",
			'{"state":"unknown"}',
			'{"state":"retired","extra":true}',
		]) {
			expect(() => decodeManagedLifecycleState(malformed)).toThrow(ManagedLifecycleStateError);
		}
		expect(() => parseManagedLifecycleState("active")).toThrow(ManagedLifecycleStateError);
	});
});
