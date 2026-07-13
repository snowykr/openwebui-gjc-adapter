import { classifyRpcFrame } from "../gjc/rpc-frames";
import type { GjcTurnEvent } from "../gjc/rpc-runner";
import { normalizeModelSelection, type SessionMapping } from "../gjc/session-router";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import { type ProjectableAgentFrame, projectAgentFrame } from "../projection/events";
import {
	type PendingWorkflowGate,
	pendingWorkflowGateFromEvent,
	projectPendingWorkflowGateMessage,
} from "../projection/workflow-gates";
import { buildProjectionPayloadHash } from "../state/outbox";
import { sessionEventToProjectableFrame } from "./session-event-frames";

export function projectTurnEvents(
	events: readonly GjcTurnEvent[],
	canonicalModel?: string,
): readonly OpenWebUIMessageEvent[] {
	if (canonicalModel === undefined) return [];
	const projected: OpenWebUIMessageEvent[] = [];
	for (const [index, event] of events.entries()) {
		const frame = turnEventToProjectableFrame(event);
		if (frame === null) continue;
		const frameEvents = projectAgentFrame(frame, {
			id: `gjc-event-${index}`,
			created: 0,
			model: canonicalModel,
		}).events;
		projected.push(...frameEvents.map(event => bindEventModel(event, canonicalModel)));
	}
	return projected;
}

export function buildSessionMappingPayloadHash(mapping: SessionMapping): string {
	return buildProjectionPayloadHash({
		chatId: mapping.chatId,
		projectId: mapping.projectId,
		sessionId: mapping.sessionId,
		sessionFile: mapping.sessionFile ?? null,
		activeLeaf: mapping.activeLeaf ?? null,
		rawFrameCursor: mapping.rawFrameCursor,
		eventCursor: mapping.eventCursor,
		operationId: mapping.operationId,
		assistantText: mapping.assistantText ?? null,
		modelSelection: normalizeModelSelection(mapping.modelSelection) ?? null,
		events: (mapping.events ?? []).map(event => ({
			type: event.type,
			text: event.text ?? null,
			id: event.id ?? null,
			payloadJson: event.payload === undefined ? null : JSON.stringify(event.payload),
		})),
	});
}

export function buildEventPayloadHash(events: readonly OpenWebUIMessageEvent[]): string {
	return buildProjectionPayloadHash({ eventsJson: JSON.stringify(events) });
}

function turnEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | null {
	const classified = classifyRpcFrame({ type: event.type, id: event.id, text: event.text });
	const sessionFrame = sessionEventToProjectableFrame(event);
	if (sessionFrame !== undefined) return sessionFrame;
	if (event.type === "message_update" || event.type === "assistant_text" || event.type === "assistant") return null;
	if (classified.kind === "workflow_gate" || event.type === "workflow_gate") {
		const pendingGate = pendingGateFromEvent(event);
		return {
			kind: "skill_progress",
			label: boundedText(projectPendingWorkflowGateMessage(pendingGate)),
			phase: "start",
			hidden: false,
			metadata: {
				eventType: boundedText(event.type),
				gateId: boundedNullableText(
					classified.kind === "workflow_gate" ? (classified.gateId ?? event.id ?? null) : (event.id ?? null),
				),
				workflow_gate: workflowGateStatusMetadata(pendingGate),
			},
		};
	}
	if (event.type.includes("mcp")) return progressFrame("mcp_progress", event);
	if (event.type.includes("skill") || event.type.includes("workflow")) return progressFrame("skill_progress", event);
	if (event.type.includes("tool")) return progressFrame("tool_progress", event);
	if (event.type.includes("agent")) return progressFrame("subagent_progress", event);
	return {
		kind: "unsupported",
		frameType: boundedText(event.type),
		metadata: { id: boundedNullableText(event.id ?? null), textPresent: event.text !== undefined },
	};
}

function bindEventModel(event: OpenWebUIMessageEvent, canonicalModel: string): OpenWebUIMessageEvent {
	if (event.type !== "status") return event;
	return {
		...event,
		data: {
			...event.data,
			gjc_adapter: { ...(event.data.gjc_adapter ?? {}), model: canonicalModel },
		},
	};
}

function progressFrame(
	kind: "tool_progress" | "mcp_progress" | "skill_progress" | "subagent_progress",
	event: GjcTurnEvent,
): ProjectableAgentFrame {
	return {
		kind,
		label: boundedText(event.type),
		phase: event.type.includes("end") || event.type.includes("complete") ? "end" : "progress",
		metadata: { eventType: boundedText(event.type), id: boundedNullableText(event.id ?? null) },
	};
}

function pendingGateFromEvent(event: GjcTurnEvent): PendingWorkflowGate {
	return (
		pendingWorkflowGateFromEvent(event) ?? {
			gateId: event.id ?? "unknown-gate",
			schemaHash: "unknown",
			idempotencyKey: event.id ?? "unknown-gate",
			boundUserMessageId: null,
			status: "pending",
			schema: { type: "string" },
		}
	);
}

function workflowGateStatusMetadata(gate: PendingWorkflowGate): Record<string, unknown> {
	return {
		gateId: gate.gateId,
		...(gate.stage === undefined ? {} : { stage: gate.stage }),
		...(gate.kind === undefined ? {} : { kind: gate.kind }),
		schemaHash: gate.schemaHash,
		...(gate.createdAt === undefined ? {} : { createdAt: gate.createdAt }),
		...(gate.required === undefined ? {} : { required: gate.required }),
		optionCount: gate.options?.length ?? 0,
	};
}

function boundedNullableText(value: string | null): string | null {
	return value === null ? null : boundedText(value);
}

function boundedText(value: string, maxLength = 80): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
