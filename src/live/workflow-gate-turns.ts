import { ensureSdkSessionFile } from "../gjc/session-file";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import { validateSessionFile } from "../gjc/session-router";
import type { GjcLifecycleTransaction } from "../gjc/turn-runner";
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
import { ensureProjectionRows } from "./workflow-gate-projection";
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
	const priorOperation = input.mappings.operation(turn.chatId, turn.userMessageId);
	if (priorOperation?.state !== "complete" || priorOperation.kind !== "gate") return null;
	const result = priorOperation.result;
	if (result?.kind !== "control" || result.mapping.operationId !== turn.userMessageId)
		throw new Error(
			`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
		);
	const matchesIngress = result.events.some(event => {
		if (event.type !== "workflow_gate") return false;
		const gate = pendingWorkflowGateFromEvent(event);
		return gate !== null && workflowGateOperationHash(turn, gate) === priorOperation.detail;
	});
	if (!matchesIngress)
		throw new Error(
			`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
		);
	ensureProjectionRows(
		input.outbox,
		{
			...result.mapping,
			operationId: turn.userMessageId,
			assistantText: result.assistantText,
			events: result.events,
		},
		input.ownerUserId ?? "openwebui-gjc-adapter",
	);
	return { content: result.assistantText };
}
export async function handleWorkflowGateReply(
	input: WorkflowGateTurnDependencies,
	turn: LiveGatewayRunnerInput,
	preflightMapping: SessionMapping,
	lifecycle: GjcLifecycleTransaction,
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
	const operationDetail = workflowGateOperationHash(turn, pendingGate);
	const priorOperation = input.mappings.operation(turn.chatId, turn.userMessageId);
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
		ensureProjectionRows(
			input.outbox,
			{
				...priorOperation.result.mapping,
				operationId: turn.userMessageId,
				assistantText: priorOperation.result.assistantText,
				events: priorOperation.result.events,
			},
			input.ownerUserId ?? "openwebui-gjc-adapter",
		);
		return { content: priorOperation.result.assistantText };
	}
	if (
		priorOperation?.state === "pending" ||
		priorOperation?.state === "uncertain" ||
		priorOperation?.state === "conflict"
	) {
		throw new Error(`GJC workflow gate operation ${turn.userMessageId} requires reconciliation.`);
	}
	input.mappings.beginOperation(turn.chatId, {
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
		const nextMapping = {
			...mapping,
			sessionFile: validateSessionFile(turn.project, result.sessionFile ?? existingSessionFile, sessionRoot),
			activeLeaf: result.activeLeaf ?? mapping.activeLeaf,
			rawFrameCursor: result.rawFrameCursor,
			eventCursor: result.eventCursor,
			operationId: turn.userMessageId,
			assistantText: responseText,
			events: [...markWorkflowGateAccepted(mapping.events ?? [], pendingGate.gateId), ...result.events],
			attachment: result.attachment,
		};
		await lifecycle.publish(result.attachment, () => {
			const published = input.mappings.completeOperationWithMapping(
				turn.chatId,
				turn.userMessageId,
				operationDetail,
				nextMapping,
				"control",
			);
			ensureProjectionRows(input.outbox, published, input.ownerUserId ?? "openwebui-gjc-adapter");
			return published;
		});
		return { content: responseText };
	} catch (error) {
		input.mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", operationDetail);
		throw error;
	}
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
