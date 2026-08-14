import type { SessionOperationGateBinding } from "../gjc/session-authority-types";
import { ensureSdkSessionFile } from "../gjc/session-file";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import { validateSessionFile } from "../gjc/session-router";
import { scopedSessionMappingStore } from "../gjc/session-turn-router";
import type { GjcLifecycleTransaction, GjcTurnEvent, GjcTurnEventObserver } from "../gjc/turn-runner";
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
import type { GjcSessionTurnRunner } from "./gjc-routing-runner";
import { formatCanonicalModelId } from "./models";
import { composeThinkingAssistantContent } from "./session-event-frames";
import { ensureProjectionRows, projectTurnEvents } from "./workflow-gate-projection";
import {
	markWorkflowGateAccepted,
	workflowGateOperationHash,
	workflowGateResponseIdempotencyKey,
} from "./workflow-gate-turn-utils";

export {
	buildEventPayloadHash,
	buildSessionMappingPayloadHash,
	ensureProjectionRows,
	projectTurnEvents,
} from "./workflow-gate-projection";

export interface WorkflowGateTurnDependencies {
	readonly turnRunner: GjcSessionTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
}
export function replayCompletedWorkflowGateReply(
	input: WorkflowGateTurnDependencies,
	turn: LiveGatewayRunnerInput,
): LiveGatewayRunnerResult | null {
	const principalId = principalIdForTurn(turn);
	const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
	const mappings =
		principalId === undefined ? input.mappings : scopedSessionMappingStore(input.mappings, principalId, turn.chatId);
	const priorOperation = mappings.operation(turn.chatId, turn.userMessageId);
	if (priorOperation?.state !== "complete" || priorOperation.kind !== "gate") return null;
	const result = priorOperation.result;
	if (result?.kind !== "control" || result.mapping.operationId !== turn.userMessageId)
		throw new Error(
			`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
		);
	const recordMapping = mappings.get(turn.chatId);
	const matchesIngress = (recordMapping?.events ?? []).some(event => {
		if (event.type !== "workflow_gate") return false;
		const gate = pendingWorkflowGateFromEvent(event);
		return gate !== null && workflowGateOperationHash(turn, gate) === priorOperation.detail;
	});
	// The completed operation's own result may still carry the gate event in
	// legacy documents (before compaction strips result event arrays); recompute
	// the request hash from it as well.
	const matchesLegacyResult = (result.events ?? []).some(event => {
		if (event.type !== "workflow_gate") return false;
		const gate = pendingWorkflowGateFromEvent(event);
		return gate !== null && workflowGateOperationHash(turn, gate) === priorOperation.detail;
	});
	// New documents discard the gate event once the operation is superseded, but
	// bind the compact answered-gate identity on the durable result, so the
	// request hash can still be recomputed and compared against the stored
	// detail. Without a matching binding the replay is a conflicting ingress
	// even when the operation is no longer the record's current one.
	const gateBinding = result.gate;
	const matchesBinding =
		gateBinding !== undefined && workflowGateOperationHash(turn, gateBinding) === priorOperation.detail;
	if (!matchesIngress && !matchesLegacyResult && !matchesBinding)
		throw new Error(
			`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
		);
	if (recordMapping !== undefined && recordMapping.operationId === turn.userMessageId)
		ensureProjectionRows(input.outbox, recordMapping, projectionOwnerUserId, principalId);
	return {
		content: composeThinkingAssistantContent(
			result.assistantText,
			gateReplyEvents(recordMapping?.events ?? result.events),
		),
	};
}
/**
 * The persisted gate operation events are the accepted preflight history
 * (which ends with the accepted workflow-gate event) followed by the gate
 * answer's own events. Content composition must use only the answer events so
 * older thinking from the turn that opened the gate is not replayed into the
 * gate answer.
 */
