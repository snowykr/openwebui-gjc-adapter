import type { NormalizedModelSelection } from "../contracts";
import { normalizeModelSelection } from "../gjc/session-router";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";
import {
	buildBaseModelList,
	classifyGjcModelId,
	decodeStrictModelCatalog,
	decodeStrictModelDescriptors,
	type GjcBaseModelReference,
	type GjcModelDescriptor,
	type GjcModelIdClassification,
} from "./models";
import type { OpenAIModelListResponse } from "./openai-types";

export interface ModelSelectionPolicy {
	listModels(): Promise<OpenAIModelListResponse>;
	resolve(modelId: string, reasoningEffort?: string): Promise<NormalizedModelSelection>;
}

export function createModelSelectionPolicy(createReader: ModelReaderFactory): ModelSelectionPolicy {
	return {
		async listModels(): Promise<OpenAIModelListResponse> {
			return withReader(
				createReader,
				async reader => {
					const rawCatalog = await reader.getAvailableModels();
					const stateSelection =
						selectionFromCatalogCurrent(rawCatalog) ?? selectionFromState(await reader.getState());
					const descriptors = decodeStrictModelDescriptors(rawCatalog);
					if (descriptors?.length === 0) return buildBaseModelList();
					if (descriptors !== null && stateSelection !== undefined) {
						return buildBaseModelList(advertisedDescriptors(descriptors, stateSelection));
					}
					const current = currentSelection(rawCatalog, {
						model:
							stateSelection === undefined
								? undefined
								: { provider: stateSelection.provider, id: stateSelection.modelId },
						thinkingLevel: stateSelection?.thinkingLevel,
					});
					if (current === undefined) throw modelSelectionError("model_catalog_unavailable");
					return buildBaseModelList([current]);
				},
				error => (isCatalogError(error) ? error : modelSelectionError("model_catalog_unavailable")),
			);
		},

		async resolve(modelId: string, reasoningEffort?: string): Promise<NormalizedModelSelection> {
			const classified = classifyGjcModelId(modelId);
			assertSelectableSyntax(classified, modelId);
			return classified.kind === "alias"
				? resolveAlias(createReader, reasoningEffort)
				: resolveRequestedModel(createReader, classified, reasoningEffort);
		},
	};
}

function assertSelectableSyntax(
	classified: GjcModelIdClassification,
	modelId: string,
): asserts classified is
	| { readonly kind: "alias" }
	| { readonly kind: "base"; readonly model: GjcBaseModelReference }
	| { readonly kind: "canonical"; readonly selection: NormalizedModelSelection } {
	if (classified.kind === "malformed") throw modelSelectionError("model_selection_invalid_id");
	if (classified.kind === "foreign") throw modelSelectionError("model_not_found", modelId);
}

async function resolveAlias(
	createReader: ModelReaderFactory,
	reasoningEffort?: string,
): Promise<NormalizedModelSelection> {
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
			if (reasoningEffort === undefined) return selection;
			const descriptors = decodeStrictModelDescriptors(rawCatalog);
			const descriptor = descriptors?.find(candidate => sameModel(candidate, selection));
			if (descriptor === undefined || !isAdvertisedDescriptor(descriptor, selection)) {
				throw modelSelectionError("model_selection_default_unusable");
			}
			return withThinkingLevel(descriptor, selection, reasoningEffort);
		},
		error => (isDefaultUnusableError(error) ? error : modelSelectionError("model_selection_default_read_failed")),
	);
}

