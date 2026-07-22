import type { NormalizedModelSelection } from "../contracts";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import { normalizeModelSelection, type SessionMapping } from "../gjc/session-router";
import type { GjcTurnRunner } from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { modelSelectionError } from "./model-selection-errors";
import { createModelSelectionPolicy } from "./model-selection-policy";
import { formatCanonicalModelId, parseBaseModelId, parseCanonicalModelId } from "./models";

export function assertBoundRequest(
	mapping: SessionMapping,
	requestedModelId: string | undefined,
	reasoningEffort: string | undefined,
	branch: "duplicate" | "pending",
): NormalizedModelSelection {
	const selection = normalizeModelSelection(mapping.modelSelection);
	if (selection === undefined)
		throw modelSelectionError(
			branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_binding_missing",
		);
	const canonical = parseCanonicalModelId(requestedModelId);
	const requested =
		requestedModelId === undefined || requestedModelId === "gjc"
			? selection
			: (canonical ?? parseBaseModelId(requestedModelId));
	const matchesModel =
		requested !== null && selection.provider === requested.provider && selection.modelId === requested.modelId;
	const requestedThinking = reasoningEffort ?? canonical?.thinkingLevel;
	const matchesThinking = requestedThinking === undefined || selection.thinkingLevel === requestedThinking;
	if (!matchesModel || !matchesThinking)
		throw modelSelectionError(
			branch === "duplicate" ? "model_selection_idempotency_conflict" : "model_selection_gate_mismatch",
		);
	return selection;
}

export async function resolveNormalSelection(
	input: {
		readonly modelReaderFactory?: ModelReaderFactory;
		readonly createNeutralModelReader?: (turn: LiveGatewayRunnerInput) => ModelReader | Promise<ModelReader>;
	},
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
	}).resolve(requestedModelId, turn.reasoningEffort);
}

export async function replayWithLifecyclePublication<T>(
	runner: GjcTurnRunner,
	turn: LiveGatewayRunnerInput,
	mapping: SessionMapping,
	effect: () => Promise<T>,
): Promise<T> {
	if (runner.withLifecyclePublication === undefined)
		throw new Error("GJC runner must provide lifecycle publication for immutable replay.");
	return runner.withLifecyclePublication(
		{
			cwd: turn.project.cwd,
			sessionRoot: turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			sessionId: mapping.sessionId,
			sessionFile: mapping.sessionFile,
			recoveryAttachment: mapping.attachment,
		},
		async () => effect(),
	);
}

export function withCanonicalModel(
	result: LiveGatewayRunnerResult,
	selection: NormalizedModelSelection | undefined,
): LiveGatewayRunnerResult & { readonly model?: string } {
	return selection === undefined ? result : { ...result, model: formatCanonicalModelId(selection) };
}

export function isModelSelectionApplyFailure(error: unknown): boolean {
	if (error instanceof SdkV3OperationError)
		return ["model_set_failed", "thinking_set_failed", "invalid_result"].includes(error.code);
	return (
		typeof error === "object" && error !== null && Reflect.get(error, "command") === "set_default_model_selection"
	);
}
