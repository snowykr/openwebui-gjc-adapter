import { createManagedGjcTurnRunner, type ManagedGjcTurnRunner } from "../live/gjc-managed-turn-runner";
import { RuntimeSingletonLock } from "../runtime-singleton-lock";
import {
	type ManagedAuthorityActivationBinding,
	ManagedAuthorityActivationCoordinator,
	type ManagedAuthorityActivationOwner,
	type ManagedAuthorityActivationResult,
	type ManagedAuthorityActivationStorage,
	type ManagedAuthorityAdmission,
	type ManagedAuthorityLifecycleRecovery,
} from "./managed-authority-activation";
import { ManagedAuthorityFileOwner, ManagedAuthorityFileStorage } from "./managed-authority-file-storage";
import { ManagedSdkRuntime, type ManagedSdkRuntimeDeps, type TenantSessionKey } from "./managed-sdk-runtime";
import {
	type LegacyManagedSessionAuthorityEvidence,
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityMigrationCheckpoint,
	parseManagedSessionAuthorityMigrationCheckpoint,
	planManagedSessionAuthorityMigration,
} from "./managed-session-authority";

/** Process lock capability; the service never needs filesystem access beyond this boundary. */
export interface ManagedBootstrapRuntimeLock {
	release(): Promise<void>;
}

export type ManagedBootstrapPhase = "new" | "starting" | "active" | "blocked" | "failed" | "stopped";

export interface ManagedBootstrapHealth {
	readonly phase: ManagedBootstrapPhase;
	readonly ready: boolean;
	readonly routerAvailable: boolean;
	readonly epoch?: typeof MANAGED_SESSION_AUTHORITY_EPOCH;
	readonly reason?: string;
}

/** The managed surface is deliberately absent until the active epoch marker is durable. */
export interface ManagedBootstrapRunnerDependencies {
	readonly runtime: ManagedSdkRuntime;
	readonly runner: ManagedGjcTurnRunner;
	readonly tenantFence: (key: TenantSessionKey) => Promise<boolean>;
}

export interface ManagedBootstrapStartResult {
	readonly result: ManagedAuthorityActivationResult;
	readonly health: ManagedBootstrapHealth;
	readonly dependencies?: ManagedBootstrapRunnerDependencies;
}

export interface ManagedBootstrapOptions {
	/** Already resolved, adapter-owned locations. This service does not discover legacy locations. */
	readonly agentDir: string;
	readonly stateRoot: string;
	/** Existing v2 authority database below stateRoot; user artifacts are never accepted here. */
	readonly sourcePath: string;
	/** Supplies narrow, immutable legacy authority evidence. It is not a fallback execution path. */
	readonly legacyEvidence: () => Promise<LegacyManagedSessionAuthorityEvidence>;
	/** Converts the staged checkpoint to exact v3 records and Router tenant keys. */
	readonly bindings: (
		checkpoint: ManagedSessionAuthorityMigrationCheckpoint,
	) => Promise<readonly ManagedAuthorityActivationBinding[]>;
	/** Public-SDK lifecycle recovery used only to resume each exact staged binding. */
	readonly lifecycle: ManagedAuthorityLifecycleRecovery;
	/** Re-proves external lease/epoch authority for every Router boundary. */
	readonly tenantFence: (key: TenantSessionKey) => boolean | Promise<boolean>;
	readonly runtimeDeps?: Omit<ManagedSdkRuntimeDeps, "tenantFence">;
	readonly acquireRuntimeLock?: (stateRoot: string) => Promise<ManagedBootstrapRuntimeLock>;
	readonly createRuntime?: (input: {
		readonly agentDir: string;
		readonly tenantFence: ManagedSdkRuntimeDeps["tenantFence"];
	}) => ManagedSdkRuntime;
	readonly createRunner?: (runtime: ManagedSdkRuntime) => ManagedGjcTurnRunner;
	/** Deterministic persistence seams; defaults are the adapter-owned file implementations. */
	readonly createStorage?: (locations: {
		readonly stateRoot: string;
		readonly sourcePath: string;
	}) => ManagedAuthorityActivationStorage;
	readonly createOwner?: (locations: {
		readonly stateRoot: string;
		readonly sourcePath: string;
	}) => ManagedAuthorityActivationOwner;
	readonly plan?: (
		evidence: LegacyManagedSessionAuthorityEvidence,
		prior?: ManagedSessionAuthorityMigrationCheckpoint,
	) => ManagedSessionAuthorityMigrationCheckpoint;
}

