import { resolve } from "node:path";
import { scopedSessionMappingStore } from "../gjc/scoped-session-mapping-store";
import type { SessionOperationGateBinding } from "../gjc/session-authority-types";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import {
	type GjcLifecycleTransaction,
	GjcTurnCancelledError,
	type GjcTurnEventObserver,
	type GjcTurnResult,
	type ManagedTurnAuthority,
} from "../gjc/turn-runner";
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
	// V3 retains each completed operation's immutable events even after the
	// current mapping advances. Verify the request against that history as well.
	const matchesResultEvents = (result.events ?? []).some(event => {
		if (event.type !== "workflow_gate") return false;
		const gate = pendingWorkflowGateFromEvent(event);
		return gate !== null && workflowGateOperationHash(turn, gate) === priorOperation.detail;
	});
	// The compact answered-gate identity independently binds the ingress hash;
	// it does not replace the immutable result events retained by V3.
	const gateBinding = result.gate;
	const matchesBinding =
		gateBinding !== undefined && workflowGateOperationHash(turn, gateBinding) === priorOperation.detail;
	if (!matchesIngress && !matchesResultEvents && !matchesBinding)
		throw new Error(
			`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
		);
	if (recordMapping !== undefined && recordMapping.operationId === turn.userMessageId)
		ensureProjectionRows(input.outbox, recordMapping, projectionOwnerUserId, principalId);
	return { content: result.assistantText };
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
	const managedAuthority = requireGateManagedAuthority(turn, mapping, principalId);
	if (pendingGate.sessionId !== undefined && pendingGate.sessionId !== managedAuthority.sessionId)
		throw new Error("Workflow gate correlation does not match the managed session authority.");
	if (lifecycle.publishManaged === undefined)
		throw new Error("Managed workflow gate response requires managed lifecycle publication.");

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
	const cancellation = {
		projectId: mapping.projectId,
		chatId: mapping.chatId,
		sessionId: mapping.sessionId,
		operationId: turn.userMessageId,
		principalId: managedAuthority.principalId,
		managedAuthority,
	};
	// The managed runner owns signal-driven terminal aborts. Sending cancelTurn
	// here would abort before dispatch or duplicate its post-dispatch abort.
	let operationBegun = false;
	let dispatchFired = false;
	try {
		throwIfAborted(turn.signal);
		mappings.beginOperation(turn.chatId, {
			id: turn.userMessageId,
			kind: "gate",
			ingressId: turn.userMessageId,
			detail: operationDetail,
		});
		operationBegun = true;
		throwIfAborted(turn.signal);
		const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
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
			rawFrameCursor: mapping.rawFrameCursor,
			eventCursor: mapping.eventCursor,
			operationId: turn.userMessageId,
			lifecycle,
			managedAuthority,
			...(observer === undefined ? {} : { observer }),
			...(turn.signal === undefined ? {} : { signal: turn.signal }),
			...(principalId === undefined ? {} : { principalId }),
			onDispatch: () => {
				dispatchFired = true;
			},
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
		throwIfAborted(turn.signal);
		assertGateManagedResult(result, managedAuthority, turn.userMessageId);
		const nextPendingGate = latestPendingWorkflowGate(result.events);
		const responseText = nextPendingGate === null ? result.text : projectPendingWorkflowGateMessage(nextPendingGate);
		// Bound the current mapping's carried history to the gate just answered
		// plus events emitted by this reply. V3 separately retains each completed
		// operation's immutable events; advancing the record never deletes them.
		const answeredGateEvent = (mapping.events ?? []).find(
			event => event.type === "workflow_gate" && pendingWorkflowGateFromEvent(event)?.gateId === pendingGate.gateId,
		);
		const carriedGateEvents =
			answeredGateEvent === undefined
				? []
				: markWorkflowGateAccepted([answeredGateEvent], pendingGate.gateId).filter(
						event => event.type === "workflow_gate",
					);
		const nextMapping: SessionMapping = {
			principalId: managedAuthority.principalId,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			sessionId: mapping.sessionId,
			rawFrameCursor: result.rawFrameCursor,
			eventCursor: result.eventCursor,
			operationId: turn.userMessageId,
			assistantText: responseText,
			events: [...carriedGateEvents, ...result.events],
			managedAuthority: result.managedAuthority,
			...(mapping.modelSelection === undefined ? {} : { modelSelection: mapping.modelSelection }),
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
		const publish = () => {
			throwIfAborted(turn.signal);
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
		};
		await lifecycle.publishManaged(result.managedProof, publish);
		const projectedEvents = projectTurnEvents(
			result.events,
			mapping.modelSelection === undefined ? undefined : formatCanonicalModelId(mapping.modelSelection),
		);
		return projectedEvents.length === 0
			? { content: responseText }
			: { content: responseText, events: projectedEvents };
	} catch (error) {
		if (operationBegun) {
			if (!dispatchFired) {
				mappings.discardPendingOperation(turn.chatId, {
					id: turn.userMessageId,
					ingressId: turn.userMessageId,
					detail: operationDetail,
				});
			} else {
				mappings.transitionOperation(turn.chatId, turn.userMessageId, "uncertain", operationDetail);
			}
		}
		throw error;
	} finally {
		input.turnRunner.clearTurnCancellation?.(cancellation);
	}
}

function requireGateManagedAuthority(
	turn: LiveGatewayRunnerInput,
	mapping: SessionMapping,
	principalId: string | undefined,
): ManagedTurnAuthority {
	const authority = mapping.managedAuthority;
	if (
		principalId === undefined ||
		mapping.principalId !== principalId ||
		mapping.chatId !== turn.chatId ||
		authority === undefined ||
		authority.principalId !== principalId ||
		authority.projectId !== turn.project.id ||
		authority.canonicalWorkspace !== resolve(turn.project.cwd) ||
		authority.chatId !== mapping.chatId ||
		authority.sessionId !== mapping.sessionId ||
		![
			authority.principalId,
			authority.projectId,
			authority.chatId,
			authority.sessionId,
			authority.leaseId,
			authority.epoch,
			authority.requestKey,
		].every(value => typeof value === "string" && value.trim().length > 0) ||
		!Number.isSafeInteger(authority.generation) ||
		authority.generation <= 0
	)
		throw new Error("Managed workflow gate requires exact principal, workspace, and session authority.");
	return Object.freeze({ ...authority });
}

function assertGateManagedResult(
	result: GjcTurnResult,
	expected: ManagedTurnAuthority,
	ingressId: string,
): asserts result is GjcTurnResult & {
	readonly managedAuthority: ManagedTurnAuthority;
	readonly managedProof: NonNullable<GjcTurnResult["managedProof"]>;
} {
	const authority = result.managedAuthority;
	const proof = result.managedProof;
	if (
		authority === undefined ||
		proof === undefined ||
		authority.principalId !== expected.principalId ||
		authority.projectId !== expected.projectId ||
		authority.canonicalWorkspace !== expected.canonicalWorkspace ||
		authority.chatId !== expected.chatId ||
		authority.sessionId !== expected.sessionId ||
		authority.generation !== expected.generation ||
		authority.leaseId !== expected.leaseId ||
		authority.epoch !== expected.epoch ||
		typeof authority.requestKey !== "string" ||
		authority.requestKey.trim().length === 0 ||
		(authority.requestKey !== expected.requestKey && authority.requestKey !== ingressId) ||
		proof.kind !== "managed-generation" ||
		proof.sessionId !== authority.sessionId ||
		proof.generation !== authority.generation ||
		proof.leaseId !== authority.leaseId ||
		proof.epoch !== authority.epoch
	)
		throw new Error("Workflow gate response did not return matching current managed authority and proof.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
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
