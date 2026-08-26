import type { ManagedSdkRuntime, TenantSessionKey } from "./managed-sdk-runtime";

/** Process-owned public Router/lifecycle operations required by adapter composition. */
export type ManagedSdkRuntimeDependency = Pick<
	ManagedSdkRuntime,
	| "state"
	| "start"
	| "reconcile"
	| "dispose"
	| "acquireAttachment"
	| "request"
	| "subscribeFrames"
	| "generationStatus"
	| "createLifecycleSession"
	| "resumeLifecycleSession"
	| "closeLifecycleSession"
	| "deleteLifecycleSession"
>;

/** Re-proves complete tenant lease and epoch authority at every managed boundary. */
export type ManagedSdkTenantFence = (key: TenantSessionKey) => boolean | Promise<boolean>;
