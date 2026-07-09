import { classifyRpcFrame } from "../gjc/rpc-frames";
import type { GjcTurnEvent, GjcTurnRunner } from "../gjc/rpc-runner";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import { validateSessionFile } from "../gjc/session-router";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import { type ProjectableAgentFrame, projectAgentFrame } from "../projection/events";
import {
	answerFromWorkflowGateReply,
	type PendingWorkflowGate,
	pendingWorkflowGateFromEvent,
	projectPendingWorkflowGateMessage,
	resolveWorkflowGateAnswer,
	WorkflowGateStore,
} from "../projection/workflow-gates";
import { buildProjectionPayloadHash, type OutboxStore } from "../state/outbox";
import { type LiveGatewayRunnerInput, type LiveGatewayRunnerResult, WorkflowGateReplyError } from "./chat-completions";

export interface WorkflowGateTurnDependencies {
	readonly turnRunner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
}

export async function handleWorkflowGateReply(
	input: WorkflowGateTurnDependencies,
	turn: LiveGatewayRunnerInput,
): Promise<LiveGatewayRunnerResult | null> {
	const mapping = input.mappings.get(turn.chatId);
	if (mapping === undefined || mapping.projectId !== turn.project.id) return null;
	const pendingGate = latestPendingWorkflowGate(mapping.events ?? []);
	if (pendingGate === null) return null;

	const answerResult = answerFromWorkflowGateReply(pendingGate, turn.prompt);
	if (!answerResult.ok) {
		throw new WorkflowGateReplyError(
			"Invalid workflow gate reply.",
			"invalid_workflow_gate_choice",
			answerResult.errors,
		);
	}

	const store = new WorkflowGateStore();
	store.add(pendingGate);
	const resolution = resolveWorkflowGateAnswer({
		store,
		answer: answerResult.answer,
		userMessageId: turn.userMessageId,
	});
	if (resolution.status !== "accepted") {
		throw new WorkflowGateReplyError(
			"Invalid workflow gate reply.",
			"invalid_workflow_gate_answer",
			resolution.errors ?? [],
		);
	}
	if (input.turnRunner.respondWorkflowGate === undefined) {
		throw new WorkflowGateReplyError(
			"This GJC runner cannot answer workflow gates.",
			"workflow_gate_response_unavailable",
			[],
		);
	}

	const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
	const existingSessionFile = validateSessionFile(turn.project, mapping.sessionFile);
	const result = await input.turnRunner.respondWorkflowGate({
		cwd: turn.project.cwd,
		sessionRoot,
		projectId: mapping.projectId,
		sessionId: mapping.sessionId,
		chatId: mapping.chatId,
		gateId: pendingGate.gateId,
		answer: answerResult.answer,
		idempotencyKey: workflowGateResponseIdempotencyKey(turn.chatId, turn.userMessageId),
		userMessageId: turn.userMessageId,
		parentId: turn.userMessageParentId ?? undefined,
		sessionFile: existingSessionFile,
		activeLeaf: mapping.activeLeaf,
		rawFrameCursor: mapping.rawFrameCursor,
		eventCursor: mapping.eventCursor,
		operationId: turn.userMessageId,
	});
	const nextMapping = input.mappings.upsert({
		...mapping,
		sessionFile: validateSessionFile(turn.project, result.sessionFile ?? existingSessionFile),
		activeLeaf: result.activeLeaf ?? mapping.activeLeaf,
		rawFrameCursor: result.rawFrameCursor,
		eventCursor: result.eventCursor,
		operationId: turn.userMessageId,
		assistantText: result.text,
		events: [...markWorkflowGateAccepted(mapping.events ?? [], pendingGate.gateId), ...result.events],
	});
	input.outbox?.enqueue({
		operationId: nextMapping.operationId,
		ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
		projectId: nextMapping.projectId,
		chatId: nextMapping.chatId,
		kind: "session_mapping",
		payloadHash: buildSessionMappingPayloadHash(nextMapping),
	});
	return { content: result.text };
}

export function latestPendingWorkflowGate(events: readonly GjcTurnEvent[]): PendingWorkflowGate | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "workflow_gate") continue;
		const gate = pendingWorkflowGateFromEvent(event);
		if (gate !== null && gate.status === "pending") return gate;
	}
	return null;
}

export function projectTurnEvents(events: readonly GjcTurnEvent[]): readonly OpenWebUIMessageEvent[] {
	const projected: OpenWebUIMessageEvent[] = [];
	for (const [index, event] of events.entries()) {
		const frame = turnEventToProjectableFrame(event);
		if (frame === null) continue;
		projected.push(...projectAgentFrame(frame, { id: `gjc-event-${index}`, created: 0, model: "gjc" }).events);
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
		events: (mapping.events ?? []).map(event => ({
			type: event.type,
			text: event.text ?? null,
			id: event.id ?? null,
			payloadJson: event.payload === undefined ? null : JSON.stringify(event.payload),
		})),
	});
}

export function buildEventPayloadHash(events: readonly OpenWebUIMessageEvent[]): string {
	return buildProjectionPayloadHash({
		eventsJson: JSON.stringify(events),
	});
}

function turnEventToProjectableFrame(event: GjcTurnEvent): ProjectableAgentFrame | null {
	const classified = classifyRpcFrame({ type: event.type, id: event.id, text: event.text });
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

function markWorkflowGateAccepted(events: readonly GjcTurnEvent[], gateId: string): readonly GjcTurnEvent[] {
	return events.map(event => {
		if (event.type !== "workflow_gate") return event;
		const gate = pendingWorkflowGateFromEvent(event);
		if (gate?.gateId !== gateId) return event;
		return {
			...event,
			payload: {
				...(event.payload ?? {}),
				status: "accepted",
			},
		};
	});
}

function workflowGateResponseIdempotencyKey(chatId: string, userMessageId: string): string {
	return `${chatId}:${userMessageId}`;
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
