import { GjcRpcRunnerError } from "./rpc-errors";
import type { GjcRpcRunnerTransport, GjcRpcRunnerTransportEvent } from "./rpc-runner";
import { sanitizeSessionEventText, sessionEventPayload } from "./session-event-payload";

export async function promptAndCollectWorkflowGates(
	client: GjcRpcRunnerTransport,
	text: string,
	timeoutMs: number,
): Promise<readonly GjcRpcRunnerTransportEvent[]> {
	const workflowGates: GjcRpcRunnerTransportEvent[] = [];
	const unsubscribe = client.onWorkflowGate?.(gate => {
		workflowGates.push(gate);
	});
	try {
		const events = await client.promptAndWait(text, timeoutMs);
		await Promise.resolve();
		return dedupeWorkflowGateEvents([...events, ...workflowGates]);
	} catch (error) {
		await Promise.resolve();
		if (workflowGates.length > 0) return dedupeWorkflowGateEvents(workflowGates);
		throw error;
	} finally {
		unsubscribe?.();
	}
}

export function toTurnEvent(event: GjcRpcRunnerTransportEvent) {
	const payload = workflowGatePayload(event) ?? sessionEventPayload(event);
	return {
		type: event.type,
		...(eventText(event) === undefined ? {} : { text: eventText(event) }),
		...(eventId(event) === undefined ? {} : { id: eventId(event) }),
		...(payload === undefined ? {} : { payload }),
	};
}

export function callRespondGate(
	client: GjcRpcRunnerTransport,
	gateId: string,
	answer: Parameters<NonNullable<GjcRpcRunnerTransport["respondGate"]>>[1],
	idempotencyKey: string | undefined,
): Promise<unknown> {
	if (client.respondGate === undefined) {
		return Promise.reject(
			new GjcRpcRunnerError("workflow_gate_response", "RPC transport does not support workflow gates"),
		);
	}
	return client.respondGate(gateId, answer, idempotencyKey);
}

export function assertAcceptedWorkflowGateResolution(resolution: unknown): void {
	const record = recordValue(resolution);
	if (record?.status === "accepted") return;
	if (record?.status === "rejected") {
		const errorCode = workflowGateResolutionErrorCode(record.error) ?? "workflow_gate_rejected";
		throw new GjcRpcRunnerError("workflow_gate_response", errorCode);
	}
	throw new GjcRpcRunnerError("workflow_gate_response", "unexpected workflow gate response");
}

function dedupeWorkflowGateEvents(
	events: readonly GjcRpcRunnerTransportEvent[],
): readonly GjcRpcRunnerTransportEvent[] {
	const seen = new Set<string>();
	const deduped: GjcRpcRunnerTransportEvent[] = [];
	for (const event of events) {
		const key = event.type === "workflow_gate" ? workflowGateDedupeKey(event) : undefined;
		if (key !== undefined) {
			if (seen.has(key)) continue;
			seen.add(key);
		}
		deduped.push(event);
	}
	return deduped;
}

function workflowGateDedupeKey(event: GjcRpcRunnerTransportEvent): string {
	return `${event.gateId ?? event.gate_id ?? event.id ?? ""}:${event.schemaHash ?? event.schema_hash ?? ""}`;
}

function eventId(event: GjcRpcRunnerTransportEvent): string | undefined {
	return event.toolCallId ?? event.id ?? event.gateId ?? event.gate_id;
}

function eventText(event: GjcRpcRunnerTransportEvent): string | undefined {
	if (event.toolName !== undefined) return event.toolName;
	if (event.type === "message_update") return messageContentText(event.message);
	if (sessionEventPayload(event) !== undefined) return undefined;
	return messageContentText(event.message);
}

function messageContentText(value: unknown): string | undefined {
	const message = recordValue(value);
	const content = message?.content;
	if (typeof content === "string") return sanitizeSessionEventText(content);
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const item of content) {
		const block = recordValue(item);
		if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
	}
	return texts.length === 0 ? undefined : sanitizeSessionEventText(texts.join(""));
}

function workflowGatePayload(event: GjcRpcRunnerTransportEvent): Readonly<Record<string, unknown>> | undefined {
	if (event.type !== "workflow_gate") return undefined;
	const nestedPayload = recordValue(event.payload);
	const payload: Record<string, unknown> = {};
	copyPayloadField(
		payload,
		"gateId",
		event.gateId ?? event.gate_id ?? nestedPayload?.gateId ?? nestedPayload?.gate_id,
	);
	copyPayloadField(payload, "stage", event.stage ?? nestedPayload?.stage);
	copyPayloadField(payload, "kind", event.kind ?? nestedPayload?.kind);
	copyPayloadField(payload, "schema", event.schema ?? nestedPayload?.schema);
	copyPayloadField(
		payload,
		"schemaHash",
		event.schemaHash ?? event.schema_hash ?? nestedPayload?.schemaHash ?? nestedPayload?.schema_hash,
	);
	copyPayloadField(
		payload,
		"idempotencyKey",
		event.idempotencyKey ?? event.idempotency_key ?? nestedPayload?.idempotencyKey ?? nestedPayload?.idempotency_key,
	);
	copyPayloadField(payload, "options", event.options ?? nestedPayload?.options);
	copyPayloadField(payload, "context", event.context ?? nestedPayload?.context);
	copyPayloadField(payload, "status", event.status ?? nestedPayload?.status);
	copyPayloadField(payload, "required", event.required ?? nestedPayload?.required);
	copyPayloadField(
		payload,
		"createdAt",
		event.createdAt ?? event.created_at ?? nestedPayload?.createdAt ?? nestedPayload?.created_at,
	);
	return Object.keys(payload).length === 0 ? undefined : payload;
}

function workflowGateResolutionErrorCode(error: unknown): string | undefined {
	const record = recordValue(error);
	return typeof record?.code === "string" ? record.code : undefined;
}

function copyPayloadField(payload: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) payload[key] = value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
