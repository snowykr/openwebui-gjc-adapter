import type { AdapterServerOptions } from "./server";

export async function cleanupUnstartedAdapter(options: AdapterServerOptions, error: unknown): Promise<never> {
	const failures: unknown[] = [error];
	try {
		await options.routes?.runner.stop?.();
	} catch (stopError) {
		failures.push(stopError);
	}
	try {
		await options.shutdownCleanup?.();
	} catch (cleanupError) {
		failures.push(cleanupError);
	}
	try {
		await options.runtimeLock.release();
	} catch (releaseError) {
		failures.push(releaseError);
	}
	if (failures.length > 1) throw new AggregateError(failures, "Configured adapter startup cleanup failed");
	throw error;
}
