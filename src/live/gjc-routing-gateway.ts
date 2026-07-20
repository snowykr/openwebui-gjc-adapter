import type { NormalizedModelSelection } from "../contracts";
import {
	type RouteGjcTurnResult,
	routeGjcTurn,
	type SessionMapping,
	type SessionMappingStore,
} from "../gjc/session-router";
import type { GjcLifecycleTestBarrierHook } from "../gjc/turn-runner";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { runRoutingControl } from "./gjc-routing-control";
import { replayRoutingOperation } from "./gjc-routing-operation-replay";
import {
	assertBoundRequest,
	isModelSelectionApplyFailure,
	resolveNormalSelection,
	withCanonicalModel,
} from "./gjc-routing-selection";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { modelSelectionError } from "./model-selection-errors";
import { formatCanonicalModelId } from "./models";
import {
	ensureProjectionRows,
	handleWorkflowGateReply,
	latestPendingWorkflowGate,
	projectTurnEvents,
} from "./workflow-gate-turns";

export type GjcSessionTurnRunner = Parameters<typeof routeGjcTurn>[0]["runner"];
export interface CreateGjcRoutingLiveGatewayRunnerInput {
	readonly turnRunner: GjcSessionTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
	readonly requestedModelId?: (turn: LiveGatewayRunnerInput) => string;
	readonly createNeutralModelReader?: (
		turn: LiveGatewayRunnerInput,
	) => NeutralModelReader | Promise<NeutralModelReader>;
	readonly modelReaderFactory?: ModelReaderFactory;
	/** Test-only synchronization point; it never receives endpoint credentials. */ readonly testBarrierHook?: GjcLifecycleTestBarrierHook;
}

export type NeutralModelReader = ModelReader;
export type { ModelReader, ModelReaderFactory } from "./model-reader";

export type GjcRoutingLiveGatewayRunnerResult = LiveGatewayRunnerResult & { readonly model?: string };

export interface GjcRoutingLiveGatewayRunner extends LiveGatewayRunner {
	run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult>;
}

export function createGjcRoutingLiveGatewayRunner(
	input: CreateGjcRoutingLiveGatewayRunnerInput,
): GjcRoutingLiveGatewayRunner {
	return {
		async stop(): Promise<void> {
			await input.turnRunner.stop?.();
		},
		async run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult> {
			const replayedOperation = await replayRoutingOperation(input, turn);
			if (replayedOperation !== null) return replayedOperation;

			const requestedModelId = turn.requestedModelId ?? input.requestedModelId?.(turn);
			const existing = input.mappings.get(turn.chatId);
			if (
				requestedModelId !== undefined &&
				isSameProject(existing, turn) &&
				existing.operationId === turn.userMessageId
			) {
				const selection = assertBoundRequest(existing, requestedModelId, "duplicate");
				const events = projectTurnEvents(existing.events ?? [], formatCanonicalModelId(selection));
				const result =
					events.length === 0
						? { content: existing.assistantText ?? "" }
						: { content: existing.assistantText ?? "", events };
				return withCanonicalModel(result, selection);
			}
			if (turn.control !== undefined && isSameProject(existing, turn))
				return runRoutingControl(input, turn, existing);
			const boundMapping = isSameProject(existing, turn) ? existing : undefined;
			const pendingPreflight = latestPendingWorkflowGate(boundMapping?.events ?? []);
			let boundSelection: NormalizedModelSelection | undefined;
			if (pendingPreflight !== null && boundMapping !== undefined) {
				const selection = assertBoundRequest(boundMapping, requestedModelId, "pending");
				if (requestedModelId !== undefined) boundSelection = selection;
			}
			const gateReplyResult =
				pendingPreflight === null || boundMapping === undefined
					? null
					: input.turnRunner.withLifecyclePublication === undefined
						? (() => {
								throw new Error("GJC runner must provide lifecycle publication for workflow gates.");
							})()
						: await input.turnRunner.withLifecyclePublication(
								{
									cwd: turn.project.cwd,
									sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`,
									projectId: boundMapping.projectId,
									chatId: boundMapping.chatId,
									sessionId: boundMapping.sessionId,
									sessionFile: boundMapping.sessionFile,
									recoveryAttachment: boundMapping.attachment,
								},
								lifecycle => handleWorkflowGateReply(input, turn, boundMapping, lifecycle),
							);
			if (gateReplyResult !== null) return withCanonicalModel(gateReplyResult, boundSelection);
			const modelSelection =
				requestedModelId === undefined ? undefined : await resolveNormalSelection(input, turn, requestedModelId);

			let result: RouteGjcTurnResult;
			try {
				result = await routeGjcTurn({
					project: turn.project,
					chatId: turn.chatId,
					userMessageId: turn.userMessageId,
					parentId: turn.userMessageParentId ?? undefined,
					text: turn.prompt,
					runner: input.turnRunner,
					mappings: input.mappings,
					projectAssistantText: routed => {
						const pendingGate = latestPendingWorkflowGate(routed.events);
						return pendingGate === null ? routed.text : projectPendingWorkflowGateMessage(pendingGate);
					},
					afterPublish: routed =>
						ensureProjectionRows(input.outbox, routed.mapping, input.ownerUserId ?? "openwebui-gjc-adapter"),
					...(modelSelection === undefined ? {} : { modelSelection }),
				});
			} catch (error) {
				if (isModelSelectionApplyFailure(error)) throw modelSelectionError("model_selection_apply_failed");
				throw error;
			}

			const canonicalModel =
				result.mapping.modelSelection === undefined
					? undefined
					: formatCanonicalModelId(result.mapping.modelSelection);
			const projectedEvents = projectTurnEvents(result.events, canonicalModel);
			const pendingGate = latestPendingWorkflowGate(result.events);
			if (pendingGate !== null) {
				const response =
					projectedEvents.length > 0
						? { content: result.assistantText, events: projectedEvents }
						: { content: result.assistantText };
				return withCanonicalModel(response, result.mapping.modelSelection);
			}

			const response =
				projectedEvents.length > 0
					? { content: result.assistantText, events: projectedEvents }
					: { content: result.assistantText };
			return withCanonicalModel(response, result.mapping.modelSelection);
		},
	};
}

function isSameProject(mapping: SessionMapping | undefined, turn: LiveGatewayRunnerInput): mapping is SessionMapping {
	return mapping !== undefined && mapping.projectId === turn.project.id;
}
