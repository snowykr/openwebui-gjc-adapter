import type { SessionMappingStore } from "../gjc/session-router";
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
	const priorOperation = input.mappings.operation(turn.chatId, turn.userMessageId);
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
		return replayWithLifecyclePublication(input.turnRunner, turn, result.mapping, async () => {
			ensureProjectionRows(input.outbox, result.mapping, input.ownerUserId ?? "openwebui-gjc-adapter");
			const events = projectTurnEvents(
				result.events,
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
		const predecessor = input.mappings.get(turn.chatId);
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
			lifecycle =>
				publishRecoveredAcknowledgedSuccessor(
					input.mappings,
					turn,
					predecessor,
					lifecycle,
					controlOperationHash(turn),
					recovered,
				),
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
		const replayed = replayCompletedWorkflowGateReply(input, turn);
		if (replayed === null)
			throw new Error(
				`GJC workflow gate operation ${turn.userMessageId} completed without a valid immutable result binding.`,
			);
		return withCanonicalModel(replayed, result.mapping.modelSelection);
	});
}
