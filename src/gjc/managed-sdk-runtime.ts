import { lifecycle, router } from "@gajae-code/coding-agent/sdk";
import type { ManagedPreparedTurnAuthority } from "./turn-runner";

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

export interface ManagedSdkAttachment {
	readonly tenant: TenantSessionKey;
	readonly generation: number;
	readonly attachment: router.SessionAttachment;
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
	readonly tenantFence?: (key: TenantSessionKey) => boolean | Promise<boolean>;
	readonly maxFrameSubscriptions?: number;
	readonly maxFramesPerSubscription?: number;
	readonly maxFrameHistory?: number;
}

export interface ManagedSdkRuntimeOptions {
	readonly agentDir: string;
	readonly routerDeps?: Omit<router.SessionRouterDeps, "onFrame">;
	readonly deps?: ManagedSdkRuntimeDeps;
}

interface FrameSubscription {
	readonly id: number;
	readonly tenant: TenantSessionKey;
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

/** A session/generation-scoped subscription that is bound only from a Router acknowledgement. */
export interface ManagedSdkPendingFrameSubscription extends ManagedSdkFrameSubscription {
	bind(correlation: ManagedSdkFrameCorrelation): void;
}

const DEFAULT_MAX_SUBSCRIPTIONS = 128;
const DEFAULT_MAX_FRAMES_PER_SUBSCRIPTION = 64;
const DEFAULT_MAX_FRAME_HISTORY = 256;

/**
 * Process-owned public-SDK foundation. It intentionally has no product callsite:
 * only opaque Router attachments cross its authority boundary.
 */
export class ManagedSdkRuntime {
	readonly #router: router.SessionRouter;
	readonly #lifecycle: ReturnType<typeof lifecycle.createSessionLifecycleService>;
	readonly #tenantFence: (key: TenantSessionKey) => boolean | Promise<boolean>;
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
	#reconcileTail: Promise<void> = Promise.resolve();
	#nextSubscriptionId = 1;

	constructor(options: ManagedSdkRuntimeOptions) {
		if (!nonEmpty(options.agentDir)) throw new TypeError("agentDir is required.");
		const deps = options.deps ?? {};
		this.#tenantFence = deps.tenantFence ?? (() => true);
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

	createLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["create"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.create(value));
	}

	createExternalLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0]
			| ManagedLifecycleCall<
					Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0]
			  >,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.createExternal(value));
	}

	createPreparedExternalLifecycleSession(
		authority: ManagedPreparedTurnAuthority,
		request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]> {
		return this.#invokePreparedCreate(authority, request);
	}

	resumeExternalLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>[0]
			| ManagedLifecycleCall<
					Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>[0]
			  >,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resumeExternal"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.resumeExternal(value));
	}

	forkLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["fork"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.fork(value));
	}

	resumeLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["resume"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.resume(value));
	}

	closeLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["close"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.close(value));
	}

	deleteLifecycleSession(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["delete"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.delete(value));
	}

	listLifecycleSessions(
		tenantOrRequest:
			| TenantSessionKey
			| Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>[0]
			| ManagedLifecycleCall<Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>[0]>,
		request?: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]>[0],
	): ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["list"]> {
		return this.#invokeLifecycle(tenantOrRequest, request, value => this.#lifecycle.list(value));
	}

	frameDiagnostics(): ManagedSdkFrameDiagnostics {
		return { ...this.#diagnostics, listenerError: this.#listenerErrorCount };
	}

	registerTenant(key: TenantSessionKey): void {
		assertTenantKey(key);
		const ownedKey = generationIdentity(key);
		const registered = this.#registrations.get(ownedKey);
		if (registered !== undefined && !sameTenantKey(registered, key))
			throw new Error("Session generation is already owned by another managed tenant.");
		this.#registrations.set(ownedKey, copyTenantKey(key));
	}

	/** Reconciles a credential-free lifecycle identity before exposing its exact tenant authority. */
	async registerLifecycleTenant(key: TenantSessionKey): Promise<ManagedSdkAttachment> {
		assertTenantKey(key);
		this.registerTenant(key);
		await this.reconcile();
		const attachment = await this.acquireAttachment(key);
		if (!attachment.attachment.isCurrent()) throw new Error("Lifecycle tenant attachment is no longer current.");
		return attachment;
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
		this.#startPromise = (async () => {
			try {
				await this.#router.start();
				if (this.#state === "starting") this.#state = "running";
			} catch (error) {
				this.#state = "failed";
				throw error;
			} finally {
				this.#bootstrapAdmission = false;
			}
		})();
		return this.#startPromise;
	}

	stop(): Promise<void> {
		if (this.#stopPromise !== undefined) return this.#stopPromise;
		if (this.#state === "stopped") {
			this.#stopPromise = Promise.resolve();
			return this.#stopPromise;
		}
		this.#state = this.#state === "starting" ? "draining" : "stopping";
		this.#bootstrapAdmission = false;
		this.#stopPromise = (async () => {
			try {
				await this.#startPromise?.catch(() => undefined);
				this.#state = "stopping";
				await this.#router.stop();
				this.#state = "stopped";
			} catch (error) {
				this.#state = "failed";
				throw error;
			} finally {
				this.#clearSubscriptions();
			}
		})();
		return this.#stopPromise;
	}

	async dispose(): Promise<void> {
		await this.stop();
	}

	/** Serializes explicit reconciliation without exposing Router implementation state. */
	reconcile(): Promise<void> {
		const next = this.#reconcileTail.then(async () => {
			if (this.#state !== "running") throw new Error("Managed SDK runtime is not running.");
			await this.#router.reconcile();
		});
		this.#reconcileTail = next.catch(() => undefined);
		return next;
	}

	async acquireAttachment(key: TenantSessionKey): Promise<ManagedSdkAttachment> {
		await this.#assertAuthorized(key, this.#state === "starting" && this.#bootstrapAdmission);
		const attachment = this.#router.attachment(key.sessionId, key.generation);
		if (!attachment?.isCurrent()) throw new Error("Current Router attachment is required.");
		return Object.freeze({ tenant: copyTenantKey(key), generation: key.generation, attachment });
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
		const key = managed.tenant;
		await this.#assertAuthorized(key, false);
		this.#assertManagedAttachment(managed);
		const current = this.#router.attachment(key.sessionId, key.generation);
		if (!current || current !== managed.attachment || !current.isCurrent())
			throw new Error("Current Router attachment is required.");
		return await this.#router.request(key.sessionId, frame, key.generation, managed.attachment, options as never);
	}

	async generationStatus(key: TenantSessionKey): Promise<router.SessionGenerationStatus> {
		await this.#assertAuthorized(key, false);
		return await this.#router.generationStatus(key.sessionId, key.generation);
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
		if (!managed.attachment.isCurrent()) throw new Error("Registered current tenant attachment is required.");
		const current = this.#router.attachment(managed.tenant.sessionId, managed.generation);
		if (current !== managed.attachment) throw new Error("Current Router attachment is required.");
		if (this.#subscriptions.size >= this.#maxSubscriptions) {
			this.#classify("overflow");
			throw new Error("Managed SDK frame subscription capacity exceeded.");
		}
		const subscription: FrameSubscription = {
			id: this.#nextSubscriptionId++,
			tenant: copyTenantKey(managed.tenant),
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
			await subscription.tail;
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
		if (!managed.attachment.isCurrent()) throw new Error("Registered current tenant attachment is required.");
		const current = this.#router.attachment(managed.tenant.sessionId, managed.generation);
		if (current !== managed.attachment) throw new Error("Current Router attachment is required.");
		if (this.#subscriptions.size >= this.#maxSubscriptions) {
			this.#classify("overflow");
			throw new Error("Managed SDK frame subscription capacity exceeded.");
		}
		const subscription: FrameSubscription = {
			id: this.#nextSubscriptionId++,
			tenant: copyTenantKey(managed.tenant),
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
			await subscription.tail;
			if (subscription.deliveryFailed) throw subscription.deliveryError;
		};
		unsubscribe.bind = correlation => {
			if (!subscription.active) throw new Error("Managed SDK frame subscription is closed.");
			if (!hasCorrelation(correlation)) throw new TypeError("Acknowledged frame correlation is required.");
			if (subscription.correlation !== undefined)
				throw new Error("Managed SDK frame subscription is already bound.");
			subscription.correlation = { ...correlation };
			for (const frame of subscription.buffered) {
				if (matchesCorrelation(subscription.correlation, frame)) this.#deliver(subscription, frame);
			}
			subscription.buffered = [];
		};
		return unsubscribe;
	}

	async #invokeLifecycle<TRequest, TResult>(
		tenantOrRequest: TenantSessionKey | TRequest | ManagedLifecycleCall<TRequest>,
		request: TRequest | undefined,
		invoke: (request: TRequest) => Promise<TResult>,
	): Promise<TResult> {
		const call = lifecycleCall(tenantOrRequest, request);
		if (call === undefined)
			throw new Error("Complete managed tenant authority is required for lifecycle operations.");
		await this.#assertAuthorized(call.tenant, false);
		assertLifecycleRequestAuthority(call.tenant, call.request);
		return await invoke(call.request);
	}

	async #invokePreparedCreate(
		authority: ManagedPreparedTurnAuthority,
		request: Parameters<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>[0],
	): Promise<Awaited<ReturnType<ReturnType<typeof lifecycle.createSessionLifecycleService>["createExternal"]>>> {
		assertPreparedAuthority(authority);
		if (this.#state !== "running") throw new Error("Managed SDK runtime is not running.");
		if (request.actor.id !== authority.principalId)
			throw new Error("Lifecycle actor does not match prepared managed authority.");
		if (request.target.kind !== "existing_path" || request.target.path !== authority.canonicalWorkspace)
			throw new Error("Lifecycle create target does not match prepared managed authority.");
		return await this.#lifecycle.createExternal(request);
	}

	async #assertAuthorized(key: TenantSessionKey, bootstrap: boolean): Promise<void> {
		assertTenantKey(key);
		if (this.#state !== "running" && !bootstrap) throw new Error("Managed SDK runtime is not running.");
		if (!this.#isRegistered(key)) throw new Error("Tenant is not registered for this session authority.");
		if (!(await this.#tenantFence(key))) throw new Error("Tenant authority fence was lost.");
		if (!this.#isRegistered(key)) throw new Error("Tenant registration changed during authorization.");
	}

	#assertManagedAttachment(managed: ManagedSdkAttachment): void {
		assertTenantKey(managed.tenant);
		if (managed.generation !== managed.tenant.generation) throw new Error("Exact tenant generation is required.");
		if (!this.#isRegistered(managed.tenant)) throw new Error("Registered current tenant attachment is required.");
	}

	#isRegistered(key: TenantSessionKey): boolean {
		const registered = this.#registrations.get(generationIdentity(key));
		return registered !== undefined && sameTenantKey(registered, key);
	}

	async #onFrame(attachment: router.SessionAttachment, frame: router.SessionRouterFrame): Promise<void> {
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
		const authorized = (
			await Promise.all(
				matching.map(async subscription =>
					this.#isRegistered(subscription.tenant) && (await this.#tenantFence(subscription.tenant))
						? this.#isRegistered(subscription.tenant)
							? subscription
							: undefined
						: undefined,
				),
			)
		).filter((subscription): subscription is FrameSubscription => subscription !== undefined);
		if (authorized.length === 0) return this.#classify("foreign");
		const identity = frameIdentity(frame);
		if (this.#seenFrameIds.has(identity)) return this.#classify("duplicate");
		this.#seenFrameIds.add(identity);
		if (this.#seenFrameIds.size > this.#maxFrameHistory)
			this.#seenFrameIds.delete(this.#seenFrameIds.values().next().value as string);
		for (const subscription of authorized) {
			if (subscription.correlation === undefined) {
				if (subscription.buffered.length >= this.#maxFramesPerSubscription) this.#classify("overflow");
				else subscription.buffered.push(frame);
				continue;
			}
			this.#deliver(subscription, frame);
		}
	}

	#deliver(subscription: FrameSubscription, frame: router.SessionRouterFrame): void {
		if (subscription.queued >= this.#maxFramesPerSubscription) {
			this.#classify("overflow");
			return;
		}
		subscription.queued += 1;
		const deliver = async () => {
			try {
				if (subscription.active && subscription.correlation !== undefined)
					await subscription.listener({
						tenant: subscription.tenant,
						operation: subscription.operation,
						correlation: subscription.correlation,
						frame,
					});
			} catch (error) {
				subscription.deliveryFailed = true;
				if (subscription.deliveryError === undefined) subscription.deliveryError = error;
				this.#listenerErrorCount += 1;
			} finally {
				subscription.queued -= 1;
			}
		};
		subscription.tail = subscription.tail.then(deliver, async previousError => {
			if (!subscription.deliveryFailed) {
				subscription.deliveryFailed = true;
				subscription.deliveryError = previousError;
			}
			await deliver();
		});
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

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
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

function assertLifecycleRequestAuthority(tenant: TenantSessionKey, request: unknown): void {
	if (!isRecord(request)) throw new TypeError("Lifecycle request is required.");
	const actor = request.actor;
	if (isRecord(actor) && actor.id !== tenant.principalId)
		throw new Error("Lifecycle actor does not match managed tenant authority.");
	const target = request.target;
	if (!isRecord(target)) return;
	const targetSessionId = target.sessionId ?? target.sourceSessionId;
	if (targetSessionId !== undefined && targetSessionId !== tenant.sessionId)
		throw new Error("Lifecycle target does not match managed tenant authority.");
	if (target.endpointGeneration !== undefined && target.endpointGeneration !== tenant.generation)
		throw new Error("Lifecycle target generation does not match managed tenant authority.");
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
	return Object.freeze({ ...key });
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
