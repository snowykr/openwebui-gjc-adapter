import { isAbsolute, resolve } from "node:path";
import { ManagedOperationDeadline } from "./gjc/managed-operation-deadline";
import type { ManagedSdkRuntime, TenantSessionKey } from "./gjc/managed-sdk-runtime";
import { SESSION_AUTHORITY_V3_EPOCH } from "./gjc/session-authority-v3";
import type { SessionMapping } from "./gjc/session-mapping-store";
import type { SessionV3FileBackedMappingStore } from "./gjc/session-v3-file-backed-mapping-store";
import type { ManagedTurnAuthority } from "./gjc/turn-runner";
import { createManagedGjcTurnRunner, type ManagedGjcTurnRunner } from "./live/gjc-managed-turn-runner";

export type ActiveManagedV3TenantFence = (key: TenantSessionKey) => boolean | Promise<boolean>;

export interface StartActiveManagedRuntimeOptions {
	readonly mappings: SessionV3FileBackedMappingStore;
	readonly runtime: ManagedSdkRuntime;
	readonly turnTimeoutMs?: number;
	/** Re-proves the live external lease and epoch; the runtime's internal fence is not a substitute. */
	readonly liveTenantFence: ActiveManagedV3TenantFence;
}

export interface ActiveManagedV3Runtime {
	readonly runtime: ManagedSdkRuntime;
	readonly runner: ManagedGjcTurnRunner;
	readonly tenantFence: ActiveManagedV3TenantFence;
	dispose(): Promise<void>;
}

interface RuntimeStart {
	readonly options: StartActiveManagedRuntimeOptions;
	readonly promise: Promise<ActiveManagedV3Runtime>;
}

const starts = new WeakMap<ManagedSdkRuntime, RuntimeStart>();

/**
 * Starts the direct canonical-V3 serving path. It admits only exact, durable
 * managed authorities; no legacy attachment or migration evidence crosses this
 * boundary.
 */
export function startActiveManagedRuntime(options: StartActiveManagedRuntimeOptions): Promise<ActiveManagedV3Runtime> {
	assertOptions(options);
	options.mappings.assertServingReady();
	const existing = starts.get(options.runtime);
	if (existing !== undefined) {
		if (
			existing.options.mappings !== options.mappings ||
			existing.options.liveTenantFence !== options.liveTenantFence ||
			existing.options.turnTimeoutMs !== options.turnTimeoutMs
		)
			return Promise.reject(new Error("Managed V3 runtime is already owned by different startup dependencies."));
		return existing.promise;
	}
	const promise = start(options);
	starts.set(options.runtime, { options, promise });
	void promise.catch(() => starts.delete(options.runtime));
	return promise;
}

async function start(options: StartActiveManagedRuntimeOptions): Promise<ActiveManagedV3Runtime> {
	const deadline = new ManagedOperationDeadline(options.turnTimeoutMs, "V3 runtime startup");
	const step = <T>(action: () => Promise<T>): Promise<T> => {
		deadline.remaining();
		return deadline.wait(action());
	};
	try {
		await step(() => options.runtime.start());
		const identities = new Set<string>();
		const generations = new Set<string>();
		for (const mapping of options.mappings.mappingRecordsIterable()) {
			deadline.remaining();
			const tenant = tenantFor(mapping);
			const identity = JSON.stringify([tenant.principalId, tenant.chatId]);
			const generationIdentity = JSON.stringify([tenant.sessionId, tenant.generation]);
			if (identities.has(identity) || generations.has(generationIdentity))
				throw new Error("Duplicate or conflicting canonical V3 mapping identity.");
			identities.add(identity);
			generations.add(generationIdentity);
			options.runtime.registerTenant(tenant);
			// ManagedSdkRuntime serializes this boundary. Reconcile before every
			// attachment acquisition so a replaced or provisional generation cannot escape.
			await step(() => options.runtime.reconcile());
			const acquired = await step(() => options.runtime.acquireAttachment(tenant));
			if (acquired.generation !== tenant.generation || !acquired.isCurrent())
				throw new Error("Canonical V3 mapping attachment is stale.");
			const generation = await step(() => options.runtime.generationStatus(tenant));
			if (generation.status !== "current")
				throw new Error("Canonical V3 mapping generation is replaced, provisional, or requires recovery.");
			if (!(await step(async () => await options.liveTenantFence(tenant))))
				throw new Error("External live tenant lease/epoch fence was lost.");
		}
		deadline.remaining();
		const tenantFence: ActiveManagedV3TenantFence = async key =>
			isTenantKey(key) && (await options.liveTenantFence(key));
		let disposePromise: Promise<void> | undefined;
		return Object.freeze({
			runtime: options.runtime,
			runner: createManagedGjcTurnRunner(options.runtime, options.turnTimeoutMs),
			tenantFence,
			dispose: async () => {
				disposePromise ??= options.runtime.dispose();
				await disposePromise;
			},
		});
	} catch (error) {
		try {
			await deadline.wait(options.runtime.dispose());
		} catch (disposeError) {
			if (disposeError === error) throw error;
			throw new AggregateError([error, disposeError], "Managed V3 runtime startup and cleanup failed.");
		}
		throw error;
	} finally {
		deadline.close();
	}
}

