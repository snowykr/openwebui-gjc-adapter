#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { MODEL_DESCRIPTORS } from "../model-selection-fixtures";
import {
	parseCoordinatorAssistant,
	parseCoordinatorCatalog,
	parseCoordinatorPrompt,
	parseCoordinatorSelection,
	parseCoordinatorSequence,
	parseRpcRequest,
} from "../real-selection-schemas";

const transcriptPath = process.env.GJC_SELECTION_TRANSCRIPT;
const coordinatorUrl = process.env.GJC_SELECTION_COORDINATOR_URL;
let selection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "low" };

function record(direction: "request" | "response" | "frame", payload: unknown): void {
	if (transcriptPath !== undefined) {
		appendFileSync(transcriptPath, `${JSON.stringify({ direction, payload })}\n`, "utf8");
	}
}

function write(payload: unknown, direction: "response" | "frame" = "response"): void {
	record(direction, payload);
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(request: object, command: string, data?: unknown, success = true): void {
	write({
		id: Reflect.get(request, "id"),
		type: "response",
		command,
		success,
		...(data === undefined ? {} : { data }),
	});
}

process.stdout.write('{"type":"ready"}\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
	const request = parseRpcRequest(JSON.parse(line));
	void handleRequest(request).catch(() => {
		write({
			id: Reflect.get(request, "id"),
			type: "response",
			command: Reflect.get(request, "type"),
			success: false,
			error: { message: "scripted coordinator failure" },
		});
	});
}

async function handleRequest(request: object): Promise<void> {
	record("request", request);
	const type = Reflect.get(request, "type");
	if (type === "get_available_models") {
		const models =
			coordinatorUrl === undefined
				? MODEL_DESCRIPTORS
				: parseCoordinatorCatalog(await fetchJson(`${coordinatorUrl}/catalog`));
		respond(request, type, { models });
	} else if (type === "get_state") {
		if (coordinatorUrl !== undefined) selection = await fetchSelection(`${coordinatorUrl}/state`);
		respond(request, type, {
			model: { provider: selection.provider, id: selection.modelId },
			thinkingLevel: selection.thinkingLevel,
			sessionId: "selection-session",
			messageCount: 0,
		});
	} else if (type === "set_default_model_selection") {
		const requested = {
			provider: Reflect.get(request, "provider"),
			modelId: Reflect.get(request, "modelId"),
			thinkingLevel: Reflect.get(request, "thinkingLevel"),
		};
		if (coordinatorUrl !== undefined) {
			const response = await fetch(`${coordinatorUrl}/setter`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(requested),
			});
			if (!response.ok) {
				write({
					id: Reflect.get(request, "id"),
					type: "response",
					command: type,
					success: false,
					error: { message: "scripted setter failure" },
				});
				return;
			}
			const payload: unknown = await response.json();
			selection = parseCoordinatorSelection(payload);
		} else selection = requested;
		respond(request, type, selection);
	} else if (type === "new_session" || type === "switch_session") {
		respond(request, type, { cancelled: false });
	} else if (type === "prompt") {
		const promptResult = parseCoordinatorPrompt(
			coordinatorUrl === undefined ? { ok: true, gate: false } : await postJson(`${coordinatorUrl}/prompt`, {}),
		);
		if (!promptResult.ok) {
			write({
				id: Reflect.get(request, "id"),
				type: "response",
				command: type,
				success: false,
				error: { message: promptResult.message },
			});
			return;
		}
		respond(request, type);
		if (promptResult.gate) {
			write({
				type: "workflow_gate",
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
			});
		} else {
			const sequence =
				coordinatorUrl === undefined
					? 1
					: parseCoordinatorSequence(await postJson(`${coordinatorUrl}/sequence`, {}));
			write(
				{
					type: "event",
					protocol_version: 2,
					session_id: "selection-session",
					seq: sequence,
					frame_id: `selection-frame-${sequence}`,
					payload: {
						event_type: "agent_end",
						event: { type: "agent_end", messages: [], stopReason: "completed" },
					},
				},
				"frame",
			);
		}
	} else if (type === "workflow_gate_response") {
		if (coordinatorUrl !== undefined) parseCoordinatorPrompt(await postJson(`${coordinatorUrl}/gate`, request));
		respond(request, type, {
			gate_id: Reflect.get(request, "gate_id"),
			status: "accepted",
			answer_hash: "sha256:selection-answer",
			resolved_at: "2026-07-13T00:00:00.000Z",
		});
	} else if (type === "get_last_assistant_text") {
		const text =
			coordinatorUrl === undefined
				? "selection fixture assistant"
				: parseCoordinatorAssistant(await fetchJson(`${coordinatorUrl}/assistant`));
		respond(request, type, { text });
	}
}

async function fetchSelection(url: string): Promise<typeof selection> {
	return parseCoordinatorSelection(await fetchJson(url));
}

async function fetchJson(url: string): Promise<object> {
	const response = await fetch(url);
	if (!response.ok) throw new Error("coordinator request failed");
	const value: unknown = await response.json();
	if (typeof value !== "object" || value === null) throw new TypeError("invalid coordinator response");
	return value;
}

async function postJson(url: string, value: unknown): Promise<object> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null) throw new TypeError("invalid coordinator response");
	return payload;
}
