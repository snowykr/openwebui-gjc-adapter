import type { ManagedBootstrapService } from "./gjc/managed-bootstrap";
import type { ManagedSdkRuntimeDependency } from "./gjc/managed-sdk-dependency";
import type { AdapterHealthCheck, AdapterReadinessOptions } from "./health";
import type { AdapterRouteDependencies } from "./live/openai-routes";
import type { RuntimeSingletonLock } from "./runtime-singleton-lock";
import { createAdapterRequestHandler } from "./server-request-handler";
import type { AdapterRuntimeConfig } from "./server-runtime-readiness";

// Bun accepts idle timeouts up to 255 seconds; zero disables the timeout.
const BUN_SERVER_IDLE_TIMEOUT_MAX_SECONDS = 255;
const BUN_SERVER_IDLE_TIMEOUT_DISABLED = 0;
const IDLE_TIMEOUT_HEADROOM_SECONDS = 1;

export interface AdapterServerOptions {
	host: string;
	port: number;
	runtimeRoot: string;
	runtimeLock: RuntimeSingletonLock;
	/** Already-started managed authority composition; it owns its runtime lifecycle. */
	managedBootstrap?: ManagedBootstrapService;
	managedSdkRuntime?: ManagedSdkRuntimeOwnership;
	shutdownCleanup?: () => void | Promise<void>;
	checks?: readonly AdapterHealthCheck[];
	readiness?: AdapterReadinessOptions;
	runtime?: AdapterRuntimeConfig;
	routes?: AdapterRouteDependencies;
	turnTimeoutMs: number;
}

export interface ManagedSdkRuntimeOwnership {
	readonly runtime: ManagedSdkRuntimeDependency;
	readonly start: boolean;
	readonly health: ManagedSdkRuntimeHealth;
	dispose(): Promise<void>;
}

export interface ManagedSdkRuntimeHealth {
	phase: "not_started" | "starting" | "ready" | "degraded";
	reason?: string;
}
export interface AdapterServerHandle {
	url: string;
	stop(): Promise<void>;
}

export async function startAdapterServer(options: AdapterServerOptions): Promise<AdapterServerHandle> {
	const lock = options.runtimeLock;
	try {
		await startManagedSdkRuntime(options.managedSdkRuntime);
		const idleTimeout = idleTimeoutSeconds(options.turnTimeoutMs);
		const server = Bun.serve({
			hostname: options.host,
			port: options.port,
			idleTimeout,
			fetch: createAdapterRequestHandler({
				checks: options.checks,
				readiness: options.readiness,
				routes: options.routes,
				runtime: options.runtime,
			}),
		});
		let shutdownPromise: Promise<void> | undefined;
		const shutdown = async (): Promise<void> => {
			const failures: unknown[] = [];
			const concurrentStops: Promise<unknown>[] = [];
			try {
				concurrentStops.push(Promise.resolve(server.stop()));
			} catch (error) {
				failures.push(error);
			}
			try {
				concurrentStops.push(Promise.resolve(options.routes?.runner.stop?.()));
			} catch (error) {
				failures.push(error);
			}
			for (const result of await Promise.allSettled(concurrentStops))
				if (result.status === "rejected") failures.push(result.reason);
			try {
				await options.managedBootstrap?.dispose();
			} catch (error) {
				failures.push(error);
			}
			try {
				await options.managedSdkRuntime?.dispose();
			} catch (error) {
				failures.push(error);
			}
			try {
				await options.shutdownCleanup?.();
			} catch (error) {
				failures.push(error);
			}
			try {
				await lock.release();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length > 0) throw new AggregateError(failures, "Server cleanup failed");
		};
		return {
			url: server.url.toString(),
			stop(): Promise<void> {
				if (shutdownPromise === undefined) shutdownPromise = shutdown();
				return shutdownPromise;
			},
		};
	} catch (error) {
		const failures: unknown[] = [error];
		try {
			await options.routes?.runner.stop?.();
		} catch (stopError) {
			failures.push(stopError);
		}
		try {
			await options.managedBootstrap?.dispose();
		} catch (disposeError) {
			failures.push(disposeError);
		}
		try {
			await options.managedSdkRuntime?.dispose();
		} catch (disposeError) {
			failures.push(disposeError);
		}
		try {
			await options.shutdownCleanup?.();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		try {
			await lock.release();
		} catch (releaseError) {
			failures.push(releaseError);
		}
		if (failures.length > 1) throw new AggregateError(failures, "Server initialization cleanup failed");
		throw error;
	}
}

async function startManagedSdkRuntime(ownership: ManagedSdkRuntimeOwnership | undefined): Promise<void> {
	if (ownership === undefined || !ownership.start) return;
	ownership.health.phase = "starting";
	delete ownership.health.reason;
	try {
		await ownership.runtime.start();
		await ownership.runtime.reconcile();
		ownership.health.phase = "ready";
	} catch {
		ownership.health.phase = "degraded";
		ownership.health.reason = "Managed SDK runtime bootstrap or reconciliation failed.";
	}
}
function idleTimeoutSeconds(turnTimeoutMs: number): number {
	if (!Number.isFinite(turnTimeoutMs) || !Number.isInteger(turnTimeoutMs) || turnTimeoutMs <= 0)
		throw new TypeError("turnTimeoutMs must be a positive finite integer");
	const requiredSeconds = Math.ceil(turnTimeoutMs / 1_000) + IDLE_TIMEOUT_HEADROOM_SECONDS;
	return requiredSeconds > BUN_SERVER_IDLE_TIMEOUT_MAX_SECONDS ? BUN_SERVER_IDLE_TIMEOUT_DISABLED : requiredSeconds;
}
