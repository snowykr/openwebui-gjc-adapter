import type { NormalizedModelSelection } from "../contracts";
import type { GjcTurnRunner } from "../gjc/rpc-runner";
import {
	normalizeModelSelection,
	routeGjcTurn,
	type SessionMapping,
	type SessionMappingStore,
} from "../gjc/session-router";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { WorkflowGateReplyError } from "./chat-completions";
import { decodeModelCatalog, formatCanonicalModelId, parseCanonicalModelId } from "./models";
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
}

export interface NeutralModelReader {
	getAvailableModels(): Promise<readonly unknown[]>;
	getState(): Promise<unknown>;
	stop(): void;
}

export type GjcRoutingLiveGatewayRunnerResult = LiveGatewayRunnerResult & { readonly model?: string };

export interface GjcRoutingLiveGatewayRunner extends LiveGatewayRunner {
	run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult>;
}

export function createGjcRoutingLiveGatewayRunner(
	input: CreateGjcRoutingLiveGatewayRunnerInput,
): GjcRoutingLiveGatewayRunner {
	return {
		async run(turn: LiveGatewayRunnerInput): Promise<GjcRoutingLiveGatewayRunnerResult> {
			const requestedModelId = input.requestedModelId?.(turn);
			const existing = input.mappings.get(turn.chatId);
			if (
				requestedModelId !== undefined &&
				isSameProject(existing, turn) &&
				existing.operationId === turn.userMessageId
			) {
				const selection = assertBoundRequest(existing, requestedModelId, "duplicate");
				const events = projectTurnEvents(existing.events ?? []);
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

			const result = await routeGjcTurn({
				project: turn.project,
				chatId: turn.chatId,
				userMessageId: turn.userMessageId,
				parentId: turn.userMessageParentId ?? undefined,
				text: turn.prompt,
				runner: input.turnRunner,
				mappings: input.mappings,
				...(modelSelection === undefined ? {} : { modelSelection }),
			});

			input.outbox?.enqueue({
				operationId: result.mapping.operationId,
				ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
				projectId: result.mapping.projectId,
				chatId: result.mapping.chatId,
				kind: "session_mapping",
				payloadHash: buildSessionMappingPayloadHash(result.mapping),
			});

			const projectedEvents = projectTurnEvents(result.events);
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
		throw selectionError(
			branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_binding_missing",
		);
	}
	const requested = requestedModelId === "gjc" ? selection : parseCanonicalModelId(requestedModelId);
	if (requested === null || !sameSelection(selection, requested)) {
		throw selectionError(
			branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_mismatch",
		);
	}
	return selection;
}

function selectionError(
	code:
		| "model_selection_idempotency_conflict"
		| "model_selection_gate_binding_missing"
		| "model_selection_gate_mismatch",
): WorkflowGateReplyError {
	const message = {
		model_selection_idempotency_conflict: "The prior GJC model selection cannot be replayed.",
		model_selection_gate_binding_missing: "The pending workflow gate has no valid GJC model selection binding.",
		model_selection_gate_mismatch:
			"The pending workflow gate must be answered with its original GJC model selection.",
	}[code];
	return new WorkflowGateReplyError(message, code, []);
}

async function resolveNormalSelection(
	input: CreateGjcRoutingLiveGatewayRunnerInput,
	turn: LiveGatewayRunnerInput,
	requestedModelId: string,
): Promise<NormalizedModelSelection> {
	const createReader = input.createNeutralModelReader;
	if (createReader === undefined) throw new TypeError("GJC model selection reader is unavailable");
	const reader = await createReader(turn);
	try {
		const catalog = decodeModelCatalog(await reader.getAvailableModels());
		const requested =
			requestedModelId === "gjc"
				? selectionFromState(await reader.getState())
				: parseCanonicalModelId(requestedModelId);
		if (requested === null || !catalog.some(selection => sameSelection(selection, requested))) {
			throw new TypeError("GJC model selection is unavailable");
		}
		return requested;
	} finally {
		reader.stop();
	}
}

function selectionFromState(state: unknown): NormalizedModelSelection | null {
	if (typeof state !== "object" || state === null) return null;
	const model = Reflect.get(state, "model");
	if (typeof model !== "object" || model === null) return null;
	const selection = {
		provider: Reflect.get(model, "provider"),
		modelId: Reflect.get(model, "id"),
		thinkingLevel: Reflect.get(state, "thinkingLevel"),
	};
	return normalizeModelSelection(selection) ?? null;
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
