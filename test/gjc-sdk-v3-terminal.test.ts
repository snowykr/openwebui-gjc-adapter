import { describe, expect, test } from "bun:test";
import { createSdkTransportFixture, expectSdkRequest, readCliOperations } from "./gjc-sdk-v3-fixtures";

describe("latest dev SDK v3 terminal and gate contract", () => {
	test("Given protocol 3 endpoint When a persistent session is created Then it authenticates and correlates the exact terminal", async () => {
		const fixture = createSdkTransportFixture("turn_complete");
		try {
			const transport = fixture.transport;
			await transport.start();
			await transport.newSession();

			const events = await transport.promptAndWait("hello over SDK", 500);
			const state = await transport.getState();

			expect(fixture.server.connections).toBe(1);
			expect(events.at(-1)).toMatchObject({
				type: "agent_end",
				commandId: "command-right",
				turnId: "turn-right",
			});
			expectSdkRequest(fixture.server.frames, "control_request", "turn.prompt");
			expect(state.sessionFile).toBeUndefined();
			expect(readCliOperations(fixture.cliTranscript)).toEqual(["session.create"]);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a correlated agent_failed When prompting Then it surfaces the upstream typed failure", async () => {
		const fixture = createSdkTransportFixture("turn_failed");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			await expect(fixture.transport.promptAndWait("fail", 500)).rejects.toMatchObject({
				name: "GjcRpcRunnerError",
				message: expect.stringContaining("fixture model failed"),
			});
		} finally {
			await fixture.dispose();
		}
	});

	test("Given action_needed When prompting Then the durable pending gate is queried before returning", async () => {
		const fixture = createSdkTransportFixture("workflow_gate");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			const events = await fixture.transport.promptAndWait("ask", 500);

			expect(events.at(-1)).toMatchObject({ gateId: "durable-gate", gate_id: "durable-gate" });
			expectSdkRequest(fixture.server.frames, "query_request", "workflow.gates.list");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given an unrelated pending baseline gate When a new durable gate opens Then only the new gate is returned", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_not_first");
		try {
			await fixture.transport.newSession();

			const events = await fixture.transport.promptAndWait("ask", 500);

			expect(events.at(-1)).toMatchObject({ gateId: "durable-gate", gate_id: "durable-gate" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given one action opens several new durable gates When prompting Then it fails closed", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_mismatch");
		try {
			await fixture.transport.newSession();

			await expect(fixture.transport.promptAndWait("ask", 500)).rejects.toMatchObject({
				code: "invalid_result",
			});
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a durable gate answer When the resumed agent is still running Then respondGate waits for its terminal", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_continuation");
		try {
			await fixture.transport.newSession();
			await fixture.transport.promptAndWait("ask", 500);

			if (fixture.transport.respondGate === undefined) throw new TypeError("respondGate is required");
			await fixture.transport.respondGate("durable-gate", { approved: true }, "same-answer");
			const assistant = await fixture.transport.getLastAssistantText();
			const answer = expectSdkRequest(fixture.server.frames, "control_request", "workflow.gate_answer");

			expect(assistant).toBe("continued assistant");
			expect(answer.idempotencyKey).toBe("same-answer");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a gate answer opens another gate When continuing Then the next gate remains observable and answerable", async () => {
		const fixture = createSdkTransportFixture("workflow_gate_sequence");
		const observed: string[] = [];
		try {
			await fixture.transport.newSession();
			await fixture.transport.promptAndWait("ask twice", 500);
			const unsubscribe = fixture.transport.onWorkflowGate?.(gate => {
				if (gate.gateId !== undefined) observed.push(gate.gateId);
			});
			if (fixture.transport.respondGate === undefined) throw new TypeError("respondGate is required");

			await fixture.transport.respondGate("gate-sequence-1", { selected: "first" }, "answer-1");
			await fixture.transport.respondGate("gate-sequence-2", { selected: "second" }, "answer-2");
			unsubscribe?.();

			expect(observed).toContain("gate-sequence-2");
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
			await fixture.transport.newSession();

			const events = await fixture.transport.promptAndWait("race", 100);

			expect(events.at(-1)).toMatchObject({ type: "agent_end", turnId: "turn-right" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a correlated terminal arrives while gate lookup hangs When waiting Then terminal wins the race", async () => {
		const fixture = createSdkTransportFixture("terminal_while_gate_query_hangs");
		try {
			await fixture.transport.newSession();

			const events = await fixture.transport.promptAndWait("race", 100);

			expect(events.at(-1)).toMatchObject({ type: "agent_end", turnId: "turn-right" });
		} finally {
			await fixture.dispose();
		}
	});

	test("Given a normal long turn without ask action When waiting Then only the baseline gate query is sent", async () => {
		const fixture = createSdkTransportFixture("slow_turn_without_gate");
		try {
			await fixture.transport.newSession();

			await fixture.transport.promptAndWait("work", 250);

			const gateQueries = fixture.server.frames.filter(
				frame => frame.type === "query_request" && frame.query === "workflow.gates.list",
			);
			expect(gateQueries).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	});

	test("Given current dev omits lifecycle terminals When idle follows a finalized turn Then the turn still completes", async () => {
		const fixture = createSdkTransportFixture("idle_terminal_without_lifecycle");
		try {
			await fixture.transport.start();
			await fixture.transport.newSession();

			const events = await fixture.transport.promptAndWait("complete through idle", 100);
			const assistant = await fixture.transport.getLastAssistantText();

			expect(events).toContainEqual(
				expect.objectContaining({ type: "action_needed", kind: "idle", sessionId: "sdk-session-created" }),
			);
			expect(assistant).toBe("current dev assistant");
		} finally {
			await fixture.dispose();
		}
	});

	test("Given an idle frame without a finalized turn in this request When prompting Then it cannot end the turn", async () => {
		const fixture = createSdkTransportFixture("idle_without_finalized_turn");
		try {
			await fixture.transport.newSession();

			await expect(fixture.transport.promptAndWait("new turn", 80)).rejects.toMatchObject({ code: "timeout" });
		} finally {
			await fixture.dispose();
		}
	});
});
