import { SdkV3OperationError } from "./sdk-v3-protocol";

/** A single wall-clock budget shared by every phase of one SDK transaction. */
export interface PublicSdkDeadline {
	remaining(): number;
}

export function createPublicSdkDeadline(timeoutMs: number | undefined, timeoutMessage: string): PublicSdkDeadline {
	const deadline = Date.now() + (timeoutMs ?? 60_000);
	return {
		remaining() {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new SdkV3OperationError("timeout", timeoutMessage);
			return remaining;
		},
	};
}