async function resolveRequestedModel(
	createReader: ModelReaderFactory,
	classified:
		| { readonly kind: "base"; readonly model: GjcBaseModelReference }
		| { readonly kind: "canonical"; readonly selection: NormalizedModelSelection },
	reasoningEffort?: string,
): Promise<NormalizedModelSelection> {
	return withReader(
		createReader,
		async reader => {
			const rawCatalog = await reader.getAvailableModels();
			const descriptors = decodeStrictModelDescriptors(rawCatalog);
			if (descriptors?.length === 0) throw modelSelectionError("model_selection_not_available");
			if (descriptors !== null && classified.kind === "canonical") {
				const descriptor = descriptors.find(candidate => sameModel(candidate, classified.selection));
				if (descriptor === undefined || !isChatModelDescriptor(descriptor)) {
					throw modelSelectionError("model_selection_not_available");
				}
				return withThinkingLevel(
					descriptor,
					classified.selection,
					reasoningEffort ?? classified.selection.thinkingLevel,
				);
			}
			const stateSelection = selectionFromCatalogCurrent(rawCatalog) ?? selectionFromState(await reader.getState());
			if (descriptors === null || stateSelection === undefined) {
				const legacySelection = classified.kind === "canonical" ? classified.selection : undefined;
				const current = currentSelection(rawCatalog, {
					model:
						stateSelection === undefined
							? undefined
							: { provider: stateSelection.provider, id: stateSelection.modelId },
					thinkingLevel: stateSelection?.thinkingLevel,
				});
				if (legacySelection !== undefined && current !== undefined && sameSelection(current, legacySelection)) {
					return legacySelection;
				}
				throw modelSelectionError("model_catalog_unavailable");
			}
			const requestedModel = classified.kind === "base" ? classified.model : classified.selection;
			const descriptor = descriptors.find(candidate => sameModel(candidate, requestedModel));
			if (descriptor === undefined || !isAdvertisedDescriptor(descriptor, stateSelection)) {
				throw modelSelectionError("model_selection_not_available");
			}
			const requestedEffort =
				reasoningEffort ?? (classified.kind === "canonical" ? classified.selection.thinkingLevel : undefined);
			if (requestedEffort !== undefined) return withThinkingLevel(descriptor, requestedModel, requestedEffort);
			return {
				provider: descriptor.provider,
				modelId: descriptor.modelId,
				thinkingLevel: defaultThinkingLevel(descriptor, stateSelection),
			};
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

function selectionFromCatalogCurrent(rawCatalog: readonly unknown[]): NormalizedModelSelection | undefined {
	const current = rawCatalog.filter(
		(item): item is Readonly<Record<PropertyKey, unknown>> =>
			typeof item === "object" && item !== null && !Array.isArray(item) && Reflect.get(item, "current") === true,
	);
	if (current.length !== 1) return undefined;
	const descriptor = current[0];
	return normalizeModelSelection({
		provider: Reflect.get(descriptor, "provider"),
		modelId: Reflect.get(descriptor, "id"),
		thinkingLevel: Reflect.get(descriptor, "currentThinkingLevel"),
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

function advertisedDescriptors(
	descriptors: readonly GjcModelDescriptor[],
	current: NormalizedModelSelection,
): readonly GjcModelDescriptor[] {
	return descriptors.filter(descriptor => isAdvertisedDescriptor(descriptor, current));
}

function isAdvertisedDescriptor(descriptor: GjcModelDescriptor, current: NormalizedModelSelection): boolean {
	return descriptor.provider === current.provider && isChatModelDescriptor(descriptor);
}

function isChatModelDescriptor(descriptor: GjcModelDescriptor): boolean {
	return descriptor.modelId !== "codex-auto-review" && !descriptor.modelId.startsWith("gpt-image");
}

function withThinkingLevel(
	descriptor: GjcModelDescriptor,
	model: GjcBaseModelReference,
	reasoningEffort: string,
): NormalizedModelSelection {
	if (!descriptor.validThinkingLevels.some(level => level === reasoningEffort)) {
		throw modelSelectionError("model_selection_not_available");
	}
	return {
		provider: model.provider,
		modelId: model.modelId,
		thinkingLevel: reasoningEffort as NormalizedModelSelection["thinkingLevel"],
	};
}

function defaultThinkingLevel(
	descriptor: GjcModelDescriptor,
	current: NormalizedModelSelection,
): NormalizedModelSelection["thinkingLevel"] {
	if (sameModel(descriptor, current) && descriptor.validThinkingLevels.includes(current.thinkingLevel)) {
		return current.thinkingLevel;
	}
	if (descriptor.defaultThinkingLevel !== undefined) return descriptor.defaultThinkingLevel;
	if (descriptor.validThinkingLevels.includes(current.thinkingLevel)) return current.thinkingLevel;
	return descriptor.validThinkingLevels[0] ?? "off";
}

function sameModel(left: GjcBaseModelReference, right: GjcBaseModelReference): boolean {
	return left.provider === right.provider && left.modelId === right.modelId;
}

const isCatalogError = (error: unknown): error is ModelSelectionError =>
	error instanceof ModelSelectionError && error.code === "model_catalog_unavailable";
const isDefaultUnusableError = (error: unknown): error is ModelSelectionError =>
	error instanceof ModelSelectionError && error.code === "model_selection_default_unusable";
const isCanonicalResolutionError = (error: unknown): error is ModelSelectionError =>
	error instanceof ModelSelectionError &&
	(error.code === "model_selection_not_available" || error.code === "model_catalog_unavailable");
