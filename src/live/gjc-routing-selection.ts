import type { NormalizedModelSelection } from "../contracts";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import type { GjcSessionTurnRunner } from "./gjc-routing-runner";
import { normalizeModelSelection, type SessionMapping } from "../gjc/session-router";
import type { LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { formatCanonicalModelId, parseCanonicalModelId } from "./models";
import { modelSelectionError } from "./model-selection-errors";
import { createModelSelectionPolicy } from "./model-selection-policy";
import type { ModelReader, ModelReaderFactory } from "./model-reader";

export function assertBoundRequest(mapping: SessionMapping, requestedModelId: string, branch: "duplicate" | "pending"): NormalizedModelSelection {
	const selection = normalizeModelSelection(mapping.modelSelection);
	if (selection === undefined) throw modelSelectionError(branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_binding_missing");
	const requested = requestedModelId === "gjc" ? selection : parseCanonicalModelId(requestedModelId);
	if (requested === null || !sameSelection(selection, requested))
		throw modelSelectionError(branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_mismatch");
	return selection;
}

export async function resolveNormalSelection(input: { readonly modelReaderFactory?: ModelReaderFactory; readonly createNeutralModelReader?: (turn: LiveGatewayRunnerInput) => ModelReader | Promise<ModelReader> }, turn: LiveGatewayRunnerInput, requestedModelId: string): Promise<NormalizedModelSelection> {
	const createReader = input.modelReaderFactory ?? (input.createNeutralModelReader === undefined ? undefined : () => input.createNeutralModelReader?.(turn));
	if (createReader === undefined) throw new TypeError("GJC model selection reader is unavailable");
	return createModelSelectionPolicy(async () => {
		const reader = await createReader();
		if (reader === undefined) throw new TypeError("GJC model selection reader is unavailable");
		return reader;
	}).resolve(requestedModelId);
}

export async function replayWithLifecyclePublication<T>(runner: GjcSessionTurnRunner, turn: LiveGatewayRunnerInput, mapping: SessionMapping, effect: () => Promise<T>): Promise<T> {
	if (runner.withLifecyclePublication === undefined) throw new Error("GJC runner must provide lifecycle publication for immutable replay.");
	return runner.withLifecyclePublication({ cwd: turn.project.cwd, sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`, projectId: mapping.projectId, chatId: mapping.chatId, sessionId: mapping.sessionId, sessionFile: mapping.sessionFile, recoveryAttachment: mapping.attachment }, async () => effect());
}

export function withCanonicalModel(result: LiveGatewayRunnerResult, selection: NormalizedModelSelection | undefined): LiveGatewayRunnerResult & { readonly model?: string } {
	return selection === undefined ? result : { ...result, model: formatCanonicalModelId(selection) };
}

export function isModelSelectionApplyFailure(error: unknown): boolean {
	if (error instanceof SdkV3OperationError) return ["model_set_failed", "thinking_set_failed", "invalid_result"].includes(error.code);
	return typeof error === "object" && error !== null && Reflect.get(error, "command") === "set_default_model_selection";
}

function sameSelection(left: NormalizedModelSelection, right: NormalizedModelSelection): boolean { return left.provider === right.provider && left.modelId === right.modelId && left.thinkingLevel === right.thinkingLevel; }
