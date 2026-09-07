import type { AdapterServerOptions } from "./server";

export async function cleanupUnstartedAdapter(options: AdapterServerOptions, error: unknown): Promise<never> {
	const failures: unknown[] = [error];
	try {
		await options.routes?.runner.stop?.();
	} catch (stopError) {
		failures.push(stopError);
	}
	let disposed = false;
	try {
		await options.managedSdkRuntime?.dispose();
		disposed = true;
	} catch (disposeError) {
		failures.push(disposeError);
	}
	if (disposed) {
		try {
			await options.shutdownCleanup?.();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
	}
	if (failures.length === 1) {
		try {
			await options.runtimeLock.release();
		} catch (releaseError) {
			failures.push(releaseError);
		}
	}
	if (failures.length > 1) throw new AggregateError(failures, "Configured adapter startup cleanup failed");
	throw error;
}
