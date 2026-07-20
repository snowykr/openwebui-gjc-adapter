import { expect } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { handlePrompt } from "./gjc-sdk-v3-fixture-prompt";
import { handleQuery } from "./gjc-sdk-v3-fixture-query";
import type { SdkFixtureScenario, SdkFixtureServer, SdkFrame } from "./gjc-sdk-v3-fixture-types";

export function startSdkFixtureServer(scenario: SdkFixtureScenario, expectedCwd?: string): SdkFixtureServer {
	const token = "sdk-fixture-token";
	const frames: SdkFrame[] = [];
	let connections = 0;
	let gateAnswered = false;
	let sequentialGate = "gate-sequence-1";
	let promptStarted = false;
	let activeSessionId = "sdk-session-created";
	let activeSessionCwd = expectedCwd ?? process.env.GJC_SDK_FIXTURE_EXPECTED_CWD ?? "/workspace";
	let persistenceObservedBeforePrompt = false;
	let selectedModel:
		| { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string }
		| undefined;
	const server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			const url = new URL(request.url);
			const authority = parseEndpointAuthority(url.searchParams.get("token"), token);
			if (authority === undefined) return new Response("unauthorized", { status: 401 });
			if (authority !== null) {
				activeSessionId = authority.sessionId;
				activeSessionCwd = authority.cwd;
			}
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
					const input =
						typeof frame.input === "object" && frame.input !== null ? (frame.input as SdkFrame) : undefined;
					if (operation === "session.branch") {
						if (scenario !== "branch_regenerate") throw new TypeError(`unexpected branch in ${scenario}`);
						const entryId = requiredString(input ?? {}, "entryId");
						if (entryId !== "entry-q16") throw new TypeError("branch entryId must be entry-q16");
						if (server.port === undefined) throw new TypeError("fixture server has no port");
						activeSessionId = "sdk-session-successor";
						socket.send(
							JSON.stringify({
								type: "control_response",
								id,
								ok: true,
								result: { selectedText: "entry-q16", cancelled: false },
							}),
						);
						writeBranchSuccessor(server.port, token);
						return;
					}
					if (operation === "turn.prompt") {
						promptStarted = true;
						if (scenario === "branch_regenerate") persistenceObservedBeforePrompt = persistedSuccessorExists();
						if (scenario === "model_catalog") {
							socket.send(
								JSON.stringify({
									type: "control_response",
									id,
									ok: true,
									result: { accepted: true, commandId: "command-right", turnId: "turn-right" },
								}),
							);
							socket.send(
								JSON.stringify({
									type: "agent_end",
									sessionId: activeSessionId,
									commandId: "command-right",
									turnId: "turn-right",
								}),
							);
						} else {
							handlePrompt(socket, id, scenario, activeSessionId);
						}
						return;
					}
					if (operation === "model.set") {
						if (scenario === "model_catalog") selectedModel = selectedFixtureModel(input, selectedModel);
						socket.send(
							JSON.stringify({
								type: "control_response",
								id,
								ok: true,
								result:
									scenario === "model_catalog"
										? selectedModel
										: { provider: "future", modelId: "capable", thinkingLevel: "high" },
							}),
						);
						return;
					}
					if (operation === "thinking.set" && scenario === "model_catalog") {
						selectedModel = selectedFixtureThinking(input, selectedModel);
						socket.send(
							JSON.stringify({
								type: "control_response",
								id,
								ok: true,
								result: { status: "accepted" },
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
					if (operation === "session.close") {
						unlinkSync(join(activeSessionCwd, ".gjc", "state", "sdk", `${activeSessionId}.json`));
						socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: { closed: true } }));
						return;
					}
					if (scenario === "controls" || scenario === "reply_rejected") {
						const result = operation.startsWith("session.")
							? lifecycleControlResult(operation)
							: { status: "accepted", commandId: "command-right", turnId: "turn-right" };
						socket.send(JSON.stringify({ type: "control_response", id, ok: true, result }));
						if (operation.startsWith("session.")) {
							if (server.port === undefined) throw new TypeError("fixture server has no port");
							activeSessionId = lifecycleSuccessorId(operation, input);
							writeLifecycleSuccessor(activeSessionCwd, activeSessionId, server.port, token);
						} else {
							setTimeout(() => {
								socket.send(
									JSON.stringify({
										type: scenario === "reply_rejected" ? "reply_rejected" : "action_resolved",
										sessionId: "sdk-session-created",
										commandId: "command-right",
										turnId: "turn-right",
										...(typeof input?.id === "string" ? { actionId: input.id } : {}),
										...(scenario === "reply_rejected" ? { message: "fixture rejected reply" } : {}),
									}),
								);
							}, 0);
						}
						if (operation === "workflow.plan_approve") {
							setTimeout(() => {
								socket.send(
									JSON.stringify({
										type: "agent_end",
										sessionId: "sdk-session-created",
										commandId: "command-right",
										turnId: "turn-right",
									}),
								);
							}, 0);
						}
						return;
					}
				}
				if (type === "query_request") {
					const query = requiredString(frame, "query");
					if (scenario === "model_catalog" && query === "models.list/current" && selectedModel !== undefined) {
						socket.send(
							JSON.stringify({
								type: "query_response",
								id,
								ok: true,
								page: { items: [], complete: true, revision: 16 },
							}),
						);
						return;
					}
					handleQuery(
						socket,
						id,
						query,
						scenario,
						gateAnswered,
						sequentialGate,
						promptStarted,
						activeSessionId,
						activeSessionCwd,
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
		get persistenceObservedBeforePrompt() {
			return persistenceObservedBeforePrompt;
		},
		stop: () => server.stop(true),
	};
}
function parseEndpointAuthority(
	received: string | null,
	token: string,
): Readonly<{ sessionId: string; cwd: string }> | null | undefined {
	if (received === token) return null;
	if (received === null || !received.startsWith(`${token}.`)) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(received.slice(token.length + 1), "base64url").toString("utf8"));
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			typeof Reflect.get(value, "sessionId") !== "string" ||
			typeof Reflect.get(value, "cwd") !== "string"
		)
			return undefined;
		const sessionId = Reflect.get(value, "sessionId") as string;
		const cwd = Reflect.get(value, "cwd") as string;
		return sessionId.length > 0 && cwd.length > 0 ? { sessionId, cwd } : undefined;
	} catch {
		return undefined;
	}
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
function selectedFixtureModel(
	input: SdkFrame | undefined,
	current: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string } | undefined,
): { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string } | undefined {
	const id = typeof input?.id === "string" ? input.id : undefined;
	const thinkingLevel = typeof input?.thinkingLevel === "string" ? input.thinkingLevel : undefined;
	if (
		id === "anthropic/claude-sonnet-4" &&
		(thinkingLevel === "off" || thinkingLevel === "low" || thinkingLevel === "medium")
	)
		return { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel };
	if (id === "openai/gpt-5" && thinkingLevel === "off") return { provider: "openai", modelId: "gpt-5", thinkingLevel };
	return current;
}