function tenantFor(mapping: SessionMapping): TenantSessionKey {
	if (mapping.attachment !== undefined) throw new Error("Canonical V3 startup rejects legacy attachment evidence.");
	const authority = mapping.managedAuthority;
	if (authority === undefined || !isManagedV3Authority(authority))
		throw new Error("Canonical V3 startup requires complete managed authority at the exact V3 epoch.");
	if (
		mapping.principalId !== authority.principalId ||
		mapping.projectId !== authority.projectId ||
		mapping.chatId !== authority.chatId ||
		mapping.sessionId !== authority.sessionId
	)
		throw new Error("Canonical V3 mapping identity conflicts with its managed authority.");
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
	};
}

function isManagedV3Authority(authority: ManagedTurnAuthority): boolean {
	const value = authority as ManagedTurnAuthority & { readonly authorityEpoch?: unknown };
	return value.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH && isTenantKey(value) && nonEmpty(value.requestKey);
}

function isTenantKey(value: TenantSessionKey): boolean {
	return (
		nonEmpty(value.principalId) &&
		nonEmpty(value.projectId) &&
		nonEmpty(value.canonicalWorkspace) &&
		isAbsolute(value.canonicalWorkspace) &&
		resolve(value.canonicalWorkspace) === value.canonicalWorkspace &&
		nonEmpty(value.chatId) &&
		nonEmpty(value.sessionId) &&
		Number.isSafeInteger(value.generation) &&
		value.generation > 0 &&
		nonEmpty(value.leaseId) &&
		nonEmpty(value.epoch)
	);
}

function assertOptions(options: StartActiveManagedRuntimeOptions): void {
	if (options === undefined || options === null || typeof options !== "object")
		throw new TypeError("Managed V3 runtime startup options are required.");
	if (
		options.turnTimeoutMs !== undefined &&
		(!Number.isSafeInteger(options.turnTimeoutMs) ||
			options.turnTimeoutMs <= 0 ||
			options.turnTimeoutMs > 2_147_483_647)
	)
		throw new TypeError("Managed turnTimeoutMs must be a positive finite timer-safe integer.");
	if (
		options.runtime === undefined ||
		typeof options.runtime.start !== "function" ||
		typeof options.runtime.dispose !== "function" ||
		typeof options.runtime.reconcile !== "function" ||
		typeof options.runtime.registerTenant !== "function" ||
		typeof options.runtime.acquireAttachment !== "function" ||
		typeof options.runtime.generationStatus !== "function"
	)
		throw new TypeError("A process-owned ManagedSdkRuntime is required.");
	if (typeof options.liveTenantFence !== "function") throw new TypeError("An external live tenant fence is required.");
	if (options.mappings === undefined || typeof options.mappings.mappingRecordsIterable !== "function")
		throw new TypeError("A canonical SessionV3FileBackedMappingStore is required.");
	if (typeof options.mappings.assertServingReady !== "function")
		throw new TypeError("Canonical V3 serving readiness validation is required.");
	if (options.mappings.epoch !== SESSION_AUTHORITY_V3_EPOCH)
		throw new Error("Managed V3 startup requires the canonical V3 mapping store epoch.");
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
