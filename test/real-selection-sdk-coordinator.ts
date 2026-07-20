import { rm } from "node:fs/promises";
import { join } from "node:path";
export interface RealSelectionSdkServer {
	readonly url: string;
	readonly token: string;
	stop(): Promise<void>;
}

interface SelectionSocketData {
	readonly sessionId: string;
	readonly cwd: string;
}
interface Selection {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: string;
}

export function startRealSelectionSdkServer(coordinatorUrl: string): RealSelectionSdkServer {
	const token = "selection-sdk-token";
	let pendingGate = false;
	let pendingCorrelation: Readonly<{ commandId: string; turnId: string }> | undefined;
	let sequence = 0;
	const sessionSelections = new Map<string, Selection>();
	const server = Bun.serve<SelectionSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request, bunServer) => {
			const authority = parseAuthorityToken(new URL(request.url).searchParams.get("token"), token);
			if (authority === undefined) {
				return new Response("unauthorized", { status: 401 });
			}
			return bunServer.upgrade(request, { data: authority })
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open: socket => {
				socket.send(JSON.stringify({ type: "server_hello", protocolVersion: 3, connectionId: "selection" }));
			},
			message: (socket, message) => {
				void handleMessage(socket, String(message)).catch(error => {
					const detail = error instanceof Error ? error.message : "selection SDK fixture failure";
					socket.send(JSON.stringify({ type: "error", error: { code: "fixture_failure", message: detail } }));
				});
			},
		},
	});

	return {
		url: server.url.toString().replace(/^http/, "ws").replace(/\/$/, ""),
		token,
		stop: async () => server.stop(),
	};

	async function handleMessage(socket: Bun.ServerWebSocket<SelectionSocketData>, raw: string): Promise<void> {
		const frame = parseFrame(raw);
		const id = requiredString(frame, "id");
		const type = requiredString(frame, "type");
		if (type === "query_request") {
			await handleQuery(socket, id, requiredString(frame, "query"));
			return;
		}
		if (type === "control_request") {
			await handleControl(socket, id, requiredString(frame, "operation"), frame.input);
			return;
		}
		throw new TypeError("unsupported SDK fixture frame");
	}

	async function handleQuery(
		socket: Bun.ServerWebSocket<SelectionSocketData>,
		id: string,
		query: string,
	): Promise<void> {
		try {
			let items: readonly unknown[];
			if (query === "models.list/current") {
				const payload = await fetchRecord(`${coordinatorUrl}/catalog`);
				if (!Array.isArray(payload.models)) throw new TypeError("catalog query failed");
				const selection =
					sessionSelections.get(socket.data.sessionId) ??
					selectionFromRecord(await fetchRecord(`${coordinatorUrl}/state`));
				items = payload.models.map(item => currentModelRow(item, selection));
			} else if (query === "session.metadata") {
				items = [{ sessionId: socket.data.sessionId, cwd: socket.data.cwd, kind: "saved" }];
			} else if (query === "config.list/get") {
				items = [{}];
			} else if (query === "session.last_assistant") {
				items = [requiredString(await fetchRecord(`${coordinatorUrl}/assistant`), "text")];
			} else if (query === "workflow.gates.list") {
				items = pendingGate ? [workflowGate()] : [];
			} else {
				items = [];
			}
			socket.send(JSON.stringify({ type: "query_response", id, ok: true, page: { items, complete: true } }));
		} catch (error) {
			const message = error instanceof Error ? error.message : "query failed";
			socket.send(
				JSON.stringify({ type: "query_response", id, ok: false, error: { code: "fixture_query", message } }),
			);
		}
	}

	async function handleControl(
		socket: Bun.ServerWebSocket<SelectionSocketData>,
		id: string,
		operation: string,
		inputValue: unknown,
	): Promise<void> {
		const input = isRecord(inputValue) ? inputValue : {};
		if (operation === "model.set") {
			const model = requiredString(input, "id");
			const separator = model.indexOf("/");
			const response = await fetch(`${coordinatorUrl}/setter`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider: separator < 1 ? "" : model.slice(0, separator),
					modelId: separator < 1 ? "" : model.slice(separator + 1),
					thinkingLevel: input.thinkingLevel,
				}),
			});
			const payload: unknown = await response.json();
			if (!response.ok || !isRecord(payload) || !isRecord(payload.selection)) {
				sendFailure(socket, id, "model_set_failed", "scripted setter failure");
				return;
			}
			sessionSelections.set(socket.data.sessionId, selectionFromRecord(payload.selection));
			socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: payload.selection }));
			return;
		}
		if (operation === "thinking.set") {
			const selection =
				sessionSelections.get(socket.data.sessionId) ??
				selectionFromRecord(await fetchRecord(`${coordinatorUrl}/state`));
			const response = await fetch(`${coordinatorUrl}/setter`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider: selection.provider,
					modelId: selection.modelId,
					thinkingLevel: requiredString(input, "level"),
				}),
			});
			const payload: unknown = await response.json();
			if (!response.ok || !isRecord(payload) || !isRecord(payload.selection)) {
				sendFailure(socket, id, "thinking_set_failed", "scripted thinking setter failure");
				return;
			}
			sessionSelections.set(socket.data.sessionId, selectionFromRecord(payload.selection));
			socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: payload.selection }));
			return;
		}
		if (operation === "session.close") {
			await rm(join(socket.data.cwd, ".gjc", "state", "sdk", `${socket.data.sessionId}.json`), { force: true });
			socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: { closed: true } }));
			return;
		}
		if (operation === "turn.prompt") {
			const response = await fetch(`${coordinatorUrl}/prompt`, { method: "POST" });
			const payload: unknown = await response.json();
			if (!response.ok || !isRecord(payload) || payload.ok !== true) {
				const message =
					isRecord(payload) && typeof payload.message === "string" ? payload.message : "prompt failed";
				sendFailure(socket, id, "prompt_failed", message);
				return;
			}
			sequence += 1;
			const correlation = { commandId: `selection-command-${sequence}`, turnId: `selection-turn-${sequence}` };
			socket.send(
				JSON.stringify({ type: "control_response", id, ok: true, result: { accepted: true, ...correlation } }),
			);
			await immediate();
			if (payload.gate === true) {
				pendingGate = true;
				pendingCorrelation = correlation;
				socket.send(
					JSON.stringify({
						type: "action_needed",
						id: "gate-selection-1",
						kind: "ask",
						sessionId: socket.data.sessionId,
						...correlation,
					}),
				);
			} else {
				socket.send(JSON.stringify({ type: "agent_end", sessionId: socket.data.sessionId, ...correlation }));
			}
			return;
		}
		if (operation === "workflow.gate_answer") {
			await fetchRecord(`${coordinatorUrl}/gate`, { method: "POST" });
			pendingGate = false;
			socket.send(JSON.stringify({ type: "control_response", id, ok: true, result: { status: "accepted" } }));
			await immediate();
			if (pendingCorrelation === undefined) throw new TypeError("gate correlation is unavailable");
			socket.send(JSON.stringify({ type: "agent_end", sessionId: socket.data.sessionId, ...pendingCorrelation }));
			pendingCorrelation = undefined;
			return;
		}
		sendFailure(socket, id, "unknown_operation", operation);
	}
}

