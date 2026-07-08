import { classifyRpcFrame } from "../gjc/rpc-frames";
import type { GjcTurnEvent, GjcTurnRunner } from "../gjc/rpc-runner";
import { routeGjcTurn, type SessionMapping, type SessionMappingStore } from "../gjc/session-router";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import { type ProjectableAgentFrame, projectAgentFrame } from "../projection/events";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import { buildProjectionPayloadHash, type OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";

export interface CreateGjcRoutingLiveGatewayRunnerInput {
	readonly turnRunner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
}

export function createGjcRoutingLiveGatewayRunner(input: CreateGjcRoutingLiveGatewayRunnerInput): LiveGatewayRunner {
	return {
		async run(turn: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> {
			const result = await routeGjcTurn({
				project: turn.project,
				chatId: turn.chatId,
				userMessageId: turn.userMessageId,
				parentId: turn.userMessageParentId ?? undefined,
				text: turn.prompt,
				runner: input.turnRunner,
				mappings: input.mappings,
			});

			input.outbox?.enqueue({
				operationId: result.mapping.operationId,
				ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
				projectId: result.mapping.projectId,
				chatId: result.mapping.chatId,
				kind: "session_mapping",
				payloadHash: buildSessionMappingPayloadHash(result.mapping),
			});

			const projectedEvents = projectTurnEvents(result.events);
			if (projectedEvents.length > 0) {
				input.outbox?.enqueue({
					operationId: `${result.mapping.operationId}:events`,
					ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
					projectId: result.mapping.projectId,
					chatId: result.mapping.chatId,
					kind: "event",
					payloadHash: buildEventPayloadHash(projectedEvents),
				});
			}

			return projectedEvents.length > 0
				? { content: result.assistantText, events: projectedEvents }
				: { content: result.assistantText };
		},
	};
}

function buildSessionMappingPayloadHash(mapping: SessionMapping): string {
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
		events: (mapping.events ?? []).map(event => ({
			type: event.type,
			text: event.text ?? null,
			id: event.id ?? null,
		})),
	});
}

function projectTurnEvents(events: readonly GjcTurnEvent[]): readonly OpenWebUIMessageEvent[] {
	const projected: OpenWebUIMessageEvent[] = [];
	for (const [index, event] of events.entries()) {
		const frame = turnEventToProjectableFrame(event);
		if (frame === null) continue;
		projected.push(...projectAgentFrame(frame, { id: `gjc-event-${index}`, created: 0, model: "gjc" }).events);
	}
	return projected;
}

function turnEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | null {
	const classified = classifyRpcFrame({ type: event.type, id: event.id, text: event.text });
	if (event.type === "message_update" || event.type === "assistant_text" || event.type === "assistant") return null;
	if (classified.kind === "workflow_gate" || event.type === "workflow_gate") {
		return {
			kind: "skill_progress",
			label: boundedText(projectPendingWorkflowGateMessage(pendingGateFromEvent(event))),
			phase: "start",
			hidden: false,
			metadata: {
				eventType: boundedText(event.type),
				gateId: boundedNullableText(
					classified.kind === "workflow_gate" ? (classified.gateId ?? event.id ?? null) : (event.id ?? null),
				),
			},
		};
	}
	if (event.type.includes("mcp")) {
		return progressFrame("mcp_progress", event);
	}
	if (event.type.includes("skill") || event.type.includes("workflow")) {
		return progressFrame("skill_progress", event);
	}
	if (event.type.includes("tool")) {
		return progressFrame("tool_progress", event);
	}
	if (event.type.includes("agent")) {
		return progressFrame("subagent_progress", event);
	}
	return {
		kind: "unsupported",
		frameType: boundedText(event.type),
		metadata: { id: boundedNullableText(event.id ?? null), textPresent: event.text !== undefined },
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

function pendingGateFromEvent(event: GjcTurnEvent) {
	return {
		gateId: event.id ?? "unknown-gate",
		schemaHash: "unknown",
		idempotencyKey: event.id ?? "unknown-gate",
		boundUserMessageId: null,
		status: "pending" as const,
		schema: { type: "string" as const },
	};
}

function buildEventPayloadHash(events: readonly OpenWebUIMessageEvent[]): string {
	return buildProjectionPayloadHash({
		eventsJson: JSON.stringify(events),
	});
}

function boundedNullableText(value: string | null): string | null {
	return value === null ? null : boundedText(value);
}

function boundedText(value: string, maxLength = 80): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
