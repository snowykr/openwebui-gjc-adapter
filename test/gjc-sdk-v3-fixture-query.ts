import type { SdkFixtureScenario } from "./gjc-sdk-v3-fixture-types";
import { MODEL_DESCRIPTORS } from "./model-selection-fixtures";

export function handleQuery(
	socket: Bun.ServerWebSocket<unknown>,
	id: string,
	query: string,
	scenario: SdkFixtureScenario,
	gateAnswered: boolean,
	sequentialGate: string,
	promptStarted: boolean,
): void {
	if (query === "session.last_assistant" && scenario === "idle_terminal_without_lifecycle") {
		socket.send(
			JSON.stringify({
				type: "query_response",
				id,
				ok: false,
				error: { code: "resource_gone", message: "snapshot payload is unavailable" },
			}),
		);
		return;
	}
	const items: readonly unknown[] =
		query === "workflow.gates.list"
			? !promptStarted
				? scenario === "workflow_gate_not_first"
					? [{ gate_id: "unrelated-gate", stage: "ralplan", kind: "approval", required: true }]
					: []
				: scenario === "action_without_gate" ||
						scenario === "terminal_during_gate_query" ||
						scenario === "idle_terminal_without_lifecycle" ||
						scenario === "idle_without_finalized_turn"
					? []
					: scenario === "workflow_gate_not_first"
						? [
								{ gate_id: "unrelated-gate", stage: "ralplan", kind: "approval", required: true },
								{ gate_id: "durable-gate", stage: "ralplan", kind: "approval", required: true },
							]
						: scenario === "workflow_gate_mismatch"
							? [
									{ gate_id: "new-gate-a", stage: "ralplan", kind: "approval", required: true },
									{ gate_id: "new-gate-b", stage: "ralplan", kind: "approval", required: true },
								]
							: scenario === "workflow_gate_sequence"
								? [{ gate_id: sequentialGate, stage: "deep-interview", kind: "question", required: true }]
								: [{ gate_id: "durable-gate", stage: "ralplan", kind: "approval", required: true }]
			: query === "models.list/current"
				? scenario === "model_catalog"
					? MODEL_DESCRIPTORS
					: [
							{
								provider: "future",
								id: "capable",
								name: "Capable",
								reasoning: true,
								thinking: {
									minLevel: "off",
									maxLevel: "high",
									mode: "effort",
									levels: ["off", "high"],
									defaultLevel: "off",
								},
							},
						]
				: query === "session.last_assistant"
					? [gateAnswered ? "continued assistant" : "fixture assistant"]
					: query === "session.metadata"
						? [
								{
									sessionId: scenario === "resumed_session" ? "sdk-session-resumed" : "sdk-session-created",
									cwd: process.env.GJC_SDK_FIXTURE_EXPECTED_CWD ?? "/workspace",
									kind: "saved",
								},
							]
						: query === "config.list/get"
							? [
									scenario === "model_catalog"
										? { model: "anthropic/claude-sonnet-4", thinking: "low" }
										: { model: "future/capable", thinking: "high" },
								]
							: [];
	if (query === "workflow.gates.list" && scenario === "terminal_during_gate_query" && promptStarted) {
		socket.send(
			JSON.stringify({
				type: "agent_end",
				sessionId: "sdk-session-created",
				commandId: "command-right",
				turnId: "turn-right",
			}),
		);
	}
	if (query === "workflow.gates.list" && scenario === "terminal_while_gate_query_hangs" && promptStarted) {
		setTimeout(() => {
			socket.send(
				JSON.stringify({
					type: "agent_end",
					sessionId: "sdk-session-created",
					commandId: "command-right",
					turnId: "turn-right",
				}),
			);
		}, 5);
		return;
	}
	socket.send(
		JSON.stringify({
			type: "query_response",
			id,
			ok: true,
			page: { items, complete: true, revision: 1 },
		}),
	);
	if (query === "workflow.gates.list" && scenario === "action_without_gate" && promptStarted) {
		socket.send(
			JSON.stringify({
				type: "agent_end",
				sessionId: "sdk-session-created",
				commandId: "command-right",
				turnId: "turn-right",
			}),
		);
	}
}
