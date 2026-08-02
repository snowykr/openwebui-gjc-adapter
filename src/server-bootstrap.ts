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
	checks?: readonly AdapterHealthCheck[];
	readiness?: AdapterReadinessOptions;
	runtime?: AdapterRuntimeConfig;
	routes?: AdapterRouteDependencies;
	turnTimeoutMs: number;
}
export interface AdapterServerHandle {
	url: string;
	stop(): Promise<void>;
}

export async function startAdapterServer(options: AdapterServerOptions): Promise<AdapterServerHandle> {
	const lock = options.runtimeLock;
	try {
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
		return {
			url: server.url.toString(),
			async stop(): Promise<void> {
				const failures: unknown[] = [];
				try {
					await server.stop();
				} catch (error) {
					failures.push(error);
				}
				try {
					await options.routes?.runner.stop?.();
				} catch (error) {
					failures.push(error);
				}
				try {
					await lock.release();
				} catch (error) {
					failures.push(error);
				}
				if (failures.length > 0) throw new AggregateError(failures, "Server cleanup failed");
			},
		};
	} catch (error) {
		let startupError: unknown = error;
		try {
			await options.routes?.runner.stop?.();
		} catch (stopError) {
			startupError = new AggregateError([startupError, stopError], "Server initialization cleanup failed");
		}
		try {
			await lock.release();
		} catch (releaseError) {
			startupError = new AggregateError([startupError, releaseError], "Server initialization cleanup failed");
		}
		throw startupError;
	}
}
function idleTimeoutSeconds(turnTimeoutMs: number): number {
	if (!Number.isFinite(turnTimeoutMs) || !Number.isInteger(turnTimeoutMs) || turnTimeoutMs <= 0)
		throw new TypeError("turnTimeoutMs must be a positive finite integer");
	const requiredSeconds = Math.ceil(turnTimeoutMs / 1_000) + IDLE_TIMEOUT_HEADROOM_SECONDS;
	return requiredSeconds > BUN_SERVER_IDLE_TIMEOUT_MAX_SECONDS ? BUN_SERVER_IDLE_TIMEOUT_DISABLED : requiredSeconds;
}
