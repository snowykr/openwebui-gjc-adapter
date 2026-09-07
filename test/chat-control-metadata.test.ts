import { describe, expect, test } from "bun:test";
import { controlFromMetadata } from "../src/live/chat-control-metadata";

describe("chat control metadata", () => {
	test.each(["session-1", "6d15cf40-f019-4ee8-a195-e601b538121b"])(
		"accepts exact resume identity %s without file authority",
		sessionId => {
			const control = { operation: "session.resume", sessionId } as const;
			expect(controlFromMetadata({ gjc_control: control, unrelated: "metadata" })).toEqual(control);
		},
	);

	test.each(
		[
			undefined,
			null,
			"",
			" ",
			" session-1",
			"session-1 ",
			"session\n1",
			"session\u00001",
			"session\u007f1",
			1,
			{},
			[],
		].map(sessionId => ({ sessionId })),
	)("rejects missing, empty, non-exact or non-string resume identity %j", ({ sessionId }) => {
		expect(controlFromMetadata({ gjc_control: { operation: "session.resume", sessionId } })).toEqual({
			operation: "unsupported",
			surface: "session.resume",
		});
	});

	test("rejects a resume operation with no identity field", () => {
		expect(controlFromMetadata({ gjc_control: { operation: "session.resume" } })).toEqual({
			operation: "unsupported",
			surface: "session.resume",
		});
	});

	test.each([
		"sessionFile",
		"sessionPath",
		"path",
		"cwd",
		"generation",
		"endpointGeneration",
		"endpointIncarnation",
		"attachment",
		"descriptor",
		"token",
		"leaseId",
		"text",
		"unexpected",
	])("rejects extra resume field %s instead of silently discarding it", field => {
		for (const value of ["untrusted", null, undefined]) {
			expect(
				controlFromMetadata({
					gjc_control: { operation: "session.resume", sessionId: "session-1", [field]: value },
				}),
			).toEqual({ operation: "unsupported", surface: "session.resume" });
		}
	});

	test("preserves absent and malformed control handling", () => {
		expect(controlFromMetadata(undefined)).toBeUndefined();
		expect(controlFromMetadata({ other: "metadata" })).toBeUndefined();
		for (const control of [null, [], "session.resume", 1])
			expect(controlFromMetadata({ gjc_control: control })).toEqual({
				operation: "unsupported",
				surface: "invalid",
			});
		expect(controlFromMetadata({ gjc_control: { operation: "unknown" } })).toEqual({
			operation: "unsupported",
			surface: "unknown",
		});
	});

	test("preserves parsing of other supported controls", () => {
		for (const operation of ["abort", "steer", "follow_up", "abort_and_prompt"] as const)
			expect(controlFromMetadata({ gjc_control: { operation, text: "hello" } })).toEqual({
				operation,
				text: "hello",
			});
		for (const operation of ["branch", "session.new"] as const)
			expect(controlFromMetadata({ gjc_control: { operation } })).toEqual({ operation });
		expect(
			controlFromMetadata({
				gjc_control: { operation: "action_reply", actionId: "ask-1", answer: { value: "yes" } },
			}),
		).toEqual({ operation: "action_reply", actionId: "ask-1", answer: { value: "yes" } });
		expect(
			controlFromMetadata({ gjc_control: { operation: "workflow.plan_approve", input: { planId: "plan-1" } } }),
		).toEqual({ operation: "workflow.plan_approve", input: { planId: "plan-1" } });
	});
});
