import type { NormalizedModelSelection } from "../contracts";
import type { GjcTurnRunner } from "../gjc/rpc-runner";
import { GjcRpcRunnerError } from "../gjc/rpc-runner";
import {
	normalizeModelSelection,
	type RouteGjcTurnResult,
	routeGjcTurn,
	type SessionMapping,
	type SessionMappingStore,
} from "../gjc/session-router";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { modelSelectionError } from "./model-selection-errors";
import { createModelSelectionPolicy } from "./model-selection-policy";
import { formatCanonicalModelId, parseCanonicalModelId } from "./models";
import {
	buildEventPayloadHash,
	buildSessionMappingPayloadHash,
	handleWorkflowGateReply,
	latestPendingWorkflowGate,
	projectTurnEvents,
} from "./workflow-gate-turns";

export interface CreateGjcRoutingLiveGatewayRunnerInput {
	readonly turnRunner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
	readonly requestedModelId?: (turn: LiveGatewayRunnerInput) => string;
	readonly createNeutralModelReader?: (
		turn: LiveGatewayRunnerInput,
	) => NeutralModelReader | Promise<NeutralModelReader>;
	readonly modelReaderFactory?: ModelReaderFactory;
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
			const boundMapping = isSameProject(existing, turn) ? existing : undefined;
			const pendingPreflight = latestPendingWorkflowGate(boundMapping?.events ?? []);
			let boundSelection: NormalizedModelSelection | undefined;
			if (requestedModelId !== undefined && pendingPreflight !== null && boundMapping !== undefined) {
				boundSelection = assertBoundRequest(boundMapping, requestedModelId, "pending");
			}
			const gateReplyResult = await handleWorkflowGateReply(
				input,
				turn,
				pendingPreflight === null ? undefined : boundMapping,
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
					...(modelSelection === undefined ? {} : { modelSelection }),
				});
			} catch (error) {
				if (error instanceof GjcRpcRunnerError && error.command === "set_default_model_selection") {
					throw modelSelectionError("model_selection_apply_failed");
				}
				throw error;
			}

			input.outbox?.enqueue({
				operationId: result.mapping.operationId,
				ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
				projectId: result.mapping.projectId,
				chatId: result.mapping.chatId,
				kind: "session_mapping",
				payloadHash: buildSessionMappingPayloadHash(result.mapping),
			});

			const canonicalModel =
				result.mapping.modelSelection === undefined
					? undefined
					: formatCanonicalModelId(result.mapping.modelSelection);
			const projectedEvents = projectTurnEvents(result.events, canonicalModel);
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

			const pendingGate = latestPendingWorkflowGate(result.events);
			if (pendingGate !== null) {
				const gateMessage = projectPendingWorkflowGateMessage(pendingGate);
				const mapping = input.mappings.upsert({
					...result.mapping,
					assistantText: gateMessage,
				});
				input.outbox?.enqueue({
					operationId: `${mapping.operationId}:workflow_gate`,
					ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
					projectId: mapping.projectId,
					chatId: mapping.chatId,
					kind: "session_mapping",
					payloadHash: buildSessionMappingPayloadHash(mapping),
				});
				const response =
					projectedEvents.length > 0
						? { content: gateMessage, events: projectedEvents }
						: { content: gateMessage };
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

function assertBoundRequest(
	mapping: SessionMapping,
	requestedModelId: string,
	branch: "duplicate" | "pending",
): NormalizedModelSelection {
	const selection = normalizeModelSelection(mapping.modelSelection);
	if (selection === undefined) {
		throw modelSelectionError(
			branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_binding_missing",
		);
	}
	const requested = requestedModelId === "gjc" ? selection : parseCanonicalModelId(requestedModelId);
	if (requested === null || !sameSelection(selection, requested)) {
		throw modelSelectionError(
			branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_mismatch",
		);
	}
	return selection;
}

async function resolveNormalSelection(
	input: CreateGjcRoutingLiveGatewayRunnerInput,
	turn: LiveGatewayRunnerInput,
	requestedModelId: string,
): Promise<NormalizedModelSelection> {
	const createReader =
		input.modelReaderFactory ??
		(input.createNeutralModelReader === undefined ? undefined : () => input.createNeutralModelReader?.(turn));
	if (createReader === undefined) throw new TypeError("GJC model selection reader is unavailable");
	return createModelSelectionPolicy(async () => {
		const reader = await createReader();
		if (reader === undefined) throw new TypeError("GJC model selection reader is unavailable");
		return reader;
	}).resolve(requestedModelId);
}

function sameSelection(left: NormalizedModelSelection, right: NormalizedModelSelection): boolean {
	return (
		left.provider === right.provider && left.modelId === right.modelId && left.thinkingLevel === right.thinkingLevel
	);
}

function withCanonicalModel(
	result: LiveGatewayRunnerResult,
	selection: NormalizedModelSelection | undefined,
): GjcRoutingLiveGatewayRunnerResult {
	return selection === undefined ? result : { ...result, model: formatCanonicalModelId(selection) };
}
