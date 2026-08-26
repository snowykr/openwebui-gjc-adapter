import type { GjcRuntimeLocations } from "../contracts";
import type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "../gjc/managed-sdk-dependency";
import type { ManagedSdkAttachment, TenantSessionKey } from "../gjc/managed-sdk-runtime";
import type { PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import type {
	GjcCloseReceipt,
	GjcLifecycleTestBarrierHook,
	GjcLifecycleTransaction,
	GjcSessionAddress,
	ManagedTurnAuthority,
} from "../gjc/turn-runner";
import type { SessionAttachment } from "./gjc-routing-proof";

export interface PublicSdkRunnerOptions {
	readonly cliPath: string;
	readonly runtimeLocations: GjcRuntimeLocations;
	readonly turnTimeoutMs: number;
	/** Legacy-only construction seam. Managed operations reject instead of falling back when it is absent. */
	readonly managedSdkRuntime?: ManagedSdkRuntimeDependency;
	/** Slice 3 tenant-authority integration seam; intentionally unused by legacy traffic. */
	readonly managedSdkTenantFence?: ManagedSdkTenantFence;
	readonly sessionPortFactory?: () => PublicSdkSessionPort;
	readonly testBarrierHook?: GjcLifecycleTestBarrierHook;
}

export type { ManagedSdkRuntimeDependency, ManagedSdkTenantFence } from "../gjc/managed-sdk-dependency";

export interface PublicSdkRunnerContext {
	readonly input: PublicSdkRunnerOptions;
	/** Legacy SDK attachment state; retained only until the atomic Slice 3 cutover. */
	readonly attachments: Map<string, SessionAttachment>;
	/** Legacy SDK close receipts; retained only until the atomic Slice 3 cutover. */
	readonly closeReceipts: WeakMap<GjcCloseReceipt, CloseReceiptBinding>;
	/** Builds the opaque Router tenant key and reasserts the configured fence at every managed boundary. */
	managed(authority: ManagedTurnAuthority): ManagedSdkOperationContext;
}

export interface ManagedSdkOperationContext {
	readonly runtime: ManagedSdkRuntimeDependency;
	readonly tenant: TenantSessionKey;
	acquire(): Promise<ManagedSdkAttachment>;
	assertFence(): Promise<void>;
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

export type ManagedLifecycleAddress = LifecycleAddress & { readonly authority: ManagedTurnAuthority };

export function createPublicSdkRunnerContext(input: PublicSdkRunnerOptions): PublicSdkRunnerContext {
	return {
		input,
		attachments: new Map(),
		closeReceipts: new WeakMap(),
		managed(authority) {
			const runtime = input.managedSdkRuntime;
			if (runtime === undefined) throw new Error("Managed SDK runtime is required for managed operations.");
			const tenant = tenantKey(authority);
			return {
				runtime,
				tenant,
				assertFence: async () => {
					if (!((await input.managedSdkTenantFence?.(tenant)) ?? true))
						throw new Error("Managed tenant authority fence was lost.");
				},
				acquire: async () => {
					if (!((await input.managedSdkTenantFence?.(tenant)) ?? true))
						throw new Error("Managed tenant authority fence was lost.");
					return runtime.acquireAttachment(tenant);
				},
			};
		},
	};
}

export function tenantKey(authority: ManagedTurnAuthority): TenantSessionKey {
	if (
		!authority.principalId ||
		!authority.projectId ||
		!authority.canonicalWorkspace ||
		!authority.chatId ||
		!authority.sessionId ||
		!authority.leaseId ||
		!authority.epoch ||
		!authority.requestKey ||
		!Number.isSafeInteger(authority.generation) ||
		authority.generation <= 0
	)
		throw new TypeError("Complete positive managed tenant authority is required.");
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

export type LifecycleEffect<T> = (lifecycle: GjcLifecycleTransaction) => Promise<T>;
export async function cleanupColdResumeFailure(
	error: unknown,
	cleanup: () => Promise<{ readonly status: string; readonly message?: string }>,
): Promise<never> {
	try {
		const result = await cleanup();
		if (result.status !== "closed")
			throw new Error(`owned pane cleanup is ${result.status}: ${result.message ?? "no detail"}`);
	} catch (cleanupError) {
		throw new AggregateError(
			[error, cleanupError],
			"cold-resumed GJC session pre-acknowledgement cleanup is uncertain",
		);
	}
	throw error;
}
