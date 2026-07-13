import { expect } from "bun:test";
import { handlePrompt } from "./gjc-sdk-v3-fixture-prompt";
import { handleQuery } from "./gjc-sdk-v3-fixture-query";
import type { SdkFixtureScenario, SdkFixtureServer, SdkFrame } from "./gjc-sdk-v3-fixture-types";

export function startSdkFixtureServer(scenario: SdkFixtureScenario): SdkFixtureServer {
	const token = "sdk-fixture-token";
	const frames: SdkFrame[] = [];
	let connections = 0;
	let gateAnswered = false;
	let sequentialGate = "gate-sequence-1";
	let promptStarted = false;
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			if (url.searchParams.get("token") !== token) return new Response("unauthorized", { status: 401 });
			return bunServer.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(socket) {
				connections += 1;
				socket.send(
					JSON.stringify({
						type: "server_hello",
						protocolVersion: scenario === "hello_failure" ? 2 : 3,
						connectionId: `c-${connections}`,
					}),
				);
			},
			message(socket, message) {
				const frame = parseFrame(message);
				frames.push(frame);
				const id = requiredString(frame, "id");
				const type = requiredString(frame, "type");
				if (type === "control_request") {
					const operation = requiredString(frame, "operation");
					if (operation === "turn.prompt") {
						promptStarted = true;
						handlePrompt(socket, id, scenario);
						return;
					}
					if (operation === "model.set") {
						socket.send(
							JSON.stringify({
								type: "control_response",
								id,
								ok: true,
								result: { provider: "future", modelId: "capable", thinkingLevel: "high" },
							}),
						);
						return;
					}
					if (operation === "workflow.gate_answer") {
						socket.send(
							JSON.stringify({ type: "control_response", id, ok: true, result: { status: "accepted" } }),
						);
						if (scenario === "workflow_gate_continuation") {
							setTimeout(() => {
								gateAnswered = true;
								socket.send(
									JSON.stringify({
										type: "turn_stream",
										sessionId: "sdk-session-created",
										phase: "finalized",
										finalAnswer: true,
										text: "continued assistant",
									}),
								);
								socket.send(
									JSON.stringify({
										type: "agent_end",
										sessionId: "sdk-session-created",
										commandId: "command-right",
										turnId: "turn-right",
									}),
								);
							}, 30);
						}
						if (scenario === "workflow_gate_sequence") {
							if (sequentialGate === "gate-sequence-1") {
								sequentialGate = "gate-sequence-2";
								socket.send(
									JSON.stringify({
										type: "action_needed",
										id: "gate-interaction:sequence-2",
										kind: "ask",
										sessionId: "sdk-session-created",
									}),
								);
							} else {
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
						return;
					}
				}
				if (type === "query_request") {
					handleQuery(
						socket,
						id,
						requiredString(frame, "query"),
						scenario,
						gateAnswered,
						sequentialGate,
						promptStarted,
					);
				}
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		token,
		get frames() {
			return frames;
		},
		get connections() {
			return connections;
		},
		stop: () => server.stop(true),
	};
}

export function expectSdkRequest(
	frames: readonly SdkFrame[],
	type: "control_request" | "query_request",
	operation: string,
): SdkFrame {
	const frame = frames.find(candidate => {
		const field = type === "control_request" ? "operation" : "query";
		return candidate.type === type && candidate[field] === operation;
	});
	expect(frame, `${type} ${operation} was not observed`).toBeDefined();
	if (frame === undefined) throw new TypeError(`${type} ${operation} was not observed`);
	return frame;
}

function parseFrame(message: string | Buffer): SdkFrame {
	const parsed: unknown = JSON.parse(String(message));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new TypeError("frame must be an object");
	return Object.fromEntries(Object.entries(parsed));
}

function requiredString(frame: SdkFrame, field: string): string {
	const value = frame[field];
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
	return value;
}