function gateReplyEvents(events: readonly GjcTurnEvent[] | undefined): readonly GjcTurnEvent[] {
	if (events === undefined) return [];
	let lastAcceptedGate = -1;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (
			event?.type === "workflow_gate" &&
			typeof event.payload?.status === "string" &&
			event.payload.status === "accepted"
		) {
			lastAcceptedGate = index;
		}
	}
	return lastAcceptedGate === -1 ? events : events.slice(lastAcceptedGate + 1);
}
export async function handleWorkflowGateReply(
	input: WorkflowGateTurnDependencies,
	turn: LiveGatewayRunnerInput,
	preflightMapping: SessionMapping | undefined,
	lifecycle: GjcLifecycleTransaction,
	observer?: GjcTurnEventObserver,
): Promise<LiveGatewayRunnerResult | null> {
	const principalId = principalIdForTurn(turn);
	const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
	const mappings =
		principalId === undefined ? input.mappings : scopedSessionMappingStore(input.mappings, principalId, turn.chatId);
	if (
		principalId !== undefined &&
		preflightMapping !== undefined &&
		(preflightMapping.principalId === undefined || preflightMapping.principalId !== principalId)
	)
		throw new Error(`GJC workflow gate mapping for ${turn.chatId} is not bound to the requested principal.`);
	const mapping = preflightMapping ?? mappings.get(turn.chatId);
	if (
		principalId !== undefined &&
		mapping !== undefined &&
		(mapping.principalId === undefined || mapping.principalId !== principalId)
	)
		throw new Error(`GJC workflow gate mapping for ${turn.chatId} is not bound to the requested principal.`);
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
	const operationDetail = workflowGateOperationHash(turn, pendingGate);
	const priorOperation = mappings.operation(turn.chatId, turn.userMessageId);
	if (priorOperation?.state === "complete") {
		if (
			priorOperation.detail !== operationDetail ||
			priorOperation.result?.kind !== "control" ||
			priorOperation.result.mapping.operationId !== turn.userMessageId
		) {
			throw new Error(
				`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
			);
		}
		// The completed operation's rows were enqueued at completion from the
		// published record mapping; only re-enqueue when it is still current.
		if (mapping.operationId === turn.userMessageId)
			ensureProjectionRows(input.outbox, mapping, projectionOwnerUserId, principalId);
		return { content: priorOperation.result.assistantText };
	}
	if (
		priorOperation?.state === "pending" ||
		priorOperation?.state === "uncertain" ||
		priorOperation?.state === "conflict"
	) {
		throw new Error(`GJC workflow gate operation ${turn.userMessageId} requires reconciliation.`);
	}
	mappings.beginOperation(turn.chatId, {
		id: turn.userMessageId,
		kind: "gate",
		ingressId: turn.userMessageId,
		detail: operationDetail,
	});

	try {
		const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
		const existingSessionFile = await ensureSdkSessionFile(
			turn.project,
			mapping.sessionFile,
			sessionRoot,
			mapping.sessionId,
		);
		const result = await input.turnRunner.respondWorkflowGate({
			cwd: turn.project.cwd,
			sessionRoot,
			projectId: mapping.projectId,
			sessionId: mapping.sessionId,
			chatId: mapping.chatId,
			gateId: pendingGate.gateId,
			answer: answerResult.answer,
			promptText: turn.prompt,
			idempotencyKey: workflowGateResponseIdempotencyKey(turn.chatId, turn.userMessageId),
			userMessageId: turn.userMessageId,
			parentId: turn.userMessageParentId ?? undefined,
			sessionFile: existingSessionFile,
			recoveryAttachment: mapping.attachment,
			activeLeaf: mapping.activeLeaf,
			rawFrameCursor: mapping.rawFrameCursor,
			eventCursor: mapping.eventCursor,
			operationId: turn.userMessageId,
			lifecycle,
			...(observer === undefined ? {} : { observer }),
			...(pendingGate.commandId === undefined ||
			pendingGate.turnId === undefined ||
			pendingGate.sessionId === undefined
				? {}
				: {
						gateCorrelation: {
							commandId: pendingGate.commandId,
							turnId: pendingGate.turnId,
							sessionId: pendingGate.sessionId,
						},
					}),
		});
		if (result.attachment === undefined) {
			throw new Error("Workflow gate response did not return a validated current GJC attachment.");
		}
		const nextPendingGate = latestPendingWorkflowGate(result.events);
		const responseText = nextPendingGate === null ? result.text : projectPendingWorkflowGateMessage(nextPendingGate);
		// Bound the carried gate history: retain only the gate event just answered
		// (needed to verify replays of THIS operation against its durable detail
		// binding) plus any gates emitted by this reply; accepted gates from
		// earlier chain steps are dropped, so a chain of N gates keeps O(1) gate
		// payloads instead of N full schemas and options.
		const answeredGateEvent = (mapping.events ?? []).find(
			event => event.type === "workflow_gate" && pendingWorkflowGateFromEvent(event)?.gateId === pendingGate.gateId,
		);
		const carriedGateEvents =
			answeredGateEvent === undefined
				? []
				: markWorkflowGateAccepted([answeredGateEvent], pendingGate.gateId).filter(
						event => event.type === "workflow_gate",
					);
		const nextMapping = {
			...mapping,
			sessionFile: validateSessionFile(turn.project, result.sessionFile ?? existingSessionFile, sessionRoot),
			activeLeaf: result.activeLeaf ?? mapping.activeLeaf,
			rawFrameCursor: result.rawFrameCursor,
			eventCursor: result.eventCursor,
			operationId: turn.userMessageId,
			assistantText: responseText,
			events: [...carriedGateEvents, ...result.events],
			attachment: result.attachment,
		};
		// Compact answered-gate identity (no schema/options/context payload), so a
		// replay can still recompute the durable request hash even after the gate
		// event is no longer retained on the record.
		const gateBinding: SessionOperationGateBinding = {
			gateId: pendingGate.gateId,
			...(pendingGate.commandId === undefined ||
			pendingGate.turnId === undefined ||
			pendingGate.sessionId === undefined
				? {}
				: {
						commandId: pendingGate.commandId,
						turnId: pendingGate.turnId,
						sessionId: pendingGate.sessionId,
					}),
		};
		await lifecycle.publish(result.attachment, () => {
			const published = mappings.completeOperationWithMapping(
				turn.chatId,
				turn.userMessageId,
				operationDetail,
				nextMapping,
				"control",
				gateBinding,
			);
			ensureProjectionRows(input.outbox, published, projectionOwnerUserId, principalId);
			return published;
		});
		const projectedEvents = projectTurnEvents(
			result.events,
			mapping.modelSelection === undefined ? undefined : formatCanonicalModelId(mapping.modelSelection),
		);
		return projectedEvents.length === 0
			? { content: responseText }
			: { content: responseText, events: projectedEvents };
	} catch (error) {
		mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", operationDetail);
		throw error;
	}
}

function principalIdForTurn(turn: LiveGatewayRunnerInput): string | undefined {
	const ownerUserId = turn.ownerUserId;
	if (typeof ownerUserId !== "string") return undefined;
	const principalId = ownerUserId.trim();
	return principalId.length === 0 ? undefined : principalId;
}

export function latestPendingWorkflowGate(events: NonNullable<SessionMapping["events"]>): PendingWorkflowGate | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "workflow_gate") continue;
		const gate = pendingWorkflowGateFromEvent(event);
		if (gate !== null && gate.status === "pending") return gate;
	}
	return null;
}