function selectedFixtureThinking(
	input: SdkFrame | undefined,
	current: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string } | undefined,
): { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string } | undefined {
	const thinkingLevel = typeof input?.level === "string" ? input.level : undefined;
	if (
		current?.provider === "anthropic" &&
		current.modelId === "claude-sonnet-4" &&
		(thinkingLevel === "off" || thinkingLevel === "low" || thinkingLevel === "medium")
	)
		return { ...current, thinkingLevel };
	if (current?.provider === "openai" && current.modelId === "gpt-5" && thinkingLevel === "off")
		return { ...current, thinkingLevel };
	return current;
}
function lifecycleControlResult(operation: string): SdkFrame {
	if (operation === "session.new") return { created: true };
	if (operation === "session.resume") return { resumed: true };
	if (operation === "session.switch") return { switched: true };
	if (operation === "session.branch") return { selectedText: "entry-q16", cancelled: false };
	throw new TypeError(`unexpected lifecycle operation ${operation}`);
}

function lifecycleSuccessorId(operation: string, input: SdkFrame | undefined): string {
	if (operation === "session.resume" || operation === "session.switch") {
		const path = requiredString(input ?? {}, "id");
		return basename(path, ".jsonl");
	}
	return `sdk-session-${operation.slice("session.".length)}`;
}

function writeLifecycleSuccessor(cwd: string, sessionId: string, port: number, token: string): void {
	const endpointRoot = join(cwd, ".gjc", "state", "sdk");
	mkdirSync(endpointRoot, { recursive: true });
	writeFileSync(
		join(endpointRoot, `${sessionId}.json`),
		JSON.stringify({ version: 1, url: `ws://127.0.0.1:${port}`, token }),
	);
}
function writeBranchSuccessor(port: number, token: string): void {
	const root = process.env.GJC_SDK_FIXTURE_BRANCH_ROOT;
	if (root === undefined) throw new TypeError("GJC_SDK_FIXTURE_BRANCH_ROOT is required for branch fixture");
	const sessionRoot = join(root, ".gjc", "sessions");
	const endpointRoot = join(root, ".gjc", "state", "sdk");
	mkdirSync(sessionRoot, { recursive: true });
	mkdirSync(endpointRoot, { recursive: true });
	writeFileSync(
		join(sessionRoot, "sdk-session-successor.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "sdk-session-successor", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	writeFileSync(
		join(endpointRoot, "sdk-session-successor.json"),
		JSON.stringify({ version: 1, url: `ws://127.0.0.1:${port}`, token }),
	);
}
function persistedSuccessorExists(): boolean {
	const filePath = process.env.GJC_SDK_FIXTURE_MAPPING_FILE;
	if (filePath === undefined) throw new TypeError("GJC_SDK_FIXTURE_MAPPING_FILE is required for branch fixture");
	const document: unknown = JSON.parse(readFileSync(filePath, "utf8"));
	return (
		document !== null &&
		typeof document === "object" &&
		Array.isArray((document as { mappings?: unknown }).mappings) &&
		(document as { mappings: readonly unknown[] }).mappings.some(
			mapping =>
				mapping !== null &&
				typeof mapping === "object" &&
				(mapping as { sessionId?: unknown }).sessionId === "sdk-session-successor",
		)
	);
}
