import { describe, expect, test } from "bun:test";
import { withPublicSdkSessionMutationCoordinator } from "../src/gjc/public-sdk-session-port";
import { waitForReply } from "../src/gjc/public-sdk-turns";
import type { SdkV3Client } from "../src/gjc/sdk-v3-client";
import type { SdkRecord } from "../src/gjc/sdk-v3-protocol";
import { SdkTerminalWindow } from "../src/gjc/sdk-v3-terminal";
import { turnResult } from "../src/live/gjc-routing-proof";
import { createSdkTransportFixture, expectSdkRequest } from "./gjc-sdk-v3-fixtures";

describe("latest dev SDK v3 terminal and gate contract", () => {
	test("Given an active owner When it attaches and mutates through the same owner Then reentry succeeds and a foreign ambient owner is rejected", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		const owner = {};
		const foreignOwner = {};
		let foreignEffectRan = false;
		try {
			await withPublicSdkSessionMutationCoordinator(
				{ cwd: fixture.attachment.cwd, sessionId: fixture.attachment.sessionId },
				owner,
				async () => {
					await fixture.port.attach(fixture.attachment, undefined, owner);
					await expect(
						withPublicSdkSessionMutationCoordinator(
							{ cwd: fixture.attachment.cwd, sessionId: fixture.attachment.sessionId },
							foreignOwner,
							async () => {
								foreignEffectRan = true;
							},
						),
					).rejects.toMatchObject({ code: "coordinator_owner_mismatch" });
					await expect(fixture.port.prompt("owned mutation", 500)).resolves.toMatchObject({
						events: expect.any(Array),
					});
				},
			);
			expect(foreignEffectRan).toBeFalse();
			expectSdkRequest(fixture.server.frames, "control_request", "turn.prompt");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given correlated terminal, action, and final frames before acceptance When a later exact terminal arrives Then pre-accept frames remain quarantined", async () => {
		const fixture = createSdkTransportFixture("pre_accept_correlated_frames");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("quarantine", 500);

			expect(outcome.events).toEqual([
				expect.objectContaining({ type: "agent_end", commandId: "command-right", turnId: "turn-right" }),
			]);
			expect(outcome.finalizedAssistantText).not.toBe("quarantined final");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "query_request" && frame.query === "workflow.gates.list",
				),
			).toBe(true);
		} finally {
			await fixture.dispose();
		}
	});
	test("Given a session-only finalized result from another turn and a correlated terminal When prompting Then no stale answer is substituted", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("new answer", 500);

			expect(outcome.finalizedAssistantText).toBeUndefined();
			expect(outcome.events).toContainEqual(
				expect.objectContaining({ type: "turn_stream", text: "stale session-only assistant" }),
			);
			expect(
				fixture.server.frames.some(
					frame => frame.type === "query_request" && frame.query === "session.last_assistant",
				),
			).toBeFalse();
		} finally {
			await fixture.dispose();
		}
	});
	test("Given a correlated finalized result When prompting Then its authoritative text is returned", async () => {
		const fixture = createSdkTransportFixture("turn_finalized");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("new answer", 500);

			expect(outcome.finalizedAssistantText).toBe("correlated assistant");
			expect(
				fixture.server.frames.some(
					frame => frame.type === "query_request" && frame.query === "session.last_assistant",
				),
			).toBeFalse();
		} finally {
			await fixture.dispose();
		}
	});
	test("Given a correlated agent_failed When prompting Then it surfaces the upstream typed failure", async () => {
		const fixture = createSdkTransportFixture("turn_failed");
		try {
			await fixture.attach();
			await expect(fixture.port.prompt("fail", 500)).rejects.toMatchObject({
				name: "SdkV3OperationError",
				message: expect.stringContaining("fixture model failed"),
			});
		} finally {
			await fixture.dispose();
		}
	});

	test("Given action_needed When prompting Then the durable pending gate is queried before returning", async () => {
		const fixture = createSdkTransportFixture("workflow_gate");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("ask", 500);

			expect(outcome.gate).toMatchObject({ gateId: "durable-gate" });
			expectSdkRequest(fixture.server.frames, "query_request", "workflow.gates.list");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given an unrelated pending baseline gate When a new durable gate opens Then only the new gate is returned", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_not_first");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("ask", 500);

			expect(outcome.gate).toMatchObject({ gateId: "durable-gate" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given one action opens several new durable gates When prompting Then it fails closed", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_mismatch");
		try {
			await fixture.attach();
			await expect(fixture.port.prompt("ask", 500)).rejects.toMatchObject({ code: "invalid_result" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a durable gate answer When the resumed agent is still running Then answerGate waits for its terminal", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_continuation");
		try {
			await fixture.attach();
			const initial = await fixture.port.prompt("ask", 500);
			if (initial.gate === undefined) throw new TypeError("workflow gate is required");
			const outcome = await fixture.port.answerGate(initial.gate, { approved: true }, "same-answer");
			const answer = expectSdkRequest(fixture.server.frames, "control_request", "workflow.gate_answer");

			expect(outcome.finalizedAssistantText).toBe("continued assistant");
			expect(answer.idempotencyKey).toBe("same-answer");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a gate answer opens another gate When continuing Then the next gate remains observable and answerable", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_sequence");
		try {
			await fixture.attach();
			const first = await fixture.port.prompt("ask twice", 500);
			if (first.gate === undefined) throw new TypeError("first workflow gate is required");
			const second = await fixture.port.answerGate(first.gate, { selected: "first" }, "answer-1");
			if (second.gate === undefined) throw new TypeError("second workflow gate is required");
			await fixture.port.answerGate(second.gate, { selected: "second" }, "answer-2");

			expect(second.gate.gateId).toBe("gate-sequence-2");
			expect(
				fixture.server.frames.filter(
					frame => frame.type === "control_request" && frame.operation === "workflow.gate_answer",
				),
			).toHaveLength(2);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a correlated terminal arrives during gate lookup When lookup returns empty Then it is not lost", async () => {
		const fixture = createSdkTransportFixture("terminal_during_gate_query");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("race", 100);
			expect(outcome.events.at(-1)).toMatchObject({ type: "agent_end", turnId: "turn-right" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a correlated terminal arrives while gate lookup hangs When waiting Then terminal wins the race", async () => {
		const fixture = createSdkTransportFixture("terminal_while_gate_query_hangs");
		try {
			await fixture.attach();
			const outcome = await fixture.port.prompt("race", 100);
			expect(outcome.events.at(-1)).toMatchObject({ type: "agent_end", turnId: "turn-right" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a normal long turn without ask action When waiting Then only the baseline gate query is sent", async () => {
		const fixture = createSdkTransportFixture("slow_turn_without_gate");
		try {
			await fixture.attach();
			await fixture.port.prompt("work", 250);
			const gateQueries = fixture.server.frames.filter(
				frame => frame.type === "query_request" && frame.query === "workflow.gates.list",
			);
			expect(gateQueries).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given finalized output and idle without a lifecycle terminal When prompting Then it cannot end the turn", async () => {
		const fixture = createSdkTransportFixture("idle_terminal_without_lifecycle");
		try {
			await fixture.attach();
			await expect(fixture.port.prompt("complete through idle", 100)).rejects.toMatchObject({ code: "timeout" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given an idle frame without a finalized turn in this request When prompting Then it cannot end the turn", async () => {
		const fixture = createSdkTransportFixture("idle_without_finalized_turn");
		try {
			await fixture.attach();
			await expect(fixture.port.prompt("new turn", 80)).rejects.toMatchObject({ code: "timeout" });
		} finally {
			await fixture.dispose();
		}
	});
	test("Given an accepted reply that is later rejected When answering an action Then acknowledgement alone is not success", async () => {
		const fixture = createSdkTransportFixture("reply_rejected");
		try {
			await fixture.attach();
			await expect(fixture.port.replyToAction("action-1", { approved: true }, "reject", 500)).rejects.toMatchObject({
				code: "reply_rejected",
				message: expect.stringContaining("fixture rejected reply"),
			});
		} finally {
			await fixture.dispose();
		}
	});
	test("Given a reply resolution already dispatched during listener installation When waiting Then it resolves and releases the listener", async () => {
		const listeners = new Set<(frame: SdkRecord) => void>();
		const client = {
			onFrame(listener: (frame: SdkRecord) => void) {
				listeners.add(listener);
				listener({ type: "action_resolved", sessionId: "session-1", actionId: "action-1" });
				return () => listeners.delete(listener);
			},
		} as unknown as SdkV3Client;
		const resolution = waitForReply(client, "session-1", "action-1", 500);

		await expect(resolution.promise).resolves.toBeUndefined();
		expect(listeners).toHaveLength(0);
	});
	test("Given a reply rejection frame When waiting Then it rejects and releases the listener", async () => {
		const { client, listeners } = replyResolutionClient();
		const resolution = waitForReply(client, "session-1", "action-1", 500);

		for (const listener of listeners)
			listener({ type: "reply_rejected", sessionId: "session-1", actionId: "action-1", message: "rejected" });

		await expect(resolution.promise).rejects.toMatchObject({ code: "reply_rejected" });
		expect(listeners).toHaveLength(0);
	});
	test("Given no reply resolution frame When waiting times out Then it rejects and releases the listener", async () => {
		const { client, listeners } = replyResolutionClient();
		const resolution = waitForReply(client, "session-1", "action-1", 20);

		await expect(resolution.promise).rejects.toMatchObject({ code: "timeout" });
		expect(listeners).toHaveLength(0);
	});
	test("Given a rejected reply waiter canceled before it is awaited When dispatch fails Then its rejection is consumed", async () => {
		const { client, listeners } = replyResolutionClient();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const resolution = waitForReply(client, "session-1", "action-1", 500);
			for (const listener of listeners)
				listener({ type: "reply_rejected", sessionId: "session-1", actionId: "action-1", message: "rejected" });
			resolution.cancel();
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
	test("Given an attached public session When OpenWebUI controls are dispatched Then each released control operation is observable", async () => {
		const fixture = createSdkTransportFixture("controls");
		try {
			await fixture.attach();
			await fixture.port.steer("steer", "steer-key", 500);
			await fixture.port.abort("abort-key", 500);
			await fixture.port.replyToAction("action-1", { approved: true }, "action-key", 500);
			await fixture.port.planApprove({ planId: "plan-1" }, "plan-key", 500);

			for (const operation of ["turn.steer", "turn.abort", "ask.answer", "workflow.plan_approve"]) {
				expectSdkRequest(fixture.server.frames, "control_request", operation);
			}
		} finally {
			await fixture.dispose();
		}
	});
	test("Given 0.11.6 payload-wrapped terminal and session event frames When waiting Then terminal text and presentation events are normalized", async () => {
		const { terminal, emit } = await terminalFixture();
		try {
			const pending = terminal.wait(correlation, 500);
			emit({
				type: "turn_stream",
				payload: {
					type: "turn_stream",
					sessionId: correlation.sessionId,
					phase: "finalized",
					text: "exact finalized text",
					finalAnswer: true,
				},
			});
			for (const assistantMessageEvent of [
				{ type: "text_delta", text: "visible" },
				{ type: "thinking", text: "reasoning" },
				{ type: "tool_call", name: "read" },
			]) {
				emit({
					type: "event",
					payload: {
						type: "event",
						kind: "message_update",
						payload: {
							event_type: "message_update",
							event: { assistantMessageEvent },
							commandId: correlation.commandId,
							turnId: correlation.turnId,
							sessionId: correlation.sessionId,
						},
					},
				});
			}
			emit({ type: "agent_end", payload: { type: "agent_end", ...correlation } });
			const outcome = await pending;
			const result = turnResult(outcome, undefined);

			expect(outcome.finalizedAssistantText).toBe("exact finalized text");
			expect(outcome.events.map(event => event.type)).toEqual([
				"turn_stream",
				"message_update",
				"message_update",
				"message_update",
				"agent_end",
			]);
			expect(result.events.filter(event => event.type === "message_update").map(event => event.payload)).toEqual([
				expect.objectContaining({
					event_type: "message_update",
					event: { assistantMessageEvent: { type: "text_delta", text: "visible" } },
				}),
				expect.objectContaining({ event: { assistantMessageEvent: { type: "thinking", text: "reasoning" } } }),
				expect.objectContaining({ event: { assistantMessageEvent: { type: "tool_call", name: "read" } } }),
			]);
			expect(result.events.some(event => event.type === "event")).toBeFalse();
		} finally {
			terminal.close();
		}
	});
	test("Given malformed or mismatched 0.11.6 agent_end envelopes When waiting Then they cannot terminate another turn", async () => {
		const { terminal, emit } = await terminalFixture();
		try {
			let settled = false;
			const pending = terminal.wait(correlation, 500).then(outcome => {
				settled = true;
				return outcome;
			});
			emit({ type: "agent_end", payload: { type: "agent_end", ...correlation, turnId: "other-turn" } });
			emit({ type: "agent_end", payload: { type: "not_agent_end", ...correlation } });
			await Promise.resolve();
			expect(settled).toBeFalse();

			emit({ type: "agent_end", payload: { type: "agent_end", ...correlation } });
			await expect(pending).resolves.toMatchObject({
				events: expect.arrayContaining([
					expect.objectContaining({ type: "agent_end", turnId: correlation.turnId }),
				]),
			});
		} finally {
			terminal.close();
		}
	});
});

function replyResolutionClient(): {
	readonly client: SdkV3Client;
	readonly listeners: Set<(frame: SdkRecord) => void>;
} {
	const listeners = new Set<(frame: SdkRecord) => void>();
	return {
		client: {
			onFrame(listener: (frame: SdkRecord) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as unknown as SdkV3Client,
		listeners,
	};
}
const correlation = { sessionId: "session-0116", commandId: "command-0116", turnId: "turn-0116" };

async function terminalFixture(): Promise<{
	readonly terminal: SdkTerminalWindow;
	readonly emit: (frame: SdkRecord) => void;
}> {
	const listeners = new Set<(frame: SdkRecord) => void>();
	const client = {
		onFrame(listener: (frame: SdkRecord) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		queryAll: async () => [],
	} as unknown as SdkV3Client;
	const terminal = new SdkTerminalWindow(client, correlation.sessionId);
	await terminal.captureGateBaseline(500);
	terminal.beginMutation();
	terminal.accept(correlation);
	return {
		terminal,
		emit: frame => {
			for (const listener of listeners) listener(frame);
		},
	};
}
