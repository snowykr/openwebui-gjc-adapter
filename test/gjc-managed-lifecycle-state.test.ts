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

describe("managed lifecycle state", () => {
	test("accepts every and only normative lifecycle edge", () => {
		for (const from of MANAGED_LIFECYCLE_STATES) {
			for (const to of MANAGED_LIFECYCLE_STATES) {
				const legal = MANAGED_LIFECYCLE_TRANSITIONS[from].includes(to);
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
