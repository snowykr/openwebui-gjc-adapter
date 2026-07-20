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
	activeSessionId: string,
	activeSessionCwd: string,
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
	if (query === "session.branch_candidates") {
		const items =
			scenario === "branch_candidate_absent"
				? []
				: scenario === "branch_candidate_duplicate"
					? [
							{ entry: { id: "entry-q16", type: "message" }, children: [] },
							{ entry: { id: "entry-q16", type: "message" }, children: [] },
						]
					: scenario === "branch_candidate_drift"
						? [{ entry: { id: "entry-q16", type: "drifted-message" }, children: [] }]
						: [{ entry: { id: "entry-q16", type: "message" }, children: [] }];
		socket.send(JSON.stringify({ type: "query_response", id, ok: true, page: { items, complete: true, revision: 16 } }));
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
								contextWindow: 128_000,
								maxTokens: 32_000,
								reasoning: true,
								thinking: {
									validLevels: ["off", "high"],
									minLevel: "high",
									maxLevel: "high",
									mode: "effort",
									levels: ["high"],
									defaultLevel: "high",
								},
								current: true,
								currentThinkingLevel: "high",
							},
						]
				: query === "session.last_assistant"
					? [gateAnswered ? "continued assistant" : "fixture assistant"]
					: query === "session.metadata"
						? [
								{
									sessionId: activeSessionId,
									cwd: activeSessionCwd,
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
