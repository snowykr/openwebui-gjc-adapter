import type { SdkFixtureScenario } from "./gjc-sdk-v3-fixture-types";

export function handlePrompt(
	socket: Bun.ServerWebSocket<unknown>,
	id: string,
	scenario: SdkFixtureScenario,
	sessionId = "sdk-session-created",
): void {
	if (scenario === "disconnect") {
		socket.close(1012, "restart");
		return;
	}
	const correlation = { commandId: "command-right", turnId: "turn-right" } as const;
	if (scenario === "pre_accept_correlated_frames") {
		socket.send(JSON.stringify({ type: "agent_end", sessionId: "sdk-session-created", ...correlation }));
		socket.send(JSON.stringify({ type: "action_needed", id: "pre-accept-action", kind: "ask", sessionId: "sdk-session-created", ...correlation }));
		socket.send(JSON.stringify({ type: "turn_stream", sessionId: "sdk-session-created", phase: "finalized", finalAnswer: true, text: "quarantined final", ...correlation }));
		socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: { accepted: true, ...correlation } }));
		setTimeout(() => sendEvent(socket, { type: "agent_end", sessionId: "sdk-session-created", ...correlation }), 20);
		return;
	}
	socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: { accepted: true, ...correlation } }));
	if (scenario === "turn_complete" || scenario === "resumed_session") {
		sendEvent(socket, { type: "agent_end", sessionId: "sdk-session-created", commandId: "command-wrong", turnId: "turn-wrong" });
		sendEvent(socket, { type: "agent_end", sessionId: "sdk-session-created", ...correlation });
	}
	if (scenario === "branch_regenerate") {
		sendEvent(socket, {
			type: "turn_stream",
			sessionId,
			phase: "finalized",
			finalAnswer: true,
			text: "successor assistant",
			...correlation,
		});
		sendEvent(socket, { type: "agent_end", sessionId, ...correlation });
	}
	if (scenario === "turn_failed") {
		sendEvent(socket, {
			type: "agent_failed",
			sessionId: "sdk-session-created",
			...correlation,
			error: { code: "model_unavailable", message: "fixture model failed" },
		});
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
		sendEvent(socket, {
			type: "action_needed",
			id: `gate-interaction:${scenario === "workflow_gate_sequence" ? "sequence-1" : "durable"}`,
			kind: "ask",
			sessionId: "sdk-session-created",
		});
	}
	if (scenario === "idle_terminal_without_lifecycle") {
		sendEvent(socket, {
			type: "turn_stream",
			sessionId: "sdk-session-created",
			phase: "finalized",
			finalAnswer: true,
			text: "current dev assistant",
		});
		sendEvent(socket, { type: "action_needed", id: "idle:sdk-session-created#0", kind: "idle", sessionId: "sdk-session-created" });
	}
	if (scenario === "idle_without_finalized_turn") {
		sendEvent(socket, { type: "action_needed", id: "idle:sdk-session-created#stale", kind: "idle", sessionId: "sdk-session-created" });
	}
	if (scenario === "slow_turn_without_gate") {
		setTimeout(() => sendEvent(socket, { type: "agent_end", sessionId: "sdk-session-created", ...correlation }), 120);
	}
}

function sendEvent(socket: Bun.ServerWebSocket<unknown>, frame: Readonly<Record<string, unknown>>): void {
	setTimeout(() => socket.send(JSON.stringify(frame)), 10);
}
