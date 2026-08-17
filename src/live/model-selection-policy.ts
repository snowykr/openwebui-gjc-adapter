import type { NormalizedModelSelection } from "../contracts";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import { normalizeModelSelection } from "../gjc/session-router";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import type { ModelReader, ModelReaderFactory } from "./model-reader";
import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";
import { buildModelList, classifyGjcModelId, decodeStrictModelCatalog, type GjcModelIdClassification } from "./models";
import type { OpenAIModelListResponse } from "./openai-types";

export interface ModelSelectionPolicy {
	listModels(signal?: AbortSignal): Promise<OpenAIModelListResponse>;
	resolve(modelId: string, signal?: AbortSignal): Promise<NormalizedModelSelection>;
}

export function createModelSelectionPolicy(createReader: ModelReaderFactory): ModelSelectionPolicy {
	return {
		async listModels(signal?: AbortSignal): Promise<OpenAIModelListResponse> {
			return withReader(
				createReader,
				async reader => {
					const rawCatalog = await awaitWithAbort(reader.getAvailableModels(), signal);
					const catalog = decodeStrictModelCatalog(rawCatalog);
					const activeProviders = await availableProviderIds(reader, catalog, signal);
					if (catalog !== null)
						return buildModelList(
							activeProviders === undefined
								? catalog
								: catalog.filter(selection => activeProviders.has(selection.provider)),
						);
					const current = currentSelection(rawCatalog, await awaitWithAbort(reader.getState(), signal));
					if (current === undefined || (activeProviders !== undefined && !activeProviders.has(current.provider)))
						throw modelSelectionError("model_catalog_unavailable");
					return buildModelList([current]);
				},
				error => (isCatalogError(error) ? error : modelSelectionError("model_catalog_unavailable")),
				signal,
			);
		},

		async resolve(modelId: string, signal?: AbortSignal): Promise<NormalizedModelSelection> {
			throwIfAborted(signal);
			const classified = classifyGjcModelId(modelId);
			assertSelectableSyntax(classified, modelId);
			return classified.kind === "alias"
				? resolveAlias(createReader, signal)
				: resolveCanonical(createReader, classified.selection, signal);
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

async function resolveAlias(createReader: ModelReaderFactory, signal?: AbortSignal): Promise<NormalizedModelSelection> {
	return withReader(
		createReader,
		async reader => {
			const rawCatalog = await awaitWithAbort(reader.getAvailableModels(), signal);
			const catalog = decodeStrictModelCatalog(rawCatalog);
			const activeProviders = await availableProviderIds(reader, catalog, signal);
			const selection = selectionFromState(await awaitWithAbort(reader.getState(), signal));
			const usable =
				selection !== undefined &&
				(activeProviders === undefined || activeProviders.has(selection.provider)) &&
				(catalog === null
					? isAuthoritativeCurrent(rawCatalog, selection)
					: catalog.some(candidate => sameSelection(candidate, selection)));
			if (!usable || selection === undefined) {
				throw modelSelectionError("model_selection_default_unusable");
			}
			return selection;
		},
		error => (isDefaultUnusableError(error) ? error : modelSelectionError("model_selection_default_read_failed")),
		signal,
	);
}

async function resolveCanonical(
	createReader: ModelReaderFactory,
	selection: NormalizedModelSelection,
	signal?: AbortSignal,
): Promise<NormalizedModelSelection> {
	return withReader(
		createReader,
		async reader => {
			const rawCatalog = await awaitWithAbort(reader.getAvailableModels(), signal);
			const catalog = decodeStrictModelCatalog(rawCatalog);
			const activeProviders = await availableProviderIds(reader, catalog, signal);
			if (catalog === null) {
				const current = currentSelection(rawCatalog, await awaitWithAbort(reader.getState(), signal));
				if (
					current !== undefined &&
					(activeProviders === undefined || activeProviders.has(current.provider)) &&
					sameSelection(current, selection)
				)
					return selection;
				throw modelSelectionError("model_catalog_unavailable");
			}
			if (
				(activeProviders !== undefined && !activeProviders.has(selection.provider)) ||
				!catalog.some(candidate => sameSelection(candidate, selection))
			) {
				throw modelSelectionError("model_selection_not_available");
			}
			return selection;
		},
		error => (isCanonicalResolutionError(error) ? error : modelSelectionError("model_selection_not_available")),
		signal,
	);
}

async function availableProviderIds(
	reader: ModelReader,
	catalog: readonly NormalizedModelSelection[] | null,
	signal?: AbortSignal,
): Promise<ReadonlySet<string> | undefined> {
	try {
		return activeProviderIds(await awaitWithAbort(reader.getActiveProviders(), signal));
	} catch (error) {
		if (catalog !== null && error instanceof SdkV3OperationError && error.code === "operation_not_session_owned")
			return undefined;
		throw error;
	}
}
function activeProviderIds(input: readonly unknown[]): ReadonlySet<string> {
	const providers = new Set<string>();
	for (const descriptor of input) {
		if (typeof descriptor !== "object" || descriptor === null)
			throw new TypeError("GJC active-provider catalog contains an invalid descriptor");
		const provider = Reflect.get(descriptor, "provider");
		const connectionKind = Reflect.get(descriptor, "connectionKind");
		if (
			typeof provider !== "string" ||
			provider.length === 0 ||
			(connectionKind !== "credential" && connectionKind !== "credentialless")
		) {
			throw new TypeError("GJC active-provider catalog contains an invalid descriptor");
		}
		providers.add(provider);
	}
	return providers;
}
async function withReader<T>(
	createReader: ModelReaderFactory,
	operation: (reader: ModelReader) => Promise<T>,
	mapError: (error: unknown) => ModelSelectionError,
	signal?: AbortSignal,
): Promise<T> {
	let reader: ModelReader | undefined;
	let result: T;
	try {
		throwIfAborted(signal);
		const readerPromise = Promise.resolve(createReader(undefined, signal));
		void readerPromise.then(
			lateReader => {
				if (!signal?.aborted || reader === lateReader) return;
				consumeReaderStop(lateReader);
			},
			() => undefined,
		);
		reader = await awaitWithAbort(readerPromise, signal);
		result = await operation(reader);
	} catch (error) {
		return throwAfterCleanup(reader, cancellationFor(error, signal) ?? mapError(error), signal);
	}
	try {
		await awaitWithAbort(stopReader(reader), signal);
	} catch (error) {
		if (signal?.aborted) throw new GjcTurnCancelledError();
		throw error;
	}
	throwIfAborted(signal);
	return result;
}

async function throwAfterCleanup(
	reader: ModelReader | undefined,
	primary: unknown,
	signal?: AbortSignal,
): Promise<never> {
	if (primary instanceof GjcTurnCancelledError || signal?.aborted) {
		consumeReaderStop(reader);
		throw new GjcTurnCancelledError();
	}
	try {
		await awaitWithAbort(stopReader(reader), signal);
	} catch (cleanup) {
		if (signal?.aborted) throw new GjcTurnCancelledError();
		throw new ModelSelectionCleanupError(primary as ModelSelectionError, cleanup);
	}
	if (signal?.aborted) throw new GjcTurnCancelledError();
	throw primary;
}

function stopReader(reader: ModelReader | undefined): Promise<void> {
	if (reader === undefined) return Promise.resolve();
	try {
		return Promise.resolve(reader.stop());
	} catch (error) {
		return Promise.reject(error);
	}
}

function consumeReaderStop(reader: ModelReader | undefined): void {
	void stopReader(reader).catch(() => undefined);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

function cancellationFor(error: unknown, signal?: AbortSignal): GjcTurnCancelledError | undefined {
	if (error instanceof GjcTurnCancelledError) return error;
	return signal?.aborted ? new GjcTurnCancelledError() : undefined;
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(new GjcTurnCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new GjcTurnCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				cleanup();
				resolve(value);
			},
			error => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
