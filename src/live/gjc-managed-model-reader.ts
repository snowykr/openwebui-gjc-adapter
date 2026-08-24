import { resolve } from "node:path";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import { decodeRouterPage } from "./gjc-managed-session-operations";
import type { ModelReader, ModelReaderContext, ModelReaderFactory } from "./model-reader";

export interface ManagedModelReaderAttachment {
	readonly tenant: TenantSessionKey;
}

export type ManagedModelReaderAttachmentResolver = (signal?: AbortSignal) => Promise<ManagedModelReaderAttachment>;

/** Authority used to create an isolated, one-shot model catalog session. */
export interface ManagedTemporaryModelReaderInput {
	readonly principalId: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly leaseId: string;
	readonly epoch: string;
	readonly requestKey: string;
	readonly timeoutMs?: number;
}

export interface CreateManagedModelReaderFactoryInput {
	readonly runtime: ManagedSdkRuntime;
	/** Resolves an already-owned exact tenant/generation attachment. */
	readonly resolveAttachment?: ManagedModelReaderAttachmentResolver;
	/** Enables an isolated lifecycle-owned catalog session when no attachment is available. */
	readonly temporary?: ManagedTemporaryModelReaderInput;
}

export class ManagedModelReaderUnavailableError extends Error {
	constructor(message = "Managed GJC model reader is unavailable", options?: ErrorOptions) {
		super(message, options);
		this.name = "ManagedModelReaderUnavailableError";
	}
}

/**
 * Unwired Router-only model reader. It neither discovers endpoints nor owns a
 * transport credential; model-selection policy remains the sole catalog parser.
 */
export function createManagedModelReaderFactory(input: CreateManagedModelReaderFactoryInput): ModelReaderFactory {
	if (input.resolveAttachment === undefined && input.temporary === undefined)
		throw new TypeError("A managed model attachment or temporary lifecycle input is required.");
	return async (context, signal) => {
		const effectiveSignal = signal ?? context?.signal;
		await assertReaderContext(context, effectiveSignal, input.temporary?.canonicalWorkspace);
		throwIfAborted(effectiveSignal);
		if (input.resolveAttachment !== undefined) {
			const resolved = await awaitWithAbort(input.resolveAttachment(effectiveSignal), effectiveSignal);
			await assertReaderContext(context, effectiveSignal, resolved.tenant.canonicalWorkspace);
			const attachment = await acquire(input.runtime, resolved.tenant, effectiveSignal);
			return new ManagedModelReader(input.runtime, attachment, undefined, effectiveSignal);
		}
		return await createTemporaryReader(input.runtime, input.temporary!, effectiveSignal);
	};
}

async function createTemporaryReader(
	runtime: ManagedSdkRuntime,
	input: ManagedTemporaryModelReaderInput,
	signal?: AbortSignal,
): Promise<ModelReader> {
	assertTemporaryInput(input);
	const actor = { namespace: "openwebui-gjc-adapter", id: input.principalId };
	const creation = runtime.createExternalLifecycleSession({
		actor,
		capability: "session.create",
		requestKey: input.requestKey,
		target: { kind: "existing_path", path: input.canonicalWorkspace },
		readinessTimeoutMs: input.timeoutMs,
	});
	void creation.then(
		result => {
			if (!signal?.aborted) return;
			const tenant = tenantFromCreate(input, result);
			if (tenant !== undefined) void closeAndProveRetired(runtime, tenant, input.timeoutMs).catch(() => undefined);
		},
		() => undefined,
	);
	const result = await awaitWithAbort(creation, signal);
	const tenant = tenantFromCreate(input, result);
	if (tenant === undefined)
		throw new ManagedModelReaderUnavailableError("Managed catalog session creation was not acknowledged.");
	if (signal?.aborted) {
		await closeAndProveRetired(runtime, tenant, input.timeoutMs);
		throw new GjcTurnCancelledError();
	}
	try {
		const attachment = await runtime.registerLifecycleTenant(tenant);
		return new ManagedModelReader(runtime, attachment, { tenant, timeoutMs: input.timeoutMs }, signal);
	} catch (error) {
		try {
			await closeAndProveRetired(runtime, tenant, input.timeoutMs);
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Managed catalog session acquisition and cleanup failed.");
		}
		throw error;
	}
}

async function acquire(
	runtime: ManagedSdkRuntime,
	tenant: TenantSessionKey,
	signal?: AbortSignal,
): Promise<ManagedSdkAttachment> {
	throwIfAborted(signal);
	await awaitWithAbort(runtime.reconcile(), signal);
	throwIfAborted(signal);
	return await awaitWithAbort(runtime.acquireAttachment(tenant), signal);
}

class ManagedModelReader implements ModelReader {
	#stopped = false;

	constructor(
		private readonly runtime: ManagedSdkRuntime,
		private readonly attachment: ManagedSdkAttachment,
		private readonly temporary: { readonly tenant: TenantSessionKey; readonly timeoutMs?: number } | undefined,
		private readonly signal: AbortSignal | undefined,
	) {}

