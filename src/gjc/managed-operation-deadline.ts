import { ManagedSdkOperationError } from "./managed-sdk-runtime";

export const DEFAULT_MANAGED_OPERATION_TIMEOUT_MS = 60_000;

/** One finite budget across acquisition, invocation, observation and publication. */
export class ManagedOperationDeadline {
	readonly expiresAt: number;
	readonly #failure: Promise<never>;
	readonly #timer: ReturnType<typeof setTimeout>;
	readonly #timeout: ManagedSdkOperationError;
	#reject!: (error: unknown) => void;
	#stopped = false;
	#error: unknown;
	constructor(timeoutMs = DEFAULT_MANAGED_OPERATION_TIMEOUT_MS, operation: string) {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
			throw new TypeError("Managed timeoutMs must be a positive finite timer-safe integer.");
		this.expiresAt = Date.now() + timeoutMs;
		this.#timeout = new ManagedSdkOperationError("timeout", `Managed ${operation} timed out after ${timeoutMs}ms.`);
		this.#failure = new Promise<never>((_resolve, reject) => {
			this.#reject = reject;
		});
		void this.#failure.catch(() => undefined);
		this.#timer = setTimeout(() => this.fail(this.#timeout), timeoutMs);
		this.#timer.unref?.();
	}
	remaining(): number {
		if (this.#stopped) throw this.#error;
		const remaining = this.expiresAt - Date.now();
		if (remaining <= 0) {
			this.fail(this.#timeout);
			throw this.#timeout;
		}
		return remaining;
	}
	async wait<T>(promise: Promise<T>): Promise<T> {
		// Retain a rejection handler even when the budget has already failed.
		const value = await Promise.race([promise, this.#failure]);
		this.remaining();
		return value;
	}
	fail(error: unknown): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#error = error;
		clearTimeout(this.#timer);
		this.#reject(error);
	}
	close(): void {
		this.fail(new ManagedSdkOperationError("operation_closed", "Managed operation observation is closed."));
	}
}
