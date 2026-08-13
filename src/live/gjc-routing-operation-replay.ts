import type { SessionMappingStore } from "../gjc/session-router";
import { scopedSessionMappingStore } from "../gjc/session-turn-router";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import type { GjcSessionTurnRunner } from "./gjc-routing-gateway";
import { controlOperationHash } from "./gjc-routing-publication";
import { replayWithLifecyclePublication, withCanonicalModel } from "./gjc-routing-selection";
import {
	findRecoveredAcknowledgedSuccessor,
	publishRecoveredAcknowledgedSuccessor,
} from "./gjc-routing-successor-recovery";
import { formatCanonicalModelId } from "./models";
import { ensureProjectionRows, projectTurnEvents, replayCompletedWorkflowGateReply } from "./workflow-gate-turns";

export interface RoutingOperationReplayDependencies {
	readonly turnRunner: GjcSessionTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
}

export async function replayRoutingOperation(
	input: RoutingOperationReplayDependencies,
	turn: LiveGatewayRunnerInput,
): Promise<(LiveGatewayRunnerResult & { readonly model?: string }) | null> {
	const principalId = principalIdForTurn(turn);
	const projectionOwnerUserId = principalId ?? input.ownerUserId ?? "openwebui-gjc-adapter";
	const mappings =
		principalId === undefined ? input.mappings : scopedSessionMappingStore(input.mappings, principalId, turn.chatId);
	const scopedInput = mappings === input.mappings ? input : { ...input, mappings };
	const priorOperation = mappings.operation(turn.chatId, turn.userMessageId);
	const priorAuthority =
		priorOperation === undefined ? undefined : mappings.operationAuthority(turn.chatId, turn.userMessageId);
	if (
		priorOperation !== undefined &&
		(priorAuthority === undefined ||
			"retiredAt" in priorAuthority ||
			priorAuthority.projectId !== turn.project.id ||
			(priorOperation.result !== undefined && priorOperation.result.mapping.projectId !== turn.project.id))
	)
		throw new Error(`GJC operation ${turn.userMessageId} is not authorized for project ${turn.project.id}.`);
	if (turn.control !== undefined && priorOperation?.state === "complete") {
		const result = priorOperation.result;
		if (
			result === undefined ||
			result.kind !== "control" ||
			priorOperation.detail !== controlOperationHash(turn) ||
			result.mapping.operationId !== turn.userMessageId
		)
			throw new Error(`GJC operation ${turn.userMessageId} completed without a valid immutable result binding.`);
		const selection = result.mapping.modelSelection;
		const recordMapping = mappings.get(turn.chatId);
		// Journal results no longer carry the event stream; the record mapping
		// retains it. Enqueue projection rows only for a still-CURRENT operation
		// and only from the record mapping, so payload hashes match the
		// completion-time rows (re-enqueueing an event-less journal binding
		// would conflict with them). A superseded operation's rows settle as
		// obsolete during reconciliation.
		const isCurrentReplay = recordMapping !== undefined && recordMapping.operationId === turn.userMessageId;
		return replayWithLifecyclePublication(input.turnRunner, turn, result.mapping, async () => {
			if (isCurrentReplay) ensureProjectionRows(input.outbox, recordMapping!, projectionOwnerUserId, principalId);
			const events = projectTurnEvents(
				isCurrentReplay ? (recordMapping!.events ?? []) : result.events,
				selection === undefined ? undefined : formatCanonicalModelId(selection),
			);
			return withCanonicalModel(
				events.length === 0 ? { content: result.assistantText } : { content: result.assistantText, events },
				selection,
			);
		});
	}
	if (
		turn.control?.operation === "session.new" &&
		priorOperation?.state === "uncertain" &&
		priorOperation.detail === controlOperationHash(turn)
	) {
		const predecessor = mappings.get(turn.chatId);
		if (predecessor === undefined) throw new Error(`GJC operation ${turn.userMessageId} requires reconciliation.`);
		if (input.turnRunner.withLifecyclePublication === undefined)
			throw new Error("GJC runner must provide lifecycle publication for acknowledged successor recovery.");
		const recovered = await findRecoveredAcknowledgedSuccessor(
			turn,
			predecessor,
			priorOperation,
			controlOperationHash(turn),
		);
		return input.turnRunner.withLifecyclePublication(
			{
				cwd: turn.project.cwd,
				sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`,
				projectId: predecessor.projectId,
				chatId: predecessor.chatId,
				sessionId: priorOperation.acknowledgedSuccessor?.sessionId ?? predecessor.sessionId,
				sessionFile: recovered.sessionFile,
				recoveryAttachment: recovered.attachment,
			},
			async lifecycle => {
				const published = await publishRecoveredAcknowledgedSuccessor(
					mappings,
					turn,
					predecessor,
					lifecycle,
					controlOperationHash(turn),
					recovered,
				);
				const mapping = mappings.get(turn.chatId);
				if (mapping === undefined || mapping.operationId !== turn.userMessageId)
					throw new Error(`GJC operation ${turn.userMessageId} recovery did not publish a current mapping.`);
				ensureProjectionRows(input.outbox, mapping, projectionOwnerUserId, principalId);
				return published;
			},
		);
	}
	if (turn.control !== undefined && priorOperation?.state === "pending")
		throw new Error(`GJC operation ${turn.userMessageId} is pending and cannot be replayed.`);
	if (turn.control !== undefined && (priorOperation?.state === "uncertain" || priorOperation?.state === "conflict"))
		throw new Error(`GJC operation ${turn.userMessageId} requires reconciliation.`);
	if (priorOperation?.state !== "complete" || priorOperation.kind !== "gate") return null;
	const result = priorOperation.result;
	if (result === undefined)
		throw new Error(
			`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
		);
	return replayWithLifecyclePublication(input.turnRunner, turn, result.mapping, async () => {
		const replayed = replayCompletedWorkflowGateReply(scopedInput, turn);
		if (replayed === null)
			throw new Error(
				`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
			);
		return withCanonicalModel(replayed, result.mapping.modelSelection);
	});
}
function principalIdForTurn(turn: LiveGatewayRunnerInput): string | undefined {
	const ownerUserId = turn.ownerUserId;
	return typeof ownerUserId === "string" && ownerUserId.trim().length > 0 ? ownerUserId : undefined;
}
