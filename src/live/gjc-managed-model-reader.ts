import { resolve } from "node:path";
import { ManagedOperationDeadline } from "../gjc/managed-operation-deadline";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import { collectManagedQueryPages } from "./gjc-managed-session-operations";
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
	readonly assertFence: () => Promise<unknown>;
}

export interface CreateManagedModelReaderFactoryInput {
	readonly runtime: ManagedSdkRuntime;
	/** One budget from factory admission through all queries and final disposal. */
	readonly timeoutMs?: number;
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
 * Router-only model reader. It neither discovers endpoints nor owns a
 * transport credential; model-selection policy remains the sole catalog parser.
 */
export function createManagedModelReaderFactory(input: CreateManagedModelReaderFactoryInput): ModelReaderFactory {
	if (input.resolveAttachment === undefined && input.temporary === undefined)
		throw new TypeError("A managed model attachment or temporary lifecycle input is required.");
	return async (context, signal) => {
		const effectiveSignal = signal ?? context?.signal;
		throwIfAborted(effectiveSignal);
		const deadline = new ManagedOperationDeadline(input.timeoutMs, "model catalog");
		try {
			await assertReaderContext(context, effectiveSignal, input.temporary?.canonicalWorkspace, deadline);
			if (input.resolveAttachment !== undefined) {
				deadline.remaining();
				throwIfAborted(effectiveSignal);
				const resolved = await deadline.wait(
					awaitWithAbort(input.resolveAttachment(effectiveSignal), effectiveSignal),
				);
				assertPrincipal(context, resolved.tenant.principalId);
				await assertReaderContext(context, effectiveSignal, resolved.tenant.canonicalWorkspace, deadline);
				const attachment = await acquire(input.runtime, resolved.tenant, deadline, effectiveSignal);
				throwIfAborted(effectiveSignal);
				return new ManagedModelReader(
					input.runtime,
					attachment,
					undefined,
					effectiveSignal,
					deadline,
					async signal => await assertReaderContext(context, signal, resolved.tenant.canonicalWorkspace, deadline),
				);
			}
			return await createTemporaryReader(input.runtime, input.temporary!, deadline, context, effectiveSignal);
		} catch (error) {
			deadline.close();
			throw error;
		}
	};
}

async function createTemporaryReader(
	runtime: ManagedSdkRuntime,
	input: ManagedTemporaryModelReaderInput,
	deadline: ManagedOperationDeadline,
	context?: ModelReaderContext,
	signal?: AbortSignal,
): Promise<ModelReader> {
	assertTemporaryInput(input);
	assertPrincipal(context, input.principalId);
	await assertTemporaryFence(input, context, deadline, signal);
	const actor = { namespace: "openwebui-gjc-adapter", id: input.principalId };
	throwIfAborted(signal);
	const timeoutMs = deadline.remaining();
	// Observe an admitted mutation within the original budget even after cancellation.
	const result = await deadline.wait(
		runtime.createPreparedExternalLifecycleSession(
			input,
			{
				actor,
				capability: "session.create",
				requestKey: input.requestKey,
				target: { kind: "existing_path", path: input.canonicalWorkspace },
			},
			timeoutMs,
		),
	);
	const tenant = tenantFromCreate(input, result);
	if (tenant === undefined)
		throw new ManagedModelReaderUnavailableError("Managed catalog session creation was not acknowledged.");
	try {
		throwIfAborted(signal);
		await assertTemporaryFence(input, context, deadline, signal);
		throwIfAborted(signal);
		const attachment = await deadline.wait(
			awaitWithAbort(runtime.registerLifecycleTenant(tenant, deadline.remaining()), signal),
		);
		await assertTemporaryFence(input, context, deadline, signal);
		throwIfAborted(signal);
		return new ManagedModelReader(
			runtime,
			attachment,
			tenant,
			signal,
			deadline,
			async signal => await assertTemporaryFence(input, context, deadline, signal),
		);
	} catch (error) {
		try {
			await assertTemporaryFence(input, context, deadline);
			await closeAndProveRetired(runtime, tenant, deadline);
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Managed catalog session acquisition and cleanup failed.");
		}
		throw error;
	}
}

async function acquire(
	runtime: ManagedSdkRuntime,
	tenant: TenantSessionKey,
	deadline: ManagedOperationDeadline,
	signal?: AbortSignal,
): Promise<ManagedSdkAttachment> {
	throwIfAborted(signal);
	await deadline.wait(awaitWithAbort(runtime.reconcile(deadline.remaining()), signal));
	throwIfAborted(signal);
	return await deadline.wait(awaitWithAbort(runtime.acquireAttachment(tenant, deadline.remaining()), signal));
}

class ManagedModelReader implements ModelReader {
	#stopped = false;
	#stopPromise: Promise<void> | undefined;