	getAvailableModels(): Promise<readonly unknown[]> {
		return this.query("models.list/current");
	}

	getActiveProviders(): Promise<readonly unknown[]> {
		return this.query("providers.list/active");
	}

	async getState(): Promise<unknown> {
		const items = await this.query("session.state");
		return items[0] ?? {};
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		if (this.temporary !== undefined)
			await closeAndProveRetired(this.runtime, this.temporary.tenant, this.temporary.timeoutMs);
	}

	private async query(
		name: "models.list/current" | "providers.list/active" | "session.state",
	): Promise<readonly unknown[]> {
		throwIfAborted(this.signal);
		try {
			const frame = await this.runtime.request(
				this.attachment,
				{ type: "query_request", query: name, input: {} },
				{ beforeDispatch: () => throwIfAborted(this.signal) },
			);
			throwIfAborted(this.signal);
			return decodeRouterPage(frame, name).items;
		} catch (error) {
			if (this.temporary !== undefined) {
				try {
					await this.stop();
				} catch (cleanup) {
					if (error instanceof GjcTurnCancelledError) throw error;
					throw new AggregateError([error, cleanup], "Managed catalog query and cleanup failed.");
				}
			}
			throw error;
		}
	}
}

async function closeAndProveRetired(
	runtime: ManagedSdkRuntime,
	tenant: TenantSessionKey,
	timeoutMs?: number,
): Promise<void> {
	let closeError: unknown;
	try {
		const outcome = await runtime.closeLifecycleSession({
			actor: { namespace: "openwebui-gjc-adapter", id: tenant.principalId },
			capability: "session.close",
			requestKey: `${tenant.sessionId}:${tenant.generation}:catalog-close`,
			target: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
			timeoutMs,
		});
		if (!isSuccess(outcome))
			closeError = new ManagedModelReaderUnavailableError("Managed catalog session close was not acknowledged.");
	} catch (error) {
		closeError = error;
	}
	try {
		await runtime.reconcile();
		const status = await runtime.generationStatus(tenant);
		if (status.status !== "retired")
			throw new ManagedModelReaderUnavailableError("Exact managed catalog generation retirement is not proven.");
		runtime.unregisterTenant(tenant);
	} catch (proofError) {
		throw closeError === undefined
			? proofError
			: new AggregateError([closeError, proofError], "Managed catalog close has uncertain retirement.");
	}
	if (closeError !== undefined) throw closeError;
}

function tenantFromCreate(input: ManagedTemporaryModelReaderInput, value: unknown): TenantSessionKey | undefined {
	const outcome = unwrapOutcome(value);
	if (!isSuccess(outcome) || !isRecord(outcome.result)) return undefined;
	const sessionId = outcome.result.sessionId;
	const generation = outcome.result.endpointGeneration;
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation <= 0
	)
		return undefined;
	return {
		principalId: input.principalId,
		projectId: input.projectId,
		canonicalWorkspace: input.canonicalWorkspace,
		chatId: input.chatId,
		sessionId,
		generation,
		leaseId: input.leaseId,
		epoch: input.epoch,
	};
}

function unwrapOutcome(value: unknown): unknown {
	return isRecord(value) && value.kind === "result" && "outcome" in value ? value.outcome : value;
}
function isSuccess(value: unknown): value is { readonly ok: true; readonly result: unknown } {
	return isRecord(value) && value.ok === true;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertTemporaryInput(input: ManagedTemporaryModelReaderInput): void {
	for (const value of [
		input.principalId,
		input.projectId,
		input.canonicalWorkspace,
		input.chatId,
		input.leaseId,
		input.epoch,
		input.requestKey,
	])
		if (typeof value !== "string" || value.length === 0)
			throw new TypeError("Complete temporary model-reader authority is required.");
}
async function assertReaderContext(
	context: ModelReaderContext | undefined,
	signal: AbortSignal | undefined,
	canonicalWorkspace: string | undefined,
): Promise<void> {
	throwIfAborted(signal);
	if (context === undefined) return;
	if (!context.principal || (context.principal.role !== "admin" && context.principal.role !== "user"))
		throw new ManagedModelReaderUnavailableError("A valid OpenWebUI principal is required.");
	if (context.principal.role !== "user") return;
	if (context.workspace === undefined || context.lease === undefined)
		throw new ManagedModelReaderUnavailableError("A normal-user model reader requires a workspace lease.");
	if (
		context.workspace.userId !== context.principal.userId ||
		(canonicalWorkspace !== undefined && resolve(context.workspace.root) !== resolve(canonicalWorkspace))
	)
		throw new ManagedModelReaderUnavailableError("Managed model reader authority escaped its tenant workspace.");
	try {
		await awaitWithAbort(context.lease.assertFence(), signal);
	} catch (error) {
		if (error instanceof GjcTurnCancelledError) throw error;
		throw new ManagedModelReaderUnavailableError("The normal-user workspace lease is no longer valid.", {
			cause: error,
		});
	}
}
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(new GjcTurnCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(new GjcTurnCancelledError());
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
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
	});
}
