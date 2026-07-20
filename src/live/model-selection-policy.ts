import type { NormalizedModelSelection } from "../contracts";
import { normalizeModelSelection } from "../gjc/session-router";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";
import { buildModelList, classifyGjcModelId, decodeStrictModelCatalog, type GjcModelIdClassification } from "./models";
import type { OpenAIModelListResponse } from "./openai-types";

export interface ModelSelectionPolicy {
	listModels(): Promise<OpenAIModelListResponse>;
	resolve(modelId: string): Promise<NormalizedModelSelection>;
}

export function createModelSelectionPolicy(createReader: ModelReaderFactory): ModelSelectionPolicy {
	return {
		async listModels(): Promise<OpenAIModelListResponse> {
			return withReader(
				createReader,
				async reader => {
					const rawCatalog = await reader.getAvailableModels();
					const catalog = decodeStrictModelCatalog(rawCatalog);
					if (catalog !== null) return buildModelList(catalog);
					const current = currentSelection(rawCatalog, await reader.getState());
					if (current === undefined) throw modelSelectionError("model_catalog_unavailable");
					return buildModelList([current]);
				},
				error => (isCatalogError(error) ? error : modelSelectionError("model_catalog_unavailable")),
			);
		},

		async resolve(modelId: string): Promise<NormalizedModelSelection> {
			const classified = classifyGjcModelId(modelId);
			assertSelectableSyntax(classified, modelId);
			return classified.kind === "alias"
				? resolveAlias(createReader)
				: resolveCanonical(createReader, classified.selection);
		},
	};
}

function assertSelectableSyntax(
	classified: GjcModelIdClassification,
	modelId: string,
): asserts classified is
	| { readonly kind: "alias" }
	| { readonly kind: "canonical"; readonly selection: NormalizedModelSelection } {
	if (classified.kind === "malformed") throw modelSelectionError("model_selection_invalid_id");
	if (classified.kind === "foreign") throw modelSelectionError("model_not_found", modelId);
}

async function resolveAlias(createReader: ModelReaderFactory): Promise<NormalizedModelSelection> {
	return withReader(
		createReader,
		async reader => {
			const rawCatalog = await reader.getAvailableModels();
			const catalog = decodeStrictModelCatalog(rawCatalog);
			const selection = selectionFromState(await reader.getState());
			const usable =
				selection !== undefined &&
				(catalog === null
					? isAuthoritativeCurrent(rawCatalog, selection)
					: catalog.some(candidate => sameSelection(candidate, selection)));
			if (!usable || selection === undefined) {
				throw modelSelectionError("model_selection_default_unusable");
			}
			return selection;
		},
		error => (isDefaultUnusableError(error) ? error : modelSelectionError("model_selection_default_read_failed")),
	);
}

async function resolveCanonical(
	createReader: ModelReaderFactory,
	selection: NormalizedModelSelection,
): Promise<NormalizedModelSelection> {
	return withReader(
		createReader,
		async reader => {
			const rawCatalog = await reader.getAvailableModels();
			const catalog = decodeStrictModelCatalog(rawCatalog);
			if (catalog === null) {
				const current = currentSelection(rawCatalog, await reader.getState());
				if (current !== undefined && sameSelection(current, selection)) return selection;
				throw modelSelectionError("model_catalog_unavailable");
			}
			if (!catalog.some(candidate => sameSelection(candidate, selection))) {
				throw modelSelectionError("model_selection_not_available");
			}
			return selection;
		},
		error => (isCanonicalResolutionError(error) ? error : modelSelectionError("model_selection_not_available")),
	);
}

async function withReader<T>(
	createReader: ModelReaderFactory,
	operation: (reader: ModelReader) => Promise<T>,
	mapError: (error: unknown) => ModelSelectionError,
): Promise<T> {
	let reader: ModelReader | undefined;
	let result: T;
	try {
		reader = await createReader();
		result = await operation(reader);
	} catch (error) {
		return throwAfterCleanup(reader, mapError(error));
	}
	await reader.stop();
	return result;
}

async function throwAfterCleanup(reader: ModelReader | undefined, primary: ModelSelectionError): Promise<never> {
	try {
		await reader?.stop();
	} catch (cleanup) {
		throw new ModelSelectionCleanupError(primary, cleanup);
	}
	throw primary;
}

class ModelSelectionCleanupError extends ModelSelectionError {
	override readonly cause: AggregateError;

	constructor(primary: ModelSelectionError, cleanup: unknown) {
		super(primary.code, primary.status, primary.type, primary.message);
		this.cause = new AggregateError([primary, cleanup], "GJC model selection and cleanup failed");
	}
}

function selectionFromState(state: unknown): NormalizedModelSelection | undefined {
	if (typeof state !== "object" || state === null) return undefined;
	const model = Reflect.get(state, "model");
	if (typeof model !== "object" || model === null) return undefined;
	return normalizeModelSelection({
		provider: Reflect.get(model, "provider"),
		modelId: Reflect.get(model, "id"),
		thinkingLevel: Reflect.get(state, "thinkingLevel"),
	});
}

function currentSelection(rawCatalog: readonly unknown[], state: unknown): NormalizedModelSelection | undefined {
	const selection = selectionFromState(state);
	return selection !== undefined && isAuthoritativeCurrent(rawCatalog, selection) ? selection : undefined;
}

function isAuthoritativeCurrent(rawCatalog: readonly unknown[], selection: NormalizedModelSelection): boolean {
	return isCurrentOnlyCatalog(rawCatalog) && rawCatalog.some(model => hasModelIdentity(model, selection));
}

function isCurrentOnlyCatalog(catalog: readonly unknown[]): boolean {
	return (
		catalog.length > 0 &&
		catalog.every(
			model =>
				typeof model === "object" &&
				model !== null &&
				!Array.isArray(model) &&
				!Reflect.has(model, "reasoning") &&
				!Reflect.has(model, "thinking"),
		)
	);
}

function hasModelIdentity(model: unknown, selection: NormalizedModelSelection): boolean {
	return (
		typeof model === "object" &&
		model !== null &&
		!Array.isArray(model) &&
		Reflect.get(model, "provider") === selection.provider &&
		Reflect.get(model, "id") === selection.modelId
	);
}

function sameSelection(left: NormalizedModelSelection, right: NormalizedModelSelection): boolean {
	return (
		left.provider === right.provider && left.modelId === right.modelId && left.thinkingLevel === right.thinkingLevel
	);
}

const isCatalogError = (error: unknown): error is ModelSelectionError =>
	error instanceof ModelSelectionError && error.code === "model_catalog_unavailable";
const isDefaultUnusableError = (error: unknown): error is ModelSelectionError =>
	error instanceof ModelSelectionError && error.code === "model_selection_default_unusable";
const isCanonicalResolutionError = (error: unknown): error is ModelSelectionError =>
	error instanceof ModelSelectionError &&
	(error.code === "model_selection_not_available" || error.code === "model_catalog_unavailable");
