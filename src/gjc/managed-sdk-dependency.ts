import type { ManagedSdkRuntime, TenantSessionKey } from "./managed-sdk-runtime";

/** Process-owned public Router/lifecycle operations required by adapter composition.
 * dispose fulfills only after raw producers settle and local Router stop succeeds;
 * a bounded stop result is not a substitute for this ownership-release receipt. */
export type ManagedSdkRuntimeDependency = Pick<
	ManagedSdkRuntime,
	| "state"
	| "start"
	| "reconcile"
	| "dispose"
	| "createProducerScope"
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
