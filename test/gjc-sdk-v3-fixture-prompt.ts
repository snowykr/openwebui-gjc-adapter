import type { SdkFixtureScenario } from "./gjc-sdk-v3-fixture-types";

export function handlePrompt(socket: Bun.ServerWebSocket<unknown>, id: string, scenario: SdkFixtureScenario): void {
	if (scenario === "disconnect") {
		socket.close(1012, "restart");
		return;
	}
	const correlation = { commandId: "command-right", turnId: "turn-right" } as const;
	if (scenario === "turn_complete" || scenario === "resumed_session") {
		socket.send(
			JSON.stringify({
				type: "agent_end",
				sessionId: "sdk-session-created",
				commandId: "command-wrong",
				turnId: "turn-wrong",
			}),
		);
		socket.send(JSON.stringify({ type: "agent_end", sessionId: "sdk-session-created", ...correlation }));
	}
	if (scenario === "turn_failed") {
		socket.send(
			JSON.stringify({
				type: "agent_failed",
				sessionId: "sdk-session-created",
				...correlation,
				error: { code: "model_unavailable", message: "fixture model failed" },
			}),
		);
	}
	if (
		scenario === "workflow_gate" ||
		scenario === "workflow_gate_not_first" ||
		scenario === "workflow_gate_mismatch" ||
		scenario === "workflow_gate_continuation" ||
		scenario === "workflow_gate_sequence" ||
		scenario === "action_without_gate" ||
		scenario === "terminal_during_gate_query" ||
		scenario === "terminal_while_gate_query_hangs"
	) {
		socket.send(
			JSON.stringify({
				type: "action_needed",
				id: `gate-interaction:${scenario === "workflow_gate_sequence" ? "sequence-1" : "durable"}`,
				kind: "ask",
				sessionId: "sdk-session-created",
			}),
		);
	}
	if (scenario === "idle_terminal_without_lifecycle") {
		socket.send(
			JSON.stringify({
				type: "turn_stream",
				sessionId: "sdk-session-created",
				phase: "finalized",
				finalAnswer: true,
				text: "current dev assistant",
			}),
		);
		socket.send(
			JSON.stringify({
				type: "action_needed",
				id: "idle:sdk-session-created#0",
				kind: "idle",
				sessionId: "sdk-session-created",
			}),
		);
	}
	if (scenario === "idle_without_finalized_turn") {
		socket.send(
			JSON.stringify({
				type: "action_needed",
				id: "idle:sdk-session-created#stale",
				kind: "idle",
				sessionId: "sdk-session-created",
			}),
		);
	}
	if (scenario === "slow_turn_without_gate") {
		setTimeout(() => {
			socket.send(JSON.stringify({ type: "agent_end", sessionId: "sdk-session-created", ...correlation }));
		}, 120);
	}
	socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: { accepted: true, ...correlation } }));
}
