import type { AdapterHealthCheck, AdapterReadinessOptions } from "./health";
import type { AdapterRouteDependencies } from "./live/openai-routes";
import { RuntimeSingletonLock } from "./runtime-singleton-lock";
import { createAdapterRequestHandler } from "./server-request-handler";
import type { AdapterRuntimeConfig } from "./server-runtime-readiness";

// Keeps Bun's transport timeout aligned with the adapter's bounded 180-second turn budget.
const BUN_SERVER_IDLE_TIMEOUT_SECONDS = 180;

export interface AdapterServerOptions {
	host: string;
	port: number;
	runtimeRoot: string;
	checks?: readonly AdapterHealthCheck[];
	readiness?: AdapterReadinessOptions;
	runtime?: AdapterRuntimeConfig;
	routes?: AdapterRouteDependencies;
}
export interface AdapterServerHandle {
	url: string;
	stop(): Promise<void>;
}

export async function startAdapterServer(options: AdapterServerOptions): Promise<AdapterServerHandle> {
	const lock = await RuntimeSingletonLock.acquire(options.runtimeRoot);
	try {
		const server = Bun.serve({
			hostname: options.host,
			port: options.port,
			idleTimeout: BUN_SERVER_IDLE_TIMEOUT_SECONDS,
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
				const results = await Promise.allSettled([server.stop(), options.routes?.runner.stop?.(), lock.release()]);
				const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
				if (failures.length > 0)
					throw new AggregateError(
						failures.map(result => result.reason),
						"Server cleanup failed",
					);
			},
		};
	} catch (error) {
		await lock.release();
		throw error;
	}
}
