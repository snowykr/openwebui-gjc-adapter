import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";
import { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import {
	copyManagedLifecycleEvidence,
	isHistoricalSavedSession,
	isHistoricalSessionBinding,
	isManagedCatalogProvisional,
	type ManagedHistoricalSavedSession,
	type ManagedLifecycleEvidence,
	managedProvisionalCreateAdmissionHash,
} from "./managed-lifecycle-evidence";
import type { HistoricalSessionBinding, ProvisionalSessionOperation } from "./session-authority-types";
import type { ManagedGenerationProof, ManagedPreparedTurnAuthority } from "./turn-runner";

export const MANAGED_SDK_OWNER_STATES = [
	"new",
	"starting",
	"running",
	"draining",
	"stopping",
	"stopped",
	"failed",
] as const;

export type ManagedSdkOwnerState = (typeof MANAGED_SDK_OWNER_STATES)[number];

/** Typed managed Router/lifecycle operation failure; never carries endpoint authority. */
export class ManagedSdkOperationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ManagedSdkOperationError";
	}
}

/** Complete tenant authority; session ids or generations alone are never authority. */
export interface TenantSessionKey {
	readonly principalId: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly leaseId: string;
	readonly epoch: string;
}

export interface ManagedSdkLifecycleOperation {
	readonly operationId: string;
	readonly requestKey: string;
	readonly payloadHash: string;
}

export interface ManagedSdkHistoricalSelection {
	readonly manifestDigest: string;
	readonly historicalBinding: HistoricalSessionBinding;
	readonly preparedAuthority: ManagedPreparedTurnAuthority;
}

export interface ManagedSdkCatalogReference {
	readonly original: ProvisionalSessionOperation;
	readonly expectedLifecycleHash: string;
}

export type ManagedSdkCatalogQuery = "models.list/current" | "providers.list/active" | "session.state";
export type ManagedSdkCatalogAccess =
	| Readonly<{ kind: "proof" }>
	| Readonly<{ kind: "query"; name: ManagedSdkCatalogQuery }>;
export interface ManagedSdkCatalogQueryOptions {
	readonly cursor?: string;
	readonly timeoutMs: number;
	readonly beforeDispatch?: NonNullable<Parameters<router.SessionRouter["request"]>[4]>["beforeDispatch"];
}

export type ManagedSdkAccess =
	| Readonly<{ kind: "active" }>
	| (ManagedSdkLifecycleOperation & Readonly<{ kind: "adoption-proof" }>)
	| (ManagedSdkLifecycleOperation & Readonly<{ kind: "retirement"; action: "close" | "generation-status" }>);

export interface ManagedSdkAttachment {
	readonly tenant: TenantSessionKey;
	readonly generation: number;
	isCurrent(): boolean;
}

export interface ManagedSdkFrameCorrelation {
	readonly commandId?: string;
	readonly turnId?: string;
	readonly publicationId?: string;
}

export interface ManagedSdkObservedFrame {
	readonly tenant: TenantSessionKey;
	readonly operation: string;
	readonly correlation: ManagedSdkFrameCorrelation;
	readonly frame: router.SessionRouterFrame;
}

export type ManagedSdkFrameClassification = "duplicate" | "late" | "unmatched" | "foreign" | "overflow";

export interface ManagedSdkFrameDiagnostics {
	readonly duplicate: number;
	readonly late: number;
	readonly unmatched: number;
	readonly foreign: number;
	readonly overflow: number;
	readonly listenerError: number;
}

export interface ManagedSdkRuntimeDeps {
	readonly createRouter?: (options: router.SessionRouterOptions) => router.SessionRouter;
	readonly createLifecycleService?: (agentDir: string) => ReturnType<typeof lifecycle.createSessionLifecycleService>;
	/** Re-proves tenant registration and lease/epoch authority at each boundary. */
	readonly tenantFence?: (key: TenantSessionKey, access: ManagedSdkAccess) => boolean | Promise<boolean>;
	readonly preparedTenantFence?: (authority: ManagedPreparedTurnAuthority) => boolean | Promise<boolean>;
	/** Dedicated generation-free selection admission; absence denies historical listing. */
	readonly historicalSelectionFence?: (selection: ManagedSdkHistoricalSelection) => boolean | Promise<boolean>;
	/** Consumes initial invoking admission against durable operation evidence and the current attempt lease. */
	readonly historicalResumeFence?: (
		operationId: string,
		evidence: ManagedLifecycleEvidence,
	) => boolean | Promise<boolean>;
	/** Independent canonical catalog ownership. Neither fence grants active routing authority. */
	readonly catalogFence?: (
		reference: ManagedSdkCatalogReference,
		tenant: TenantSessionKey,
		access: ManagedSdkCatalogAccess,
	) => boolean | Promise<boolean>;
	readonly catalogFenceSync?: (
		reference: ManagedSdkCatalogReference,
		tenant: TenantSessionKey,
		access: ManagedSdkCatalogAccess,
	) => boolean;
	readonly drainTimeoutMs?: number;
	readonly maxFrameSubscriptions?: number;
	readonly maxFramesPerSubscription?: number;
	readonly maxFrameHistory?: number;
}

export interface ManagedSdkRuntimeOptions {
	readonly agentDir: string;
	readonly routerDeps?: Omit<router.SessionRouterDeps, "onFrame">;
	readonly deps?: ManagedSdkRuntimeDeps;
}

/** Accounting only: sealing revokes new work, settlement never grants tenant authority. */
export interface ManagedSdkProducerScope {
	run<T>(work: () => Promise<T>): Promise<T>;
	drain(): Promise<void>;
	seal(): Promise<void>;
	readonly settled: Promise<void>;
}

class ProducerScope implements ManagedSdkProducerScope {
	readonly #producers = new Set<Promise<unknown>>();
	readonly #completion = Promise.withResolvers<void>();
	readonly settled = this.#completion.promise;
	#sealed = false;
	#finished = false;
	#persistenceFailure: { readonly error: unknown } | undefined;

	constructor(
		private readonly context: AsyncLocalStorage<ProducerScope>,
		private readonly retainGlobal: (producer: Promise<unknown>) => void,
		private readonly assertAdmission: () => void,
	) {
		void this.settled.catch(() => undefined);
	}

	run<T>(work: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.assertAdmission();
		const previous = this.context.getStore();
		if (previous !== undefined && previous !== this)
			throw new Error("Managed producer scopes cannot cross ownership boundaries.");
		const owned = Promise.withResolvers<T>();
		this.retain(owned.promise);
		this.retainGlobal(owned.promise);
		this.context.run(this, () => {
			try {
				const producer = work();
				if (producer === this.settled) throw new Error("Managed producer scope cannot own its settlement.");
				owned.resolve(producer);
			} catch (error) {
				owned.reject(error);
			}
		});
		return owned.promise;
	}