/**
 * The sole composition root for the inactive managed authority epoch. It has no
 * routes, idle reaper, or model-reader dependency: callers cannot obtain a
 * managed runner until activation has durably opened admission.
 */
export class ManagedBootstrapService {
	readonly #options: ManagedBootstrapOptions;
	#phase: ManagedBootstrapPhase = "new";
	#health: ManagedBootstrapHealth = { phase: "new", ready: false, routerAvailable: false };
	#result: ManagedAuthorityActivationResult | undefined;
	#dependencies: ManagedBootstrapRunnerDependencies | undefined;
	#runtime: ManagedSdkRuntime | undefined;
	#lock: ManagedBootstrapRuntimeLock | undefined;
	#startPromise: Promise<ManagedBootstrapStartResult> | undefined;
	#disposePromise: Promise<void> | undefined;
	#admissionOpen = false;

	constructor(options: ManagedBootstrapOptions) {
		assertResolvedPath(options.agentDir, "agentDir");
		assertResolvedPath(options.stateRoot, "stateRoot");
		assertResolvedPath(options.sourcePath, "sourcePath");
		this.#options = options;
	}

	get health(): ManagedBootstrapHealth {
		return { ...this.#health };
	}

	get readiness(): boolean {
		return this.#health.ready;
	}

	get result(): ManagedAuthorityActivationResult | undefined {
		return this.#result;
	}

	get runnerDependencies(): ManagedBootstrapRunnerDependencies | undefined {
		return this.#dependencies;
	}

	start(): Promise<ManagedBootstrapStartResult> {
		if (this.#disposePromise !== undefined)
			return Promise.reject(new Error("Managed bootstrap service has been disposed."));
		if (this.#startPromise !== undefined) return this.#startPromise;
		this.#phase = "starting";
		this.#setHealth({ phase: "starting", ready: false, routerAvailable: false });
		this.#startPromise = this.#start();
		return this.#startPromise;
	}

	async dispose(): Promise<void> {
		if (this.#disposePromise === undefined) this.#disposePromise = this.#dispose();
		return await this.#disposePromise;
	}

	async #start(): Promise<ManagedBootstrapStartResult> {
		try {
			this.#lock = await (this.#options.acquireRuntimeLock ?? RuntimeSingletonLock.acquire)(this.#options.stateRoot);
			const checkpoint = parseManagedSessionAuthorityMigrationCheckpoint(
				(this.#options.plan ?? planManagedSessionAuthorityMigration)(await this.#options.legacyEvidence()),
			);
			const bindings = await this.#options.bindings(checkpoint);
			const admission: ManagedAuthorityAdmission = {
				open: async () => {
					this.#admissionOpen = true;
				},
			};
			const tenantFence = async (key: TenantSessionKey): Promise<boolean> =>
				this.#admissionOpen && (await this.#options.tenantFence(key));
			this.#runtime =
				this.#options.createRuntime?.({ agentDir: this.#options.agentDir, tenantFence }) ??
				new ManagedSdkRuntime({
					agentDir: this.#options.agentDir,
					deps: { ...this.#options.runtimeDeps, tenantFence },
				});
			const activation = await new ManagedAuthorityActivationCoordinator({
				manifest: {
					authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
					digest: checkpoint.digests.targetManifestDigest,
					checkpoint,
					records: checkpoint.records,
				},
				bindings,
				storage: (this.#options.createStorage ?? (locations => new ManagedAuthorityFileStorage(locations)))({
					stateRoot: this.#options.stateRoot,
					sourcePath: this.#options.sourcePath,
				}),
				owner: (this.#options.createOwner ?? (locations => new ManagedAuthorityFileOwner(locations)))({
					stateRoot: this.#options.stateRoot,
					sourcePath: this.#options.sourcePath,
				}),
				runtime: this.#runtime,
				lifecycle: this.#options.lifecycle,
				admission,
			}).activate();
			this.#result = activation;
			if (
				activation.phase !== "active" ||
				!activation.ready ||
				activation.epoch !== MANAGED_SESSION_AUTHORITY_EPOCH
			) {
				await this.#cleanup();
				this.#phase = activation.phase === "blocked" ? "blocked" : "failed";
				this.#setHealth({
					phase: this.#phase,
					ready: false,
					routerAvailable: activation.routerAvailable,
					...(activation.reason === undefined ? {} : { reason: activation.reason }),
				});
				return { result: activation, health: this.health };
			}
			await this.#recoverActiveRuntime(bindings);
			this.#phase = "active";
			this.#dependencies = Object.freeze({
				runtime: this.#runtime,
				runner: (this.#options.createRunner ?? createManagedGjcTurnRunner)(this.#runtime),
				tenantFence,
			});
			this.#setHealth({
				phase: "active",
				ready: true,
				routerAvailable: true,
				epoch: MANAGED_SESSION_AUTHORITY_EPOCH,
			});
			return { result: activation, health: this.health, dependencies: this.#dependencies };
		} catch (error) {
			const reason = message(error);
			this.#result = { phase: "failed", ready: false, routerAvailable: false, reason };
			try {
				await this.#cleanup();
			} catch (cleanupError) {
				this.#result = { ...this.#result, reason: `${reason}; cleanup failed: ${message(cleanupError)}` };
			}
			this.#phase = "failed";
			this.#setHealth({ phase: "failed", ready: false, routerAvailable: false, reason: this.#result.reason });
			return { result: this.#result, health: this.health };
		}
	}

