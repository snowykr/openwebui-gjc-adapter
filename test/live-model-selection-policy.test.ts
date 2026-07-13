import { describe, expect, test } from "bun:test";
import type { ModelReaderFactory } from "../src/live/model-reader";
import {
	MODEL_SELECTION_ERROR_CODES,
	ModelSelectionError,
	modelSelectionError,
} from "../src/live/model-selection-errors";
import { createModelSelectionPolicy } from "../src/live/model-selection-policy";
import {
	CANONICAL_MODEL_IDS,
	LOW_SELECTION,
	MODEL_DESCRIPTORS,
	staticModelReaderFactory,
} from "./model-selection-fixtures";

describe("createModelSelectionPolicy", () => {
	test("owns the complete exact ten-row public error table", () => {
		const rows = MODEL_SELECTION_ERROR_CODES.map(code => {
			const error = modelSelectionError(code, "foreign/model");
			return [error.code, error.status, error.type, error.message];
		});
		expect(rows).toEqual([
			["model_catalog_unavailable", 503, "server_error", "The current GJC model catalog could not be resolved."],
			[
				"model_selection_invalid_id",
				400,
				"invalid_request_error",
				"The GJC model id must be a canonical selection.",
			],
			["model_not_found", 404, "invalid_request_error", "Unknown GJC model: foreign/model"],
			[
				"model_selection_not_available",
				404,
				"invalid_request_error",
				"The requested GJC model selection is not available.",
			],
			[
				"model_selection_default_read_failed",
				409,
				"invalid_request_error",
				"The current GJC default model selection could not be read.",
			],
			[
				"model_selection_default_unusable",
				409,
				"invalid_request_error",
				"The current GJC default model selection is not usable.",
			],
			[
				"model_selection_apply_failed",
				409,
				"invalid_request_error",
				"The requested GJC model selection could not be applied.",
			],
			[
				"model_selection_idempotency_conflict",
				409,
				"invalid_request_error",
				"The prior GJC model selection cannot be replayed.",
			],
			[
				"model_selection_gate_binding_missing",
				409,
				"invalid_request_error",
				"The pending workflow gate has no valid GJC model selection binding.",
			],
			[
				"model_selection_gate_mismatch",
				409,
				"invalid_request_error",
				"The pending workflow gate must be answered with its original GJC model selection.",
			],
		]);
	});

	test("reads a strict catalog and stops its fresh reader", async () => {
		const transcript: string[] = [];
		const policy = createModelSelectionPolicy(staticModelReaderFactory(transcript));
		expect((await policy.listModels()).data.map(model => model.id)).toEqual([...CANONICAL_MODEL_IDS]);
		expect(transcript).toEqual(["catalog", "stop"]);
	});

	test("resolves alias through state and canonical directly through catalog", async () => {
		const aliasTranscript: string[] = [];
		expect(await createModelSelectionPolicy(staticModelReaderFactory(aliasTranscript)).resolve("gjc")).toEqual(
			LOW_SELECTION,
		);
		expect(aliasTranscript).toEqual(["catalog", "state", "stop"]);

		const canonicalTranscript: string[] = [];
		expect(
			await createModelSelectionPolicy(staticModelReaderFactory(canonicalTranscript)).resolve(
				CANONICAL_MODEL_IDS[1],
			),
		).toEqual({ ...LOW_SELECTION, thinkingLevel: "medium" });
		expect(canonicalTranscript).toEqual(["catalog", "stop"]);
	});

	test.each([
		["model_selection_invalid_id", "gjc/noncanonical"],
		["model_not_found", "foreign"],
	] as const)("rejects %s syntax without creating a reader", async (code, modelId) => {
		let readers = 0;
		const policy = createModelSelectionPolicy(async () => {
			readers += 1;
			return staticModelReaderFactory()();
		});
		await expect(policy.resolve(modelId)).rejects.toMatchObject({ code });
		expect(readers).toBe(0);
	});

	test("distinguishes malformed catalog lifecycle from a valid empty catalog", async () => {
		expect(await createModelSelectionPolicy(readerFactory([])).listModels()).toEqual({ object: "list", data: [] });
		await expect(
			createModelSelectionPolicy(readerFactory([{ provider: "broken" }])).listModels(),
		).rejects.toMatchObject({ code: "model_catalog_unavailable", status: 503 });
	});

	test.each([
		["gjc", "model_selection_default_read_failed", readerFactory(MODEL_DESCRIPTORS, new Error("state"))],
		["gjc", "model_selection_default_unusable", readerFactory(MODEL_DESCRIPTORS, {})],
		[CANONICAL_MODEL_IDS[0], "model_selection_not_available", readerFactory([])],
		[CANONICAL_MODEL_IDS[0], "model_selection_not_available", () => Promise.reject(new Error("reader unavailable"))],
	] as const)("maps %s to %s and always stops", async (modelId, code, factory) => {
		try {
			await createModelSelectionPolicy(factory).resolve(modelId);
			throw new Error("expected model selection failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelSelectionError);
			expect(error).toMatchObject({ code });
		}
	});
});

function readerFactory(catalog: readonly unknown[], state: unknown = {}): ModelReaderFactory {
	return async () => ({
		async getAvailableModels() {
			return catalog;
		},
		async getState() {
			if (state instanceof Error) throw state;
			return state;
		},
		stop() {},
	});
}
