export const MODEL_SELECTION_ERROR_CODES = [
	"model_catalog_unavailable",
	"model_selection_invalid_id",
	"model_not_found",
	"model_selection_not_available",
	"model_selection_default_read_failed",
	"model_selection_default_unusable",
	"model_selection_apply_failed",
	"model_selection_idempotency_conflict",
	"model_selection_gate_binding_missing",
	"model_selection_gate_mismatch",
] as const;

export type ModelSelectionErrorCode = (typeof MODEL_SELECTION_ERROR_CODES)[number];
export type ModelSelectionErrorStatus = 400 | 404 | 409 | 503;

type ErrorDefinition = {
	readonly status: ModelSelectionErrorStatus;
	readonly type: "invalid_request_error" | "server_error";
	readonly message: string;
};

const ERROR_DEFINITIONS: Readonly<Record<Exclude<ModelSelectionErrorCode, "model_not_found">, ErrorDefinition>> = {
	model_catalog_unavailable: {
		status: 503,
		type: "server_error",
		message: "The current GJC model catalog could not be resolved.",
	},
	model_selection_invalid_id: {
		status: 400,
		type: "invalid_request_error",
		message: "The GJC model id must be a canonical selection.",
	},
	model_selection_not_available: {
		status: 404,
		type: "invalid_request_error",
		message: "The requested GJC model selection is not available.",
	},
	model_selection_default_read_failed: {
		status: 409,
		type: "invalid_request_error",
		message: "The current GJC default model selection could not be read.",
	},
	model_selection_default_unusable: {
		status: 409,
		type: "invalid_request_error",
		message: "The current GJC default model selection is not usable.",
	},
	model_selection_apply_failed: {
		status: 409,
		type: "invalid_request_error",
		message: "The requested GJC model selection could not be applied.",
	},
	model_selection_idempotency_conflict: {
		status: 409,
		type: "invalid_request_error",
		message: "The prior GJC model selection cannot be replayed.",
	},
	model_selection_gate_binding_missing: {
		status: 409,
		type: "invalid_request_error",
		message: "The pending workflow gate has no valid GJC model selection binding.",
	},
	model_selection_gate_mismatch: {
		status: 409,
		type: "invalid_request_error",
		message: "The pending workflow gate must be answered with its original GJC model selection.",
	},
};

export class ModelSelectionError extends Error {
	readonly name = "ModelSelectionError";
	constructor(
		readonly code: ModelSelectionErrorCode,
		readonly status: ModelSelectionErrorStatus,
		readonly type: "invalid_request_error" | "server_error",
		message: string,
	) {
		super(message);
	}
}

export function modelSelectionError(code: ModelSelectionErrorCode, requestedModelId?: string): ModelSelectionError {
	if (code === "model_not_found") {
		return new ModelSelectionError(
			code,
			404,
			"invalid_request_error",
			`Unknown GJC model: ${requestedModelId ?? ""}`,
		);
	}
	const definition = ERROR_DEFINITIONS[code];
	return new ModelSelectionError(code, definition.status, definition.type, definition.message);
}
