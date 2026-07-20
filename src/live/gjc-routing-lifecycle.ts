import type { GjcRuntimeLocations } from "../contracts";
import type {
	GjcLifecycleTestBarrierHook,
	GjcLifecycleTransaction,
	GjcSessionAddress,
} from "../gjc/turn-runner";
import type { PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import type { GjcCloseReceipt } from "../gjc/turn-runner";
import type { SessionAttachment } from "./gjc-routing-proof";

export interface PublicSdkRunnerOptions {
	readonly cliPath: string;
	readonly runtimeLocations: GjcRuntimeLocations;
	readonly turnTimeoutMs: number;
	readonly sessionPortFactory?: () => PublicSdkSessionPort;
	readonly testBarrierHook?: GjcLifecycleTestBarrierHook;
}

export interface PublicSdkRunnerContext {
	readonly input: PublicSdkRunnerOptions;
	readonly attachments: Map<string, SessionAttachment>;
	readonly closeReceipts: WeakMap<GjcCloseReceipt, CloseReceiptBinding>;
}

export interface CloseReceiptBinding {
	readonly attachment: SessionAttachment;
	readonly owner: object;
	readonly snapshot: GjcCloseReceipt;
}

export type LifecycleAddress = GjcSessionAddress & {
	readonly sessionFile?: string;
	readonly recoveryAttachment?: import("../gjc/session-authority").SessionAttachmentProof;
};

export function createPublicSdkRunnerContext(
	input: PublicSdkRunnerOptions,
): PublicSdkRunnerContext {
	return {
		input,
		attachments: new Map(),
		closeReceipts: new WeakMap(),
	};
}

export type LifecycleEffect<T> = (lifecycle: GjcLifecycleTransaction) => Promise<T>;