	async #recoverActiveRuntime(bindings: readonly ManagedAuthorityActivationBinding[]): Promise<void> {
		if (this.#runtime?.state === "running") return;
		const runtime = this.#runtime;
		if (runtime === undefined) throw new Error("Managed runtime is unavailable after activation.");
		await runtime.start();
		for (const binding of bindings) {
			await this.#options.lifecycle.resume(binding.record, binding.tenant);
			runtime.registerTenant(binding.tenant);
			await runtime.reconcile();
			const attachment = await runtime.acquireAttachment(binding.tenant);
			if (attachment.generation !== binding.tenant.generation || !attachment.attachment.isCurrent())
				throw new Error("Exact current Router attachment proof is required.");
		}
	}

	async #dispose(): Promise<void> {
		this.#admissionOpen = false;
		this.#dependencies = undefined;
		try {
			await this.#cleanup();
			this.#phase = "stopped";
			this.#setHealth({ phase: "stopped", ready: false, routerAvailable: false });
		} catch (error) {
			this.#phase = "failed";
			this.#setHealth({ phase: "failed", ready: false, routerAvailable: false, reason: message(error) });
			throw error;
		}
	}

	async #cleanup(): Promise<void> {
		this.#admissionOpen = false;
		const runtime = this.#runtime;
		const lock = this.#lock;
		this.#runtime = undefined;
		this.#lock = undefined;
		const failures: unknown[] = [];
		try {
			await runtime?.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			await lock?.release();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Managed bootstrap cleanup failed.");
	}

	#setHealth(health: ManagedBootstrapHealth): void {
		this.#health = Object.freeze({ ...health });
	}
}

function assertResolvedPath(value: string, label: string): void {
	if (typeof value !== "string" || !value.startsWith("/"))
		throw new TypeError(`A resolved absolute ${label} is required.`);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : "Managed bootstrap failed.";
}
