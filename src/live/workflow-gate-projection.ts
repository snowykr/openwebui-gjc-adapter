import { classifySessionFrame } from "../gjc/session-frames";
import { normalizeModelSelection, type SessionMapping, type SessionMappingStore } from "../gjc/session-router";
import type { GjcTurnEvent } from "../gjc/turn-runner";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import { type ProjectableAgentFrame, projectAgentFrame } from "../projection/events";
import {
	type PendingWorkflowGate,
	pendingWorkflowGateFromEvent,
	projectPendingWorkflowGateMessage,
} from "../projection/workflow-gates";
import {
	buildProjectionPayloadHash,
	type EnqueueProjectionOperationInput,
	type OutboxStore,
	type ProjectionOperation,
} from "../state/outbox";
import type { ProjectionOperationApplier } from "../state/reconciler";
import { formatCanonicalModelId } from "./models";
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
		projected.push(...frameEvents);
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

export function expectedProjectionRows(
	mapping: SessionMapping,
	ownerUserId: string,
): readonly EnqueueProjectionOperationInput[] {
	const events = projectedMappingEvents(mapping);
	return [
		{
			operationId: mapping.operationId,
			ownerUserId,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			kind: "session_mapping",
			payloadHash: buildSessionMappingPayloadHash(mapping),
		},
		{
			operationId: `${mapping.operationId}:event`,
			ownerUserId,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			kind: "event",
			payloadHash: buildEventPayloadHash(events),
		},
	];
}

export function ensureProjectionRows(
	outbox: OutboxStore | undefined,
	mapping: SessionMapping,
	ownerUserId: string,
): void {
	for (const row of expectedProjectionRows(mapping, ownerUserId)) outbox?.enqueue(row);
}
export function synthesizeProjectionRows(
	outbox: OutboxStore,
	mappings: SessionMappingStore,
	ownerUserId: string,
): void {
	for (const mapping of mappings.entries()) {
		const operation = mappings.operation(mapping.chatId, mapping.operationId);
		if (operation?.state !== "complete" || operation.result?.mapping.operationId !== mapping.operationId) continue;
		ensureProjectionRows(
			outbox,
			{
				...operation.result.mapping,
				assistantText: operation.result.assistantText,
				events: operation.result.events,
			},
			ownerUserId,
		);
	}
}

export interface ProjectionSessionSynchronizer {
	syncLinkedProject(projectId: string): Promise<unknown>;
}

export function createProjectionOperationApplier(
	mappings: SessionMappingStore,
	synchronizer: ProjectionSessionSynchronizer,
): ProjectionOperationApplier {
	return async (operation: ProjectionOperation) => {
		const mapping = projectionMapping(mappings, operation);
		const expected = expectedProjectionRows(mapping, operation.ownerUserId).find(row => row.kind === operation.kind);
		if (
			expected === undefined ||
			expected.operationId !== operation.operationId ||
			expected.projectId !== operation.projectId ||
			expected.chatId !== operation.chatId ||
			expected.payloadHash !== operation.payloadHash
		) {
			throw new Error(`Projection operation ${operation.operationId} does not match a durable session mapping`);
		}
		await synchronizer.syncLinkedProject(mapping.projectId);
	};
}

function projectionMapping(mappings: SessionMappingStore, operation: ProjectionOperation): SessionMapping {
	const operationId =
		operation.kind === "event" ? operation.operationId.slice(0, -":event".length) : operation.operationId;
	const recorded = mappings.operation(operation.chatId, operationId);
	if (recorded !== undefined) {
		if (
			recorded.state !== "complete" ||
			recorded.result === undefined ||
			recorded.result.mapping.operationId !== operationId
		)
			throw new Error(`Projection operation ${operation.operationId} has no completed durable result`);
		return {
			...recorded.result.mapping,
			assistantText: recorded.result.assistantText,
			events: recorded.result.events,
		};
	}
	const mapping = mappings.get(operation.chatId);
	if (mapping === undefined || mapping.operationId !== operationId)
		throw new Error(`Projection operation ${operation.operationId} has no durable session mapping`);
	return mapping;
}

function projectedMappingEvents(mapping: SessionMapping): readonly OpenWebUIMessageEvent[] {
	const selection = normalizeModelSelection(mapping.modelSelection);
	return projectTurnEvents(
		mapping.events ?? [],
		selection === undefined ? undefined : formatCanonicalModelId(selection),
	);
}

function turnEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | null {
	const classified = classifySessionFrame({ type: event.type, id: event.id, text: event.text });
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
	if (event.type === "message_start") {
		return {
			kind: "unsupported",
			eventType: boundedText(event.type),
			id: boundedNullableText(event.id ?? null),
			textPresent: event.text !== undefined,
		};
	}
	return {
		kind: "unsupported",
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