async function fetchRecord(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
	const response = await fetch(url, init);
	const payload: unknown = await response.json();
	if (!response.ok || !isRecord(payload)) throw new TypeError("coordinator request failed");
	return payload;
}
function immediate(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

function parseFrame(raw: string): Record<string, unknown> {
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value)) throw new TypeError("SDK frame must be an object");
	return value;
}

function requiredString(value: Record<string, unknown>, field: string): string {
	const fieldValue = value[field];
	if (typeof fieldValue !== "string" || fieldValue.length === 0) throw new TypeError(`${field} is required`);
	return fieldValue;
}

function sendFailure(
	socket: Bun.ServerWebSocket<SelectionSocketData>,
	id: string,
	code: string,
	message: string,
): void {
	socket.send(JSON.stringify({ type: "control_response", id, ok: false, error: { code, message } }));
}

function selectionFromRecord(value: Record<string, unknown>): Selection {
	return {
		provider: requiredString(value, "provider"),
		modelId: requiredString(value, "modelId"),
		thinkingLevel: requiredString(value, "thinkingLevel"),
	};
}
function currentModelRow(value: unknown, selection: Selection): unknown {
	if (!isRecord(value)) throw new TypeError("catalog model must be an object");
	const current = value.provider === selection.provider && value.id === selection.modelId;
	return {
		...value,
		current,
		...(current ? { currentThinkingLevel: selection.thinkingLevel } : {}),
	};
}
function parseAuthorityToken(value: string | null, expectedPrefix: string): SelectionSocketData | undefined {
	if (value === null || !value.startsWith(`${expectedPrefix}.`)) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value.slice(expectedPrefix.length + 1), "base64url").toString());
		if (!isRecord(parsed)) return undefined;
		return { sessionId: requiredString(parsed, "sessionId"), cwd: requiredString(parsed, "cwd") };
	} catch {
		return undefined;
	}
}

function workflowGate(): Record<string, unknown> {
	return {
		gate_id: "gate-selection-1",
		stage: "deep-interview",
		kind: "question",
		schema_hash: "sha256:selection-gate",
		schema: {
			type: "object",
			required: ["selected"],
			properties: { selected: { type: "array", items: { type: "string" } } },
		},
		options: [{ label: "JWT", value: "JWT" }],
		context: { prompt: "Choose authentication method" },
		created_at: "2026-07-13T00:00:00.000Z",
		required: true,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
