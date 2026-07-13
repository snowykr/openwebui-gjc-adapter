import type { GjcTurnEvent, GjcTurnRunner } from "../gjc/rpc-runner";
import { getProjectSessionRoot } from "../gjc/rpc-runner";
import { ensureSdkSessionFile } from "../gjc/session-file";
import { resolveEffectiveGjcSessionRoot } from "../gjc/session-root";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import { validateSessionFile } from "../gjc/session-router";
import {
	answerFromWorkflowGateReply,
	type PendingWorkflowGate,
	pendingWorkflowGateFromEvent,
	projectPendingWorkflowGateMessage,
	resolveWorkflowGateAnswer,
	WorkflowGateStore,
} from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import { type LiveGatewayRunnerInput, type LiveGatewayRunnerResult, WorkflowGateReplyError } from "./chat-completions";
import { buildSessionMappingPayloadHash } from "./workflow-gate-projection";

export { buildEventPayloadHash, buildSessionMappingPayloadHash, projectTurnEvents } from "./workflow-gate-projection";

export interface WorkflowGateTurnDependencies {
	readonly turnRunner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
}

export async function handleWorkflowGateReply(
	input: WorkflowGateTurnDependencies,
	turn: LiveGatewayRunnerInput,
	preflightMapping?: SessionMapping,
): Promise<LiveGatewayRunnerResult | null> {
	const mapping = preflightMapping ?? input.mappings.get(turn.chatId);
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

	const sessionRoot = resolveEffectiveGjcSessionRoot(
		turn.project.cwd,
		getProjectSessionRoot(turn.project),
		input.turnRunner.resolveSessionRoot,
	);
	const existingSessionFile = await ensureSdkSessionFile(turn.project, mapping.sessionFile, sessionRoot);
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
		...(pendingGate.commandId === undefined || pendingGate.turnId === undefined || pendingGate.sessionId === undefined
			? {}
			: {
					gateCorrelation: {
						commandId: pendingGate.commandId,
						turnId: pendingGate.turnId,
						sessionId: pendingGate.sessionId,
					},
				}),
	});
	const nextPendingGate = latestPendingWorkflowGate(result.events);
	const responseText = nextPendingGate === null ? result.text : projectPendingWorkflowGateMessage(nextPendingGate);
	const nextMapping = input.mappings.upsert({
		...mapping,
		sessionFile: validateSessionFile(turn.project, result.sessionFile ?? existingSessionFile, sessionRoot),
		activeLeaf: result.activeLeaf ?? mapping.activeLeaf,
		rawFrameCursor: result.rawFrameCursor,
		eventCursor: result.eventCursor,
		operationId: turn.userMessageId,
		assistantText: responseText,
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
	return { content: responseText };
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