	constructor(
		private readonly runtime: ManagedSdkRuntime,
		private readonly attachment: ManagedSdkAttachment,
		private readonly temporary: TenantSessionKey | undefined,
		private readonly signal: AbortSignal | undefined,
		private readonly deadline: ManagedOperationDeadline,
		private readonly fence: (signal?: AbortSignal) => Promise<void>,
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

	stop(): Promise<void> {
		if (this.#stopPromise !== undefined) return this.#stopPromise;
		this.#stopped = true;
		const deadline = this.deadline;
		this.#stopPromise = (async () => {
			try {
				deadline.remaining();
				await deadline.wait(this.fence());
				if (this.temporary !== undefined) await closeAndProveRetired(this.runtime, this.temporary, deadline);
			} finally {
				deadline.close();
			}
		})();
		return this.#stopPromise;
	}

	private async query(
		name: "models.list/current" | "providers.list/active" | "session.state",
	): Promise<readonly unknown[]> {
		throwIfAborted(this.signal);
		if (this.#stopped) throw new ManagedModelReaderUnavailableError("Managed catalog reader is stopped.");
		const deadline = this.deadline;
		const assertCurrent = () => {
			deadline.remaining();
			throwIfAborted(this.signal);
			if (this.#stopped || !this.attachment.isCurrent())
				throw new ManagedModelReaderUnavailableError("Managed catalog reader lost its current attachment.");
		};
		try {
			return await awaitWithAbort(
				collectManagedQueryPages(name, deadline, async cursor => {
					assertCurrent();
					await deadline.wait(this.fence(this.signal));
					assertCurrent();
					const frame = await deadline.wait(
						this.runtime.request(
							this.attachment,
							{ type: "query_request", query: name, input: {}, ...(cursor === undefined ? {} : { cursor }) },
							{ timeoutMs: deadline.remaining(), beforeDispatch: assertCurrent },
						),
					);
					assertCurrent();
					await deadline.wait(this.fence(this.signal));
					assertCurrent();
					return frame;
				}),
				this.signal,
			);
		} catch (error) {
			if (this.temporary !== undefined) {
				try {
					await this.stop();
				} catch (cleanup) {
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
	deadline: ManagedOperationDeadline,
): Promise<void> {
	let closeError: unknown;
	try {
		const remaining = deadline.remaining();
		const outcome = await deadline.wait(
			runtime.closeLifecycleSession({
				tenant,
				actor: { namespace: "openwebui-gjc-adapter", id: tenant.principalId },
				capability: "session.close",
				requestKey: `${tenant.sessionId}:${tenant.generation}:catalog-close`,
				target: { sessionId: tenant.sessionId, endpointGeneration: tenant.generation },
				timeoutMs: remaining,
			}),
		);
		if (!isSuccess(outcome) || !isRecord(outcome.result) || outcome.result.sessionId !== tenant.sessionId)
			closeError = new ManagedModelReaderUnavailableError("Managed catalog session close was not acknowledged.");
	} catch (error) {
		closeError = error;
	}
	try {
		await deadline.wait(runtime.reconcile(deadline.remaining()));
		const status = await deadline.wait(runtime.generationStatus(tenant, deadline.remaining()));
		if (status.status !== "retired")
			throw new ManagedModelReaderUnavailableError("Exact managed catalog generation retirement is not proven.");
		deadline.remaining();
		if (closeError === undefined) runtime.unregisterTenant(tenant);
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
	if (typeof input.assertFence !== "function") throw new TypeError("Temporary model-reader fence is required.");
}

function assertPrincipal(context: ModelReaderContext | undefined, principalId: string): void {
	if (context !== undefined && context.principal.userId !== principalId)
		throw new ManagedModelReaderUnavailableError("Managed model reader principal does not match tenant authority.");
}

async function assertTemporaryFence(
	input: ManagedTemporaryModelReaderInput,
	context: ModelReaderContext | undefined,
	deadline: ManagedOperationDeadline,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	deadline.remaining();
	await deadline.wait(awaitWithAbort(input.assertFence(), signal));
	throwIfAborted(signal);
	if (context?.lease !== undefined) {
		deadline.remaining();
		await deadline.wait(awaitWithAbort(context.lease.assertFence(), signal));
	}
}
async function assertReaderContext(
	context: ModelReaderContext | undefined,
	signal: AbortSignal | undefined,
	canonicalWorkspace: string | undefined,
	deadline: ManagedOperationDeadline,
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
		deadline.remaining();
		await deadline.wait(awaitWithAbort(context.lease.assertFence(), signal));
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