	assertOpen(): void {
		if (this.#sealed) throw new Error("Managed producer scope is sealed.");
	}

	retain<T>(producer: Promise<T>): Promise<T> {
		if (this.#finished || producer === this.settled)
			throw new Error("Managed producer scope cannot retain work after settlement.");
		this.#producers.add(producer);
		const settled = () => {
			this.#producers.delete(producer);
			this.#finish();
		};
		void producer.then(settled, settled);
		return producer;
	}

	persistenceFailed(error: unknown): void {
		this.#persistenceFailure ??= { error };
	}

	async drain(): Promise<void> {
		while (this.#producers.size > 0) await Promise.allSettled([...this.#producers]);
	}

	seal(): Promise<void> {
		this.#sealed = true;
		this.#finish();
		return this.settled;
	}

	#finish(): void {
		if (!this.#sealed || this.#finished || this.#producers.size !== 0) return;
		this.#finished = true;
		if (this.#persistenceFailure === undefined) this.#completion.resolve();
		else
			this.#completion.reject(
				new Error("Original lifecycle outcome persistence failed.", { cause: this.#persistenceFailure.error }),
			);
	}
}

interface FrameSubscription {
	readonly id: number;
	readonly tenant: TenantSessionKey;
	readonly token: ManagedSdkAttachment;
	readonly operation: string;
	correlation: ManagedSdkFrameCorrelation | undefined;
	readonly listener: (frame: ManagedSdkObservedFrame) => void | Promise<void>;
	queued: number;
	buffered: router.SessionRouterFrame[];
	tail: Promise<void>;
	deliveryFailed: boolean;
	deliveryError: unknown;
	active: boolean;
}

export interface ManagedSdkFrameSubscription {
	(): void;
	/** Stops delivery and waits for already accepted frames to settle in order, rejecting on listener failure. */
	drain(): Promise<void>;
}

interface ManagedLifecycleCall<TRequest> {
	readonly tenant: TenantSessionKey;
	readonly request: TRequest;
}

export type ManagedLifecycleCloseRequest = Parameters<
	ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]
>[0];
type LifecycleMethod = "create" | "createExternal" | "resume" | "resumeExternal" | "fork" | "close" | "list";
interface PendingCall {
	interrupt(error: Error): void;
}
interface CallBudget {
	remaining(): number;
}

/** A session/generation-scoped subscription that is bound only from a Router acknowledgement. */
export interface ManagedSdkPendingFrameSubscription extends ManagedSdkFrameSubscription {
	bind(correlation: ManagedSdkFrameCorrelation): void;
}

const DEFAULT_MAX_SUBSCRIPTIONS = 128;
const DEFAULT_MAX_FRAMES_PER_SUBSCRIPTION = 64;
const DEFAULT_MAX_FRAME_HISTORY = 256;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const ACTIVE_ACCESS: ManagedSdkAccess = Object.freeze({ kind: "active" });

/** Process-owned public-SDK runtime; raw Router capabilities never cross its authority boundary. */
export class ManagedSdkRuntime {
	readonly #router: router.SessionRouter;
	readonly #lifecycle: ReturnType<typeof lifecycle.createSessionLifecycleService>;
	readonly #tenantFence: ManagedSdkRuntimeDeps["tenantFence"];
	readonly #preparedTenantFence: ManagedSdkRuntimeDeps["preparedTenantFence"];
	readonly #historicalSelectionFence: ManagedSdkRuntimeDeps["historicalSelectionFence"];
	readonly #historicalResumeFence: ManagedSdkRuntimeDeps["historicalResumeFence"];
	readonly #catalogFence: ManagedSdkRuntimeDeps["catalogFence"];
	readonly #catalogFenceSync: ManagedSdkRuntimeDeps["catalogFenceSync"];
	readonly #drainTimeoutMs: number;
	readonly #pending = new Set<PendingCall>();
	readonly #producers = new Set<Promise<unknown>>();
	readonly #producerContext = new AsyncLocalStorage<ProducerScope>();
	readonly #tokens = new WeakMap<
		ManagedSdkAttachment,
		{ raw: router.SessionAttachment; registration: TenantSessionKey }
	>();
	readonly #attachmentTokens = new WeakMap<router.SessionAttachment, Map<string, ManagedSdkAttachment>>();
	readonly #activeTokens = new WeakSet<ManagedSdkAttachment>();
	readonly #maxSubscriptions: number;
	readonly #maxFramesPerSubscription: number;
	readonly #maxFrameHistory: number;
	/** One full tenant owns a session generation for the lifetime of its registration. */
	readonly #registrations = new Map<string, TenantSessionKey>();
	readonly #subscriptions = new Map<number, FrameSubscription>();
	readonly #expiredCorrelations = new Set<string>();
	readonly #seenFrameIds = new Set<string>();
	readonly #diagnostics: Record<ManagedSdkFrameClassification, number> = {
		duplicate: 0,
		late: 0,
		unmatched: 0,
		foreign: 0,
		overflow: 0,
	};
	#listenerErrorCount = 0;
	#state: ManagedSdkOwnerState = "new";
	#bootstrapAdmission = false;
	#startPromise: Promise<void> | undefined;
	#stopPromise: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	#outcomePersistenceFailure: unknown;
	#reconcileTail: Promise<void> = Promise.resolve();
	#nextSubscriptionId = 1;

	constructor(options: ManagedSdkRuntimeOptions) {
		if (!nonEmpty(options.agentDir)) throw new TypeError("agentDir is required.");
		const deps = options.deps ?? {};
		this.#tenantFence = deps.tenantFence;
		this.#preparedTenantFence = deps.preparedTenantFence;
		this.#historicalSelectionFence = deps.historicalSelectionFence;
		this.#historicalResumeFence = deps.historicalResumeFence;
		this.#catalogFence = deps.catalogFence?.bind(deps);
		this.#catalogFenceSync = deps.catalogFenceSync?.bind(deps);
		this.#drainTimeoutMs = finiteTimeout(deps.drainTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
		this.#maxSubscriptions = positiveLimit(deps.maxFrameSubscriptions, DEFAULT_MAX_SUBSCRIPTIONS);
		this.#maxFramesPerSubscription = positiveLimit(
			deps.maxFramesPerSubscription,
			DEFAULT_MAX_FRAMES_PER_SUBSCRIPTION,
		);
		this.#maxFrameHistory = positiveLimit(deps.maxFrameHistory, DEFAULT_MAX_FRAME_HISTORY);
		const routerOptions: router.SessionRouterOptions = {
			agentDir: options.agentDir,
			deps: { ...options.routerDeps, onFrame: (attachment, frame) => this.#onFrame(attachment, frame) },
		};
		this.#router = (deps.createRouter ?? (input => new router.SessionRouter(input)))(routerOptions);
		this.#lifecycle = (deps.createLifecycleService ?? lifecycle.createSessionLifecycleService)(options.agentDir);
	}

	get state(): ManagedSdkOwnerState {
		return this.#state;
	}

	get bootstrapAdmissionOpen(): boolean {
		return this.#bootstrapAdmission;
	}

	createProducerScope(): ManagedSdkProducerScope {
		return new ProducerScope(
			this.#producerContext,
			producer => {
				this.#retain(producer);
			},
			() => {
				if (["draining", "stopping", "stopped", "failed"].includes(this.#state))
					throw new ManagedSdkOperationError("runtime_interrupted", "Managed runtime scope admission is closed.");
			},
		);
	}

	async selectHistoricalSession(
		selection: ManagedSdkHistoricalSelection,
		timeoutMs?: number,
	): Promise<ManagedHistoricalSavedSession> {
		const value = structuredClone(selection);
		assertHistoricalSelection(value);
		freezeHistoricalInput(value);
		const fence = this.#historicalSelectionFence;
		return this.#track(timeoutMs, async budget => {
			if (fence === undefined || !(await fence(value)))
				throw new Error("Historical selection authority fence was lost or unavailable.");
			budget.remaining();
			this.#assertOwner();
			const outcome = await this.#lifecycle.list({
				actor: { id: value.preparedAuthority.principalId, namespace: "openwebui-gjc-adapter" },
				capability: "session.list",
				target: {
					cwd: value.preparedAuthority.canonicalWorkspace,
					resolveSessionId: value.historicalBinding.sessionId,
				},
				timeoutMs: budget.remaining(),
			});
			budget.remaining();
			if (!outcome.ok || outcome.operation !== "session.list")
				throw new ManagedSdkOperationError("lifecycle_list_failed", "Historical saved-session selection failed.");
			const result: unknown = outcome.result;
			if (
				!isRecord(result) ||
				!isHistoricalSavedSession(
					result.savedSession,
					value.historicalBinding.sessionId!,
					value.preparedAuthority.canonicalWorkspace,
				)
			)
				throw new ManagedSdkOperationError(
					"invalid_result",
					"Historical selection requires the exact public saved-session receipt.",
				);
			const saved = structuredClone(result.savedSession);
			if (!(await fence(value))) throw new Error("Historical selection authority fence was lost.");
			budget.remaining();
			this.#assertOwner();
			return saved;
		});
	}

	/** Initial historical invocation only. The owner must persist this acknowledgement before any proof or reauthorization. */
	async resumeHistoricalSession(
		operationId: string,
		evidence: ManagedLifecycleEvidence,
		onOutcome: (
			outcome: Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>>,
		) => void | Promise<void>,
		timeoutMs?: number,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]> {
		if (typeof onOutcome !== "function")
			throw new TypeError("Historical resume requires its original outcome observer.");
		const value = freezeHistoricalInput(copyManagedLifecycleEvidence(evidence));
		if (
			!exactHistoricalString(operationId) ||
			!operationId.startsWith("migration:resume:") ||
			operationId.length === "migration:resume:".length ||
			value.operation !== "session.resume" ||
			value.state !== "invoking" ||
			value.historicalSource === undefined ||
			value.acknowledged !== undefined ||
			value.proven !== undefined
		)
			throw new TypeError(
				"Historical resume requires a namespaced initial invoking operation and historical source.",
			);
		assertHistoricalSelection({
			manifestDigest: value.historicalSource.manifestDigest,
			historicalBinding: value.historicalSource.historicalBinding,
			preparedAuthority: value.preparedAuthority,
		});
		const saved = value.historicalSource.savedSession;
		const { dev, ino, size, mtimeMs, mtimeNs, sha256 } = saved.identity;
		const target = Object.freeze({
			sessionId: saved.id,
			cwd: value.preparedAuthority.canonicalWorkspace,
			sessionPath: saved.path,
			sessionIdentity: Object.freeze({ dev, ino, size, mtimeMs, mtimeNs, sha256 }),
		});
		const fence = this.#historicalResumeFence;
		return this.#track(timeoutMs, async budget => {
			if (fence === undefined || !(await fence(operationId, value)))
				throw new Error("Historical resume authority fence was lost or unavailable.");
			budget.remaining();
			this.#assertOwner();
			// No post-effect fence, attachment proof or retry may delay the owner's durable acknowledgement.
			const result = await this.#lifecycle.resume({
				actor: value.actor,
				capability: "session.resume",
				requestKey: value.requestKey,
				target,
				timeoutMs: budget.remaining(),
			});
			try {
				await onOutcome(structuredClone(result));
			} catch (error) {
				this.#producerContext.getStore()?.persistenceFailed(error);
				this.#outcomePersistenceFailure ??= new Error("Original lifecycle outcome persistence failed.", {
					cause: error,
				});
				throw error;
			}
			return result;
		});
	}

	createLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]> {
		return this.#invokeLifecycle("create", tenantOrRequest, request, value => this.#lifecycle.create(value));
	}

	createExternalLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0]
			| ManagedLifecycleCall<
					Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0]
			  >,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0],
		timeoutMs?: number,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]> {
		return this.#invokeLifecycle(
			"createExternal",
			tenantOrRequest,
			request,
			value => this.#lifecycle.createExternal(value),
			ACTIVE_ACCESS,
			timeoutMs,
		);
	}

	createPreparedExternalLifecycleSession(
		authority: ManagedPreparedTurnAuthority,
		request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0],
		timeoutMs?: number,
		onOutcome?: (
			outcome: Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>>,
		) => void | Promise<void>,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]> {
		return this.#invokePreparedCreate(authority, request, timeoutMs, onOutcome);
	}

	resumeExternalLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>[0]
			| ManagedLifecycleCall<
					Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>[0]
			  >,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>[0],
		timeoutMs?: number,
		onOutcome?: (
			outcome: Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>>,
		) => void | Promise<void>,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]> {
		return this.#invokeLifecycle(
			"resumeExternal",
			tenantOrRequest,
			request,
			value => this.#lifecycle.resumeExternal(value),
			ACTIVE_ACCESS,
			timeoutMs,
			onOutcome,
		);
	}

	forkLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0],
		onOutcome?: (
			outcome: Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>>,
		) => void | Promise<void>,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]> {
		return this.#invokeLifecycle(
			"fork",
			tenantOrRequest,
			request,
			value => this.#lifecycle.fork(value),
			ACTIVE_ACCESS,
			undefined,
			onOutcome,
		);
	}

	resumeLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]> {
		return this.#invokeLifecycle("resume", tenantOrRequest, request, value => this.#lifecycle.resume(value));
	}

	closeLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| ManagedLifecycleCall<ManagedLifecycleCloseRequest>
			| (ManagedLifecycleCloseRequest & { readonly tenant: TenantSessionKey }),
		request?: ManagedLifecycleCloseRequest,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]> {
		return this.#invokeLifecycle("close", tenantOrRequest, request, (value, tenant) => {
			assertLifecycleCloseAuthority(tenant, value);
			return this.#lifecycle.close(value);
		});
	}

	async retireLifecycleSession(
		key: TenantSessionKey,
		request: ManagedLifecycleCloseRequest,
		operation: ManagedSdkLifecycleOperation,
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]> {
		const identity = lifecycleOperation(operation);
		if (request.requestKey !== identity.requestKey)
			throw new TypeError("Retirement request key does not match its durable operation.");
		const access: ManagedSdkAccess = Object.freeze({ ...identity, kind: "retirement", action: "close" });
		return this.#invokeLifecycle(
			"close",
			key,
			request,
			(value, tenant) => {
				assertLifecycleCloseAuthority(tenant, value);
				return this.#lifecycle.close(value);
			},
			access,
		);
	}

	deleteLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]> {
		void tenantOrRequest;
		void request;
		return Promise.reject(
			new ManagedSdkOperationError(
				"exact_delete_authority_unavailable",
				"SDK 0.16.4 public delete has no exact generation/incarnation target; managed delete is prohibited.",
			),
		);
	}

	listLifecycleSessions(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]> {
		return this.#invokeLifecycle("list", tenantOrRequest, request, async (value, tenant) =>
			filterLifecycleList(await this.#lifecycle.list(value), tenant),
		);
	}

	frameDiagnostics(): ManagedSdkFrameDiagnostics {
		return { ...this.#diagnostics, listenerError: this.#listenerErrorCount };
	}

	registerTenant(key: TenantSessionKey): void {
		assertTenantKey(key);
		if (["draining", "stopping", "stopped", "failed"].includes(this.#state))
			throw new Error("Managed SDK runtime is not accepting registrations.");
		const ownedKey = generationIdentity(key);
		const registered = this.#registrations.get(ownedKey);
		if (registered !== undefined && !sameTenantKey(registered, key))
			throw new Error("Session generation is already owned by another managed tenant.");
		if (registered === undefined) this.#registrations.set(ownedKey, copyTenantKey(key));
	}

	/** Reconciles a credential-free lifecycle identity before exposing its exact tenant authority. */
	async registerLifecycleTenant(key: TenantSessionKey, timeoutMs?: number): Promise<ManagedSdkAttachment> {
		assertTenantKey(key);
		key = copyTenantKey(key);
		return this.#track(timeoutMs, async budget => {
			this.registerTenant(key);
			await this.reconcile(budget.remaining());
			const attachment = await this.acquireAttachment(key, budget.remaining());
			budget.remaining();
			if (!attachment.isCurrent()) throw new Error("Lifecycle tenant attachment is no longer current.");
			return attachment;
		});
	}

	/** Exact lifecycle proof is not active routing authority; the owner supplies durable purpose evidence. */
	async proveLifecycleTenant(
		key: TenantSessionKey,
		operation: ManagedSdkLifecycleOperation,
		timeoutMs?: number,
	): Promise<ManagedSdkAttachment> {
		const access: ManagedSdkAccess = Object.freeze({ ...lifecycleOperation(operation), kind: "adoption-proof" });
		key = copyTenantKey(key);
		return this.#track(timeoutMs, async budget => {
			this.registerTenant(key);
			const registration = this.#registrations.get(generationIdentity(key));
			await this.#assertAuthorized(key, false, false, access);
			budget.remaining();
			const reconcile = this.#reconcileTail.then(async () => {
				budget.remaining();
				await this.#assertAuthorized(key, false, false, access);
				budget.remaining();
				if (this.#registrations.get(generationIdentity(key)) !== registration)
					throw new Error("Tenant registration changed during lifecycle proof.");
				await this.#router.reconcile();
			});
			this.#reconcileTail = reconcile.catch(() => undefined);
			await reconcile;
			budget.remaining();
			await this.#assertAuthorized(key, false, false, access);
			budget.remaining();
			if (this.#registrations.get(generationIdentity(key)) !== registration)
				throw new Error("Tenant registration changed during lifecycle proof.");
			return this.#attachmentToken(key);
		});
	}

	/** Currentness evidence only; no attachment capability or active-token promotion escapes. */
	async proveCatalogSession(
		reference: ManagedSdkCatalogReference,
		tenant: TenantSessionKey,
		timeoutMs?: number,
	): Promise<ManagedGenerationProof> {
		const ref = snapshotCatalogReference(reference, tenant);
		const key = copyTenantKey(tenant);
		const access: ManagedSdkCatalogAccess = Object.freeze({ kind: "proof" });
		return this.#track(timeoutMs, async budget => {
			await this.#assertCatalogAuthorized(ref, key, access);
			budget.remaining();
			this.#assertCatalogAuthorizedSync(ref, key, access);
			budget.remaining();
			this.#assertOwner();
			this.registerTenant(key);
			const registration = this.#registrations.get(generationIdentity(key));
			const reconcile = this.#reconcileTail.then(async () => {
				budget.remaining();
				await this.#assertCatalogAuthorized(ref, key, access);
				budget.remaining();
				this.#assertCatalogAuthorizedSync(ref, key, access);
				budget.remaining();
				this.#assertCatalogRegistration(key, registration);
				await this.#router.reconcile();
			});
			this.#reconcileTail = reconcile.catch(() => undefined);
			await reconcile;
			budget.remaining();
			await this.#assertCatalogAuthorized(ref, key, access);
			budget.remaining();
			this.#assertCatalogAuthorizedSync(ref, key, access);
			budget.remaining();
			this.#catalogAttachment(key, registration);
			return {
				kind: "managed-generation",
				sessionId: key.sessionId,
				generation: key.generation,
				leaseId: key.leaseId,
				epoch: key.epoch,
			};
		});
	}

	async queryCatalog(
		reference: ManagedSdkCatalogReference,
		tenant: TenantSessionKey,
		name: ManagedSdkCatalogQuery,
		options: ManagedSdkCatalogQueryOptions,
	): Promise<Record<string, unknown>> {
		const ref = snapshotCatalogReference(reference, tenant);
		const key = copyTenantKey(tenant);
		if (!["models.list/current", "providers.list/active", "session.state"].includes(name))
			throw new TypeError("Catalog query name is not permitted.");
		if (
			!isRecord(options) ||
			Object.keys(options).some(field => !["cursor", "timeoutMs", "beforeDispatch"].includes(field)) ||
			typeof options.timeoutMs !== "number"
		)
			throw new TypeError("Catalog query requires an explicit logical timeout and declared options.");
		const { cursor, timeoutMs, beforeDispatch } = options;
		if (cursor !== undefined && !exactHistoricalString(cursor))
			throw new TypeError("Catalog cursor must be an exact nonempty string.");
		if (beforeDispatch !== undefined && typeof beforeDispatch !== "function")
			throw new TypeError("Catalog beforeDispatch must be a function.");
		const callerBeforeDispatch = beforeDispatch?.bind(options);
		const access: ManagedSdkCatalogAccess = Object.freeze({ kind: "query", name });
		if (this.#catalogFenceSync === undefined) throw new Error("Catalog synchronous authority fence is unavailable.");
		return this.#track(timeoutMs, async budget => {
			const registration = this.#registrations.get(generationIdentity(key));
			await this.#assertCatalogAuthorized(ref, key, access);
			budget.remaining();
			const raw = this.#catalogAttachment(key, registration);
			const assertDispatch = () => {
				budget.remaining();
				this.#catalogAttachment(key, registration, raw);
				this.#assertCatalogAuthorizedSync(ref, key, access);
				budget.remaining();
				this.#catalogAttachment(key, registration, raw);
			};
			assertDispatch();
			const result = await this.#router.request(
				key.sessionId,
				{ type: "query_request", query: name, input: {}, ...(cursor === undefined ? {} : { cursor }) },
				key.generation,
				raw,
				{
					timeoutMs: budget.remaining(),
					beforeDispatch: context => {
						assertDispatch();
						callerBeforeDispatch?.(context);
						assertDispatch();
					},
				},
			);
			budget.remaining();
			await this.#assertCatalogAuthorized(ref, key, access);
			assertDispatch();
			return result;
		});
	}

	async #assertCatalogAuthorized(
		reference: ManagedSdkCatalogReference,
		key: TenantSessionKey,
		access: ManagedSdkCatalogAccess,
	): Promise<void> {
		this.#assertOwner();
		if (this.#catalogFence === undefined || (await this.#catalogFence(reference, key, access)) !== true)
			throw new Error("Catalog authority fence was lost or unavailable.");
		this.#assertOwner();
	}

	#assertCatalogAuthorizedSync(
		reference: ManagedSdkCatalogReference,
		key: TenantSessionKey,
		access: ManagedSdkCatalogAccess,
	): void {
		this.#assertOwner();
		if (this.#catalogFenceSync === undefined || this.#catalogFenceSync(reference, key, access) !== true)
			throw new Error("Catalog synchronous authority fence was lost or unavailable.");
		this.#assertOwner();
	}

	#assertCatalogRegistration(key: TenantSessionKey, registration: TenantSessionKey | undefined): void {
		this.#assertOwner();
		if (
			registration === undefined ||
			this.#registrations.get(generationIdentity(key)) !== registration ||
			!sameTenantKey(key, registration)
		)
			throw new Error("Catalog tenant registration changed or is unavailable.");
	}

	#catalogAttachment(
		key: TenantSessionKey,
		registration: TenantSessionKey | undefined,
		expected?: router.SessionAttachment,
	): router.SessionAttachment {
		this.#assertCatalogRegistration(key, registration);
		const raw = this.#router.attachment(key.sessionId, key.generation);
		if (
			raw === null ||
			raw === undefined ||
			(expected !== undefined && raw !== expected) ||
			raw.sessionId !== key.sessionId ||
			raw.generation !== key.generation ||
			!raw.isCurrent()
		)
			throw new Error("Catalog requires the current exact Router attachment.");
		return raw;
	}

	unregisterTenant(key: TenantSessionKey): void {
		assertTenantKey(key);
		const ownedKey = generationIdentity(key);
		const registered = this.#registrations.get(ownedKey);
		if (registered !== undefined && sameTenantKey(registered, key)) this.#registrations.delete(ownedKey);
	}

	start(): Promise<void> {
		if (this.#state === "running") return this.#startPromise ?? Promise.resolve();
		if (this.#startPromise !== undefined) return this.#startPromise;
		if (this.#state !== "new")
			return Promise.reject(new Error(`Managed SDK runtime cannot start from ${this.#state}.`));
		this.#state = "starting";
		this.#bootstrapAdmission = true;
		this.#startPromise = this.#retain(
			(async () => {
				try {
					await this.#router.start();
					if (this.#state === "starting") this.#state = "running";
				} catch (error) {
					if (this.#state === "starting") this.#state = "failed";
					throw error;
				} finally {
					this.#bootstrapAdmission = false;
				}
			})(),
		);
		return this.#startPromise;
	}

	/** Bounded shutdown observation; rejection does not prove owned work has settled. */
	stop(): Promise<void> {
		if (this.#stopPromise !== undefined) return this.#stopPromise;
		this.#state = "draining";
		this.#bootstrapAdmission = false;
		const expiresAt = performance.now() + this.#drainTimeoutMs;
		let observationFailure: unknown;
		const remaining = () => {
			if (observationFailure !== undefined) throw observationFailure;
			const budget = expiresAt - performance.now();
			if (budget <= 0)
				throw new ManagedSdkOperationError("drain_timeout", "Managed runtime shutdown deadline exceeded.");
			return budget;
		};
		let drainFailure: unknown;
		const closeAdmission = () => {
			if (this.#state === "stopped" || this.#state === "failed") return;
			this.#state = "stopping";
			this.#clearSubscriptions();
			const interruption = new ManagedSdkOperationError(
				"runtime_interrupted",
				"Managed runtime drain expired; dispatched effects require durable caller reconciliation.",
			);
			for (const call of this.#pending) call.interrupt(interruption);
		};
		this.#disposePromise = (async () => {
			try {
				// Reserve half the same shutdown budget for local Router cleanup.
				const drainBudget = Math.min(remaining(), this.#drainTimeoutMs / 2);
				await boundedWait(this.#drain(), drainBudget, "drain_timeout");
			} catch (error) {
				drainFailure = error;
			}
			closeAdmission();
			try {
				// A late start must not revive the Router after stop. Waiting does
				// not renew permission to initiate stop past the original deadline.
				await this.#startPromise?.catch(() => undefined);
				remaining();
				await this.#router.stop();
			} finally {
				// Stop may unblock requests. A race timeout or unsubscribe must
				// not discard ownership of an already-entered producer.
				await this.#drain();
			}
			if (this.#outcomePersistenceFailure !== undefined) throw this.#outcomePersistenceFailure;
		})().then(
			() => {
				this.#state = "stopped";
			},
			error => {
				this.#state = "failed";
				throw error;
			},
		);
		void this.#disposePromise.catch(() => undefined);
		this.#stopPromise = boundedWait(
			this.#disposePromise,
			Math.max(0, expiresAt - performance.now()),
			"drain_timeout",
		).then(
			() => {
				remaining();
				if (drainFailure !== undefined) throw drainFailure;
			},
			error => {
				observationFailure = error;
				closeAdmission();
				throw error;
			},
		);
		void this.#stopPromise.catch(() => undefined);
		return this.#stopPromise;
	}

	/** Actual producer quiescence and successful local stop; owners release only after fulfillment. */
	dispose(): Promise<void> {
		this.stop();
		return this.#disposePromise!;
	}

	async #drain(): Promise<void> {
		while (this.#producers.size > 0) await Promise.allSettled([...this.#producers]);
	}

	/** Serializes explicit reconciliation without exposing Router implementation state. */
	reconcile(timeoutMs?: number): Promise<void> {
		return this.#track(timeoutMs, budget => {
			const next = this.#reconcileTail.then(async () => {
				budget.remaining();
				this.#assertOwner();
				await this.#router.reconcile();
			});
			this.#reconcileTail = next.catch(() => undefined);
			return next;
		});
	}

	async acquireAttachment(key: TenantSessionKey, timeoutMs?: number): Promise<ManagedSdkAttachment> {
		key = copyTenantKey(key);
		const bootstrap = this.#state === "starting" && this.#bootstrapAdmission;
		return this.#track(
			timeoutMs,
			async budget => {
				await this.#assertAuthorized(key, bootstrap);
				budget.remaining();
				const token = this.#attachmentToken(key);
				this.#activeTokens.add(token);
				return token;
			},
			bootstrap,
		);
	}

	#attachmentToken(key: TenantSessionKey): ManagedSdkAttachment {
		const attachment = this.#router.attachment(key.sessionId, key.generation);
		if (
			!attachment?.isCurrent() ||
			attachment.sessionId !== key.sessionId ||
			attachment.generation !== key.generation
		)
			throw new Error("Current Router attachment is required.");
		let tokens = this.#attachmentTokens.get(attachment);
		if (tokens === undefined) {
			tokens = new Map();
			this.#attachmentTokens.set(attachment, tokens);
		}
		const identity = tenantIdentity(key);
		const existing = tokens.get(identity);
		if (existing?.isCurrent()) return existing;
		const token: ManagedSdkAttachment = Object.freeze({
			tenant: copyTenantKey(key),
			generation: key.generation,
			isCurrent: () => this.#isCurrentToken(token),
		});
		this.#tokens.set(token, { raw: attachment, registration: this.#registrations.get(generationIdentity(key))! });
		tokens.set(identity, token);
		return token;
	}

	async request(
		managed: ManagedSdkAttachment,
		frame: Record<string, unknown>,
		options?: {
			readonly timeoutMs?: number;
			readonly beforeDispatch?: NonNullable<Parameters<router.SessionRouter["request"]>[4]>["beforeDispatch"];
			readonly onDispatch?: NonNullable<Parameters<router.SessionRouter["request"]>[4]>["onDispatch"];
		},
	): Promise<Record<string, unknown>> {
		return this.#track(options?.timeoutMs, async budget => {
			const key = managed.tenant;
			await this.#assertAuthorized(key, false);
			budget.remaining();
			this.#assertOwner();
			const raw = this.#assertManagedAttachment(managed);
			const result = await this.#router.request(key.sessionId, frame, key.generation, raw, {
				...options,
				timeoutMs: budget.remaining(),
				beforeDispatch: context => {
					budget.remaining();
					this.#assertOwner();
					this.#assertManagedAttachment(managed);
					options?.beforeDispatch?.(context);
					budget.remaining();
					this.#assertOwner();
					this.#assertManagedAttachment(managed);
				},
			});
			await this.#assertAuthorized(key, false, true);
			budget.remaining();
			this.#assertManagedAttachment(managed);
			return result;
		});
	}

	async generationStatus(key: TenantSessionKey, timeoutMs?: number): Promise<router.SessionGenerationStatus> {
		return this.#generationStatus(key, ACTIVE_ACCESS, timeoutMs);
	}

	async retirementGenerationStatus(
		key: TenantSessionKey,
		operation: ManagedSdkLifecycleOperation,
		timeoutMs?: number,
	): Promise<router.SessionGenerationStatus> {
		const access: ManagedSdkAccess = Object.freeze({
			...lifecycleOperation(operation),
			kind: "retirement",
			action: "generation-status",
		});
		return this.#generationStatus(key, access, timeoutMs);
	}

	async #generationStatus(
		key: TenantSessionKey,
		access: ManagedSdkAccess,
		timeoutMs?: number,
	): Promise<router.SessionGenerationStatus> {
		key = copyTenantKey(key);
		return this.#track(timeoutMs, async budget => {
			const registration = this.#registrations.get(generationIdentity(key));
			await this.#assertAuthorized(key, false, false, access);
			budget.remaining();
			this.#assertOwner();
			if (this.#registrations.get(generationIdentity(key)) !== registration)
				throw new Error("Tenant registration changed before generation status.");
			const result = await this.#router.generationStatus(key.sessionId, key.generation);
			await this.#assertAuthorized(key, false, true, access);
			budget.remaining();
			if (this.#registrations.get(generationIdentity(key)) !== registration)
				throw new Error("Tenant registration changed during generation status.");
			return result;
		});
	}

	subscribeFrames(
		managed: ManagedSdkAttachment,
		operation: string,
		correlation: ManagedSdkFrameCorrelation,
		listener: (frame: ManagedSdkObservedFrame) => void | Promise<void>,
	): ManagedSdkFrameSubscription {
		if (this.#state !== "running") throw new Error("Managed SDK runtime is not running.");
		if (!nonEmpty(operation) || !hasCorrelation(correlation))
			throw new TypeError("Operation and correlation are required.");
		this.#assertManagedAttachment(managed);
		this.#assertActiveToken(managed);
		if (this.#subscriptions.size >= this.#maxSubscriptions) {
			this.#classify("overflow");
			throw new Error("Managed SDK frame subscription capacity exceeded.");
		}
		const subscription: FrameSubscription = {
			id: this.#nextSubscriptionId++,
			tenant: copyTenantKey(managed.tenant),
			token: managed,
			operation,
			correlation: { ...correlation },
			listener,
			queued: 0,
			buffered: [],
			tail: Promise.resolve(),
			deliveryFailed: false,
			deliveryError: undefined,
			active: true,
		};
		this.#subscriptions.set(subscription.id, subscription);
		const unsubscribe = (() => this.#cleanupSubscription(subscription)) as ManagedSdkFrameSubscription;
		unsubscribe.drain = async () => {
			await boundedWait(subscription.tail, this.#drainTimeoutMs, "runtime_interrupted");
			if (subscription.deliveryFailed) throw subscription.deliveryError;
		};
		return unsubscribe;
	}

	/**
	 * Installs the frame listener before dispatch. Frames are retained by exact tenant
	 * generation until the Router acknowledgement supplies its authoritative correlation.
	 */
	prepareFrameSubscription(
		managed: ManagedSdkAttachment,
		operation: string,
		listener: (frame: ManagedSdkObservedFrame) => void | Promise<void>,
	): ManagedSdkPendingFrameSubscription {
		if (this.#state !== "running") throw new Error("Managed SDK runtime is not running.");
		if (!nonEmpty(operation)) throw new TypeError("Operation is required.");
		this.#assertManagedAttachment(managed);
		this.#assertActiveToken(managed);
		if (this.#subscriptions.size >= this.#maxSubscriptions) {
			this.#classify("overflow");
			throw new Error("Managed SDK frame subscription capacity exceeded.");
		}
		const subscription: FrameSubscription = {
			id: this.#nextSubscriptionId++,
			tenant: copyTenantKey(managed.tenant),
			token: managed,
			operation,
			correlation: undefined,
			listener,
			queued: 0,
			buffered: [],
			tail: Promise.resolve(),
			deliveryFailed: false,
			deliveryError: undefined,
			active: true,
		};
		this.#subscriptions.set(subscription.id, subscription);
		const unsubscribe = (() => this.#cleanupSubscription(subscription)) as ManagedSdkPendingFrameSubscription;
		unsubscribe.drain = async () => {
			await boundedWait(subscription.tail, this.#drainTimeoutMs, "runtime_interrupted");
			if (subscription.deliveryFailed) throw subscription.deliveryError;
		};
		unsubscribe.bind = correlation => {
			if (!subscription.active) throw new Error("Managed SDK frame subscription is closed.");
			if (!hasCorrelation(correlation)) throw new TypeError("Acknowledged frame correlation is required.");
			if (subscription.correlation !== undefined)
				throw new Error("Managed SDK frame subscription is already bound.");
			subscription.correlation = { ...correlation };
			if (subscription.buffered.length > 0) this.#deliver(subscription);
		};
		return unsubscribe;
	}

	async #invokeLifecycle<TRequest, TResult>(
		method: LifecycleMethod,
		tenantOrRequest: TenantSessionKey | TRequest | ManagedLifecycleCall<TRequest>,
		request: TRequest | undefined,
		invoke: (request: TRequest, tenant: TenantSessionKey) => Promise<TResult>,
		access: ManagedSdkAccess = ACTIVE_ACCESS,
		timeoutMs?: number,
		onOutcome?: (outcome: TResult) => void | Promise<void>,
	): Promise<TResult> {
		const call = lifecycleCall(tenantOrRequest, request);
		if (call === undefined)
			throw new Error("Complete managed tenant authority is required for lifecycle operations.");
		const key = copyTenantKey(call.tenant);
		const value = structuredClone(call.request);
		const external = method === "createExternal" || method === "resumeExternal";
		if (external) assertExternalLifecycleReadiness(value);
		const timeout = external ? timeoutMs : isRecord(value) ? value.timeoutMs : undefined;
		return this.#track(timeout, async budget => {
			const registration = this.#registrations.get(generationIdentity(key));
			await this.#assertAuthorized(key, false, false, access);
			assertLifecycleRequestAuthority(method, key, value);
			budget.remaining();
			this.#assertOwner();
			if (this.#registrations.get(generationIdentity(key)) !== registration)
				throw new Error("Tenant registration changed before lifecycle invocation.");
			const result = await invoke(external ? value : { ...value, timeoutMs: budget.remaining() }, key);
			if (onOutcome !== undefined) {
				try {
					await onOutcome(structuredClone(result));
				} catch (error) {
					this.#producerContext.getStore()?.persistenceFailed(error);
					this.#outcomePersistenceFailure ??= new Error("Original lifecycle outcome persistence failed.", {
						cause: error,
					});
					throw error;
				}
			}
			// An applied identity must reach the durable owner before another fence
			// can fail or hang. A mutation receipt never grants live authority.
			if (method !== "list") return result;
			await this.#assertAuthorized(key, false, true, access);
			budget.remaining();
			if (this.#registrations.get(generationIdentity(key)) !== registration)
				throw new Error("Tenant registration changed during lifecycle invocation.");
			return result;
		});
	}

	async #invokePreparedCreate(
		authority: ManagedPreparedTurnAuthority,
		request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0],
		timeoutMs?: number,
		onOutcome?: (
			outcome: Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>>,
		) => void | Promise<void>,
	): Promise<Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>>> {
		assertPreparedAuthority(authority);
		const prepared = Object.freeze({ ...authority });
		const value = structuredClone(request);
		assertExternalLifecycleReadiness(value);
		if (value.actor.id !== prepared.principalId || value.actor.namespace !== "openwebui-gjc-adapter")
			throw new Error("Lifecycle actor does not match prepared managed authority.");
		if (value.capability !== "session.create" || value.requestKey !== prepared.requestKey)
			throw new Error("Lifecycle request key does not match prepared managed authority.");
		if (
			value.target.kind !== "existing_path" ||
			value.target.path !== prepared.canonicalWorkspace ||
			Object.keys(value.target).some(key => key !== "kind" && key !== "path")
		)
			throw new Error("Lifecycle create target does not match prepared managed authority.");
		const fence = this.#preparedTenantFence;
		return this.#track(timeoutMs, async budget => {
			if (fence === undefined || !(await fence(prepared)))
				throw new Error("Prepared tenant authority fence was lost or unavailable.");
			budget.remaining();
			this.#assertOwner();
			// Persist acknowledgement before adoption or live-authority checks.
			const result = await this.#lifecycle.createExternal(value);
			if (onOutcome !== undefined) {
				try {
					await onOutcome(structuredClone(result));
				} catch (error) {
					this.#producerContext.getStore()?.persistenceFailed(error);
					this.#outcomePersistenceFailure ??= new Error("Original lifecycle outcome persistence failed.", {
						cause: error,
					});
					throw error;
				}
			}
			return result;
		});
	}

	async #assertAuthorized(
		key: TenantSessionKey,
		bootstrap: boolean,
		admitted = false,
		access: ManagedSdkAccess = ACTIVE_ACCESS,
	): Promise<void> {
		assertTenantKey(key);
		this.#assertOwner(bootstrap, admitted);
		const registration = this.#registrations.get(generationIdentity(key));
		if (registration === undefined || !sameTenantKey(registration, key))
			throw new Error("Tenant is not registered for this session authority.");
		if (this.#tenantFence === undefined || !(await this.#tenantFence(copyTenantKey(key), access)))
			throw new Error("Tenant authority fence was lost or unavailable.");
		this.#assertOwner(bootstrap, admitted);
		if (this.#registrations.get(generationIdentity(key)) !== registration)
			throw new Error("Tenant registration changed during authorization.");
	}

	#assertOwner(bootstrap = false, admitted = false): void {
		if (
			this.#state === "running" ||
			(bootstrap && this.#state === "starting" && this.#bootstrapAdmission) ||
			(admitted && this.#state === "draining")
		)
			return;
		throw new ManagedSdkOperationError(
			"runtime_interrupted",
			"Managed SDK runtime is not running; dispatched effects require caller reconciliation.",
		);
	}

	#assertManagedAttachment(managed: ManagedSdkAttachment): router.SessionAttachment {
		assertTenantKey(managed.tenant);
		if (managed.generation !== managed.tenant.generation) throw new Error("Exact tenant generation is required.");
		if (!this.#isRegistered(managed.tenant)) throw new Error("Registered current tenant attachment is required.");
		if (!this.#tokens.has(managed)) throw new Error("Manager-issued attachment token is required.");
		if (!this.#isCurrentToken(managed)) throw new Error("Current Router attachment is required.");
		return this.#tokens.get(managed)!.raw;
	}

	#assertActiveToken(managed: ManagedSdkAttachment): void {
		if (!this.#activeTokens.has(managed)) throw new Error("Active tenant acquisition is required for subscriptions.");
	}

	#isCurrentToken(token: ManagedSdkAttachment): boolean {
		const held = this.#tokens.get(token);
		return (
			held !== undefined &&
			["running", "draining", "starting"].includes(this.#state) &&
			(this.#state !== "starting" || this.#bootstrapAdmission) &&
			this.#registrations.get(generationIdentity(token.tenant)) === held.registration &&
			sameTenantKey(token.tenant, held.registration) &&
			held.raw.sessionId === token.tenant.sessionId &&
			held.raw.generation === token.generation &&
			this.#router.attachment(token.tenant.sessionId, token.generation) === held.raw &&
			held.raw.isCurrent()
		);
	}

	#track<T>(timeout: unknown, work: (budget: CallBudget) => Promise<T>, bootstrap = false): Promise<T> {
		const owner = this.#producerContext.getStore();
		let timeoutMs: number;
		try {
			owner?.assertOpen();
			this.#assertOwner(bootstrap);
			timeoutMs = finiteTimeout(timeout, DEFAULT_OPERATION_TIMEOUT_MS);
		} catch (error) {
			return Promise.reject(error);
		}
		const expires = performance.now() + timeoutMs;
		let stopped: Error | undefined;
		let rejectInterruption!: (error: Error) => void;
		const interrupted = new Promise<never>((_resolve, reject) => {
			rejectInterruption = reject;
		});
		const interrupt = (error: Error) => {
			stopped ??= error;
			rejectInterruption(stopped);
		};
		const timer = setTimeout(
			() =>
				interrupt(
					new ManagedSdkOperationError(
						"timeout",
						"Managed SDK operation deadline exceeded; invoked effects remain uncertain.",
					),
				),
			timeoutMs,
		);
		const budget: CallBudget = {
			remaining: () => {
				owner?.assertOpen();
				if (stopped !== undefined) throw stopped;
				const remaining = expires - performance.now();
				if (remaining <= 0)
					throw new ManagedSdkOperationError("timeout", "Managed SDK operation deadline exceeded.");
				return Math.max(1, Math.floor(remaining));
			},
		};
		const raw = this.#retain(
			Promise.resolve().then(() => {
				budget.remaining();
				this.#assertOwner(bootstrap);
				return work(budget);
			}),
			owner,
		);
		const result = Promise.race([raw, interrupted]);
		const pending: PendingCall = { interrupt };
		this.#pending.add(pending);
		void raw.then(
			() => this.#pending.delete(pending),
			() => this.#pending.delete(pending),
		);
		return result.finally(() => {
			stopped ??= new ManagedSdkOperationError("runtime_interrupted", "Managed SDK call is no longer admitted.");
			clearTimeout(timer);
		});
	}

	#retain<T>(producer: Promise<T>, owner?: ProducerScope): Promise<T> {
		owner?.retain(producer);
		this.#producers.add(producer);
		void producer.then(
			() => this.#producers.delete(producer),
			() => this.#producers.delete(producer),
		);
		return producer;
	}

	#isRegistered(key: TenantSessionKey): boolean {
		const registered = this.#registrations.get(generationIdentity(key));
		return registered !== undefined && sameTenantKey(registered, key);
	}

	async #onFrame(attachment: router.SessionAttachment, frame: router.SessionRouterFrame): Promise<void> {
		if (this.#state !== "running" && this.#state !== "draining") return this.#classify("foreign");
		if (frame.sessionId === undefined || frame.generation === undefined) return this.#classify("foreign");
		if (!this.#registrations.has(generationIdentityOf(frame.sessionId, frame.generation)))
			return this.#classify("foreign");
		const current = this.#router.attachment(frame.sessionId, frame.generation);
		if (!current || current !== attachment || !attachment.isCurrent()) return this.#classify("foreign");
		const matching = [...this.#subscriptions.values()].filter(
			subscription =>
				subscription.active &&
				subscription.tenant.sessionId === frame.sessionId &&
				subscription.tenant.generation === frame.generation &&
				(subscription.correlation === undefined || matchesCorrelation(subscription.correlation, frame)),
		);
		if (matching.length === 0) {
			this.#classify(this.#expiredCorrelations.has(frameCorrelationIdentity(frame)) ? "late" : "unmatched");
			return;
		}
		const authorized = matching.filter(subscription => this.#isCurrentToken(subscription.token));
		if (authorized.length === 0) return this.#classify("foreign");
		const identity = frameIdentity(frame);
		if (this.#seenFrameIds.has(identity)) return this.#classify("duplicate");
		this.#seenFrameIds.add(identity);
		if (this.#seenFrameIds.size > this.#maxFrameHistory)
			this.#seenFrameIds.delete(this.#seenFrameIds.values().next().value as string);
		for (const subscription of authorized) this.#deliver(subscription, frame);
	}

	#deliver(subscription: FrameSubscription, frame?: router.SessionRouterFrame): void {
		if (frame !== undefined && subscription.queued >= this.#maxFramesPerSubscription) {
			this.#classify("overflow");
			return;
		}
		subscription.queued += 1;
		const deliver = async () => {
			try {
				if (subscription.active && !subscription.deliveryFailed) {
					await this.#assertAuthorized(subscription.tenant, false, true);
					this.#assertManagedAttachment(subscription.token);
					this.#assertActiveToken(subscription.token);
					if (!subscription.active) return;
					if (subscription.correlation === undefined) {
						if (frame === undefined) return;
						if (subscription.buffered.length >= this.#maxFramesPerSubscription) this.#classify("overflow");
						else subscription.buffered.push(frame);
						return;
					}
					const frames = subscription.buffered;
					subscription.buffered = [];
					if (frame !== undefined) frames.push(frame);
					for (const observed of frames) {
						if (!matchesCorrelation(subscription.correlation, observed)) continue;
						await this.#assertAuthorized(subscription.tenant, false, true);
						this.#assertManagedAttachment(subscription.token);
						this.#assertActiveToken(subscription.token);
						if (!subscription.active) return;
						await subscription.listener({
							tenant: subscription.tenant,
							operation: subscription.operation,
							correlation: subscription.correlation,
							frame: observed,
						});
					}
				}
			} catch (error) {
				subscription.deliveryFailed = true;
				if (subscription.deliveryError === undefined) subscription.deliveryError = error;
				this.#listenerErrorCount += 1;
				this.#classify("foreign");
			} finally {
				subscription.queued -= 1;
			}
		};
		subscription.tail = this.#retain(
			subscription.tail.then(deliver, async previousError => {
				if (!subscription.deliveryFailed) {
					subscription.deliveryFailed = true;
					subscription.deliveryError = previousError;
				}
				await deliver();
			}),
		);
	}

	#cleanupSubscription(subscription: FrameSubscription): void {
		if (!subscription.active) return;
		subscription.active = false;
		this.#subscriptions.delete(subscription.id);
		if (subscription.correlation !== undefined)
			this.#expiredCorrelations.add(correlationIdentity(subscription.tenant, subscription.correlation));
		if (this.#expiredCorrelations.size > this.#maxFrameHistory)
			this.#expiredCorrelations.delete(this.#expiredCorrelations.values().next().value as string);
	}

	#clearSubscriptions(): void {
		for (const subscription of [...this.#subscriptions.values()]) this.#cleanupSubscription(subscription);
	}

	#classify(kind: ManagedSdkFrameClassification): void {
		this.#diagnostics[kind] += 1;
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Frame capacity must be a positive integer.");
	return value;
}

function lifecycleOperation(value: ManagedSdkLifecycleOperation): ManagedSdkLifecycleOperation {
	if (
		!isRecord(value) ||
		!nonEmpty(value.operationId) ||
		value.operationId.trim() !== value.operationId ||
		!nonEmpty(value.requestKey) ||
		value.requestKey.trim() !== value.requestKey ||
		/[\x00-\x1f\x7f]/.test(value.operationId + value.requestKey) ||
		typeof value.payloadHash !== "string" ||
		value.payloadHash.length !== 64 ||
		!/^[0-9a-f]{64}$/.test(value.payloadHash)
	)
		throw new TypeError("A complete durable lifecycle operation identity and SHA-256 payload hash are required.");
	return Object.freeze({
		operationId: value.operationId,
		requestKey: value.requestKey,
		payloadHash: value.payloadHash,
	});
}

function finiteTimeout(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
		throw new TypeError("Managed timeout must be a finite positive timer-safe integer.");
	return value;
}

function assertReadinessTimeout(value: unknown): void {
	if (
		value !== undefined &&
		(typeof value !== "number" || !Number.isInteger(value) || value < 4_000 || value > 60_000)
	)
		throw new TypeError("Lifecycle readinessTimeoutMs must be an integer between 4000 and 60000.");
}

function assertExternalLifecycleReadiness(request: unknown): void {
	if (!isRecord(request)) throw new TypeError("External lifecycle request is required.");
	if ("timeoutMs" in request)
		throw new TypeError(
			"External lifecycle timeoutMs must be supplied as the internal operation budget, not in the public request.",
		);
	assertReadinessTimeout(request.readinessTimeoutMs);
}

async function boundedWait<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new ManagedSdkOperationError(code, "Managed runtime drain deadline exceeded.")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function exactHistoricalString(value: unknown): value is string {
	return nonEmpty(value) && value.trim() === value && !/[\p{Cc}]/u.test(value);
}

function assertHistoricalSelection(value: ManagedSdkHistoricalSelection): void {
	if (
		!isRecord(value) ||
		Object.keys(value).some(field => !["manifestDigest", "historicalBinding", "preparedAuthority"].includes(field)) ||
		typeof value.manifestDigest !== "string" ||
		value.manifestDigest.length !== 64 ||
		!/^[a-f0-9]{64}$/.test(value.manifestDigest) ||
		!isHistoricalSessionBinding(value.historicalBinding)
	)
		throw new TypeError("Historical selection requires an exact manifest and historical binding.");
	const prepared = value.preparedAuthority;
	const fields = [
		"principalId",
		"projectId",
		"canonicalWorkspace",
		"chatId",
		"leaseId",
		"epoch",
		"requestKey",
	] as const;
	if (
		!isRecord(prepared) ||
		Object.keys(prepared).some(field => !fields.some(expected => expected === field)) ||
		!fields.every(field => exactHistoricalString(prepared[field])) ||
		!isAbsolute(prepared.canonicalWorkspace) ||
		resolve(prepared.canonicalWorkspace) !== prepared.canonicalWorkspace
	)
		throw new TypeError("Historical selection requires complete canonical prepared authority without a generation.");
	const historical = value.historicalBinding;
	if (
		!exactHistoricalString(historical.sessionId) ||
		historical.projectId !== prepared.projectId ||
		(historical.chatId !== prepared.chatId &&
			historical.chatId !== JSON.stringify([prepared.principalId, prepared.chatId])) ||
		(historical.principalId !== undefined && historical.principalId !== prepared.principalId) ||
		(historical.canonicalWorkspace !== undefined && historical.canonicalWorkspace !== prepared.canonicalWorkspace)
	)
		throw new TypeError("Historical selection source does not match its prepared tenant and workspace.");
}

function freezeHistoricalInput<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) freezeHistoricalInput(child);
		Object.freeze(value);
	}
	return value;
}

function snapshotCatalogReference(
	reference: ManagedSdkCatalogReference,
	key: TenantSessionKey,
): ManagedSdkCatalogReference {
	assertTenantKey(key);
	if (
		!isRecord(reference) ||
		Object.keys(reference).some(field => field !== "original" && field !== "expectedLifecycleHash")
	)
		throw new TypeError("Catalog requires its canonical original reservation reference.");
	const ref = structuredClone(reference);
	const original = ref.original;
	if (
		!isRecord(original) ||
		!isManagedCatalogProvisional(original) ||
		original.purpose !== "model-catalog" ||
		original.state !== "pending" ||
		original.lifecycle?.state !== "intent_prepared" ||
		original.cleanup !== undefined ||
		original.lateCreateAcknowledgement !== undefined ||
		original.lateLifecycleAcknowledgement !== undefined ||
		original.completedAt !== undefined ||
		Object.keys(original).some(
			field =>
				![
					"id",
					"ingressId",
					"kind",
					"state",
					"startedAt",
					"detail",
					"chatId",
					"projectId",
					"purpose",
					"lifecycle",
					"completedAt",
					"result",
					"acknowledgedSuccessor",
					"sessionId",
					"sessionFile",
					"activeLeaf",
					"attachment",
					"managedAuthority",
					"historicalBinding",
					"cleanup",
					"lateLifecycleAcknowledgement",
					"lateCreateAcknowledgement",
				].includes(field),
		) ||
		typeof ref.expectedLifecycleHash !== "string" ||
		ref.expectedLifecycleHash.length !== 64 ||
		!/^[a-f0-9]{64}$/.test(ref.expectedLifecycleHash)
	)
		throw new TypeError(
			"Catalog requires an original pending prepared create without a child, passive receipt or serving binding.",
		);
	managedProvisionalCreateAdmissionHash(original);
	const prepared = original.lifecycle.preparedAuthority;
	if (
		!exactHistoricalString(original.id) ||
		(original.ingressId !== undefined && !exactHistoricalString(original.ingressId)) ||
		!isAbsolute(prepared.canonicalWorkspace) ||
		resolve(prepared.canonicalWorkspace) !== prepared.canonicalWorkspace ||
		!(["principalId", "projectId", "canonicalWorkspace", "chatId", "sessionId", "leaseId", "epoch"] as const).every(
			field => exactHistoricalString(key[field]),
		) ||
		!exactHistoricalString(prepared.requestKey) ||
		prepared.principalId !== key.principalId ||
		prepared.projectId !== key.projectId ||
		prepared.canonicalWorkspace !== key.canonicalWorkspace ||
		prepared.chatId !== key.chatId ||
		prepared.leaseId !== key.leaseId ||
		prepared.epoch !== key.epoch
	)
		throw new TypeError("Catalog reservation does not match the exact tenant scope and attempt lease.");
	return freezeHistoricalInput(ref);
}

function assertTenantKey(key: TenantSessionKey): void {
	if (
		!nonEmpty(key.principalId) ||
		!nonEmpty(key.projectId) ||
		!nonEmpty(key.canonicalWorkspace) ||
		!nonEmpty(key.chatId) ||
		!nonEmpty(key.sessionId) ||
		!nonEmpty(key.leaseId) ||
		!nonEmpty(key.epoch) ||
		!Number.isSafeInteger(key.generation) ||
		key.generation <= 0
	)
		throw new TypeError(
			"Tenant session authority must contain an exact positive generation and full fence identity.",
		);
}

function assertPreparedAuthority(authority: ManagedPreparedTurnAuthority): void {
	if (
		"sessionId" in authority ||
		"generation" in authority ||
		!nonEmpty(authority.principalId) ||
		!nonEmpty(authority.projectId) ||
		!nonEmpty(authority.canonicalWorkspace) ||
		!nonEmpty(authority.chatId) ||
		!nonEmpty(authority.leaseId) ||
		!nonEmpty(authority.epoch) ||
		!nonEmpty(authority.requestKey)
	)
		throw new TypeError("Complete prepared managed authority is required for session creation.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTenantKey(value: unknown): value is TenantSessionKey {
	try {
		assertTenantKey(value as TenantSessionKey);
		return true;
	} catch {
		return false;
	}
}

function lifecycleCall<TRequest>(
	tenantOrRequest: TenantSessionKey | TRequest | ManagedLifecycleCall<TRequest>,
	request: TRequest | undefined,
): ManagedLifecycleCall<TRequest> | undefined {
	if (request !== undefined) return isTenantKey(tenantOrRequest) ? { tenant: tenantOrRequest, request } : undefined;
	if (!isRecord(tenantOrRequest) || !isTenantKey(tenantOrRequest.tenant)) return undefined;
	const tenant = tenantOrRequest.tenant;
	if ("request" in tenantOrRequest) return { tenant, request: tenantOrRequest.request as TRequest };
	const { tenant: _ignored, ...flatRequest } = tenantOrRequest;
	return { tenant, request: flatRequest as TRequest };
}

function assertLifecycleRequestAuthority(method: LifecycleMethod, tenant: TenantSessionKey, request: unknown): void {
	if (!isRecord(request)) throw new TypeError("Lifecycle request is required.");
	const actor = request.actor;
	if (!isRecord(actor) || actor.id !== tenant.principalId || actor.namespace !== "openwebui-gjc-adapter")
		throw new Error("Lifecycle actor does not match managed tenant authority.");
	const operation = method === "createExternal" ? "create" : method === "resumeExternal" ? "resume" : method;
	if (request.capability !== `session.${operation}` || (method !== "list" && !nonEmpty(request.requestKey)))
		throw new Error("Lifecycle capability and request key are required.");
	const target = request.target;
	if (!isRecord(target)) throw new Error("Lifecycle target does not match managed tenant authority.");
	const fields: Record<LifecycleMethod, readonly string[]> = {
		create: ["cwd", "body", "modelPreset", "readiness", "readinessTimeoutMs"],
		createExternal: ["kind", "path"],
		resume: ["sessionId", "cwd", "body", "modelPreset", "readinessTimeoutMs"],
		resumeExternal: ["sessionIdOrPrefix", "path"],
		fork: ["sourceSessionId", "cwd", "body", "modelPreset", "readinessTimeoutMs"],
		close: ["sessionId", "endpointGeneration", "endpointIncarnation"],
		list: ["cwd", "resolveSessionId", "cursor", "limit"],
	};
	if (Object.keys(target).some(key => !fields[method].includes(key)))
		throw new Error("Lifecycle target contains unsupported authority or broad scope.");
	if (method === "create" || method === "resume" || method === "fork")
		assertReadinessTimeout(target.readinessTimeoutMs);
	const sessionField =
		method === "resumeExternal"
			? "sessionIdOrPrefix"
			: method === "fork"
				? "sourceSessionId"
				: method === "list"
					? "resolveSessionId"
					: "sessionId";
	if (!["create", "createExternal"].includes(method) && target[sessionField] !== tenant.sessionId)
		throw new Error("Lifecycle target does not match managed tenant authority.");
	const workspaceField = method.endsWith("External") ? "path" : "cwd";
	if (method !== "close" && target[workspaceField] !== tenant.canonicalWorkspace)
		throw new Error("Lifecycle workspace does not match managed tenant authority.");
	if (method === "createExternal" && target.kind !== "existing_path")
		throw new Error("Managed lifecycle requires an existing canonical workspace.");
	if (target.endpointGeneration !== undefined && target.endpointGeneration !== tenant.generation)
		throw new Error("Lifecycle target generation does not match managed tenant authority.");
	if (target.cursor !== undefined && !nonEmpty(target.cursor)) throw new Error("Lifecycle cursor must be nonempty.");
	if (target.limit !== undefined && (!Number.isSafeInteger(target.limit) || (target.limit as number) <= 0))
		throw new Error("Lifecycle limit must be positive.");
}

function filterLifecycleList(
	outcome: Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>>,
	tenant: TenantSessionKey,
): Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>> {
	if (!outcome.ok || outcome.operation !== "session.list")
		throw new ManagedSdkOperationError("lifecycle_list_failed", "Tenant-scoped lifecycle list failed.");
	const result: unknown = outcome.result;
	if (
		!isRecord(result) ||
		!Array.isArray(result.sessions) ||
		!Number.isSafeInteger(result.indexSeq) ||
		(result.indexSeq as number) < 0 ||
		result.sessions.some(entry => !isRecord(entry) || !nonEmpty(entry.sessionId))
	)
		throw new ManagedSdkOperationError("invalid_result", "Lifecycle list cannot be safely tenant filtered.");
	const sessions = result.sessions
		.filter(
			entry =>
				entry.sessionId === tenant.sessionId &&
				entry.endpointGeneration === tenant.generation &&
				entry.cwd === tenant.canonicalWorkspace,
		)
		.map(entry => ({
			sessionId: tenant.sessionId,
			endpointGeneration: tenant.generation,
			cwd: tenant.canonicalWorkspace,
			...(typeof entry.live === "boolean" ? { live: entry.live } : {}),
			...(typeof entry.terminalUncertain === "boolean" ? { terminalUncertain: entry.terminalUncertain } : {}),
		}));
	return {
		ok: true,
		operation: "session.list",
		result: { indexSeq: result.indexSeq as number, sessions, warnings: [] },
	};
}

function assertLifecycleCloseAuthority(tenant: TenantSessionKey, request: ManagedLifecycleCloseRequest): void {
	const target = request.target;
	if (
		!isRecord(target) ||
		target.sessionId !== tenant.sessionId ||
		!Number.isSafeInteger(target.endpointGeneration) ||
		target.endpointGeneration !== tenant.generation ||
		target.endpointGeneration <= 0
	)
		throw new ManagedSdkOperationError(
			"invalid_close_authority",
			"Managed close requires a target matching the registered session and exact positive endpointGeneration.",
		);
	// SDK 0.16.4 consumes this opaque pair, but its public binding/lifecycle results do not produce it.
	if (
		typeof target.endpointIncarnation !== "string" ||
		target.endpointIncarnation.length !== 64 ||
		!/^[0-9a-f]{64}$/.test(target.endpointIncarnation)
	)
		throw new ManagedSdkOperationError(
			"exact_close_authority_unavailable",
			"Managed exact-generation close is unavailable: target.endpointIncarnation must be an opaque lowercase 64-hex value paired with endpointGeneration. SDK 0.16.4 public binding/lifecycle results do not supply it; session-ID-only and generation-only close are prohibited.",
		);
}

function tenantIdentity(key: TenantSessionKey): string {
	return [
		key.principalId,
		key.projectId,
		key.canonicalWorkspace,
		key.chatId,
		key.sessionId,
		key.generation,
		key.leaseId,
		key.epoch,
	].join("\u0000");
}

function generationIdentity(key: TenantSessionKey): string {
	return generationIdentityOf(key.sessionId, key.generation);
}

function generationIdentityOf(sessionId: string, generation: number): string {
	return `${sessionId}\u0000${generation}`;
}

function copyTenantKey(key: TenantSessionKey): TenantSessionKey {
	return Object.freeze({
		principalId: key.principalId,
		projectId: key.projectId,
		canonicalWorkspace: key.canonicalWorkspace,
		chatId: key.chatId,
		sessionId: key.sessionId,
		generation: key.generation,
		leaseId: key.leaseId,
		epoch: key.epoch,
	});
}

function sameTenantKey(left: TenantSessionKey, right: TenantSessionKey): boolean {
	return tenantIdentity(left) === tenantIdentity(right);
}

function hasCorrelation(correlation: ManagedSdkFrameCorrelation): boolean {
	return nonEmpty(correlation.commandId) || nonEmpty(correlation.turnId) || nonEmpty(correlation.publicationId);
}

function matchesCorrelation(correlation: ManagedSdkFrameCorrelation, frame: router.SessionRouterFrame): boolean {
	return (
		(correlation.commandId === undefined || correlation.commandId === frame.commandId) &&
		(correlation.turnId === undefined || correlation.turnId === frame.turnId) &&
		(correlation.publicationId === undefined || correlation.publicationId === frame.publicationId)
	);
}

function correlationIdentity(key: TenantSessionKey, correlation: ManagedSdkFrameCorrelation): string {
	return `${key.sessionId}\u0000${key.generation}\u0000${correlation.commandId ?? ""}\u0000${correlation.turnId ?? ""}\u0000${correlation.publicationId ?? ""}`;
}

function frameCorrelationIdentity(frame: router.SessionRouterFrame): string {
	return `${frame.sessionId ?? ""}\u0000${frame.generation ?? ""}\u0000${frame.commandId ?? ""}\u0000${frame.turnId ?? ""}\u0000${frame.publicationId ?? ""}`;
}

function frameIdentity(frame: router.SessionRouterFrame): string {
	return `${frame.sessionId ?? ""}\u0000${frame.generation ?? ""}\u0000${frame.commandId ?? ""}\u0000${frame.turnId ?? ""}\u0000${frame.publicationId ?? ""}\u0000${frame.seq ?? ""}`;
}
