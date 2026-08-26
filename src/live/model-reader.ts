import type { ManagedPreparedTurnAuthority, ManagedTurnAuthority } from "../gjc/turn-runner";
import type { OpenWebUIPrincipal } from "../openwebui/auth";
import type { UserWorkspace } from "../security/user-workspace";

export interface ModelReader {
	getAvailableModels(): Promise<readonly unknown[]>;
	getActiveProviders(): Promise<readonly unknown[]>;
	getState(): Promise<unknown>;
	stop(): void | Promise<void>;
}

/** Request scope used to bind model readers to the caller's principal and workspace lease. */
export interface ModelReaderContext {
	readonly principal: OpenWebUIPrincipal;
	/** Credential-free authority for the exact managed tenant or a one-shot managed catalog session. */
	readonly managedAuthority?: ManagedTurnAuthority | ManagedPreparedTurnAuthority;
	/** Durable user workspace. Required for normal-user readers. */
	readonly workspace?: UserWorkspace;
	/** Lease fence proving exclusive access to the workspace. Required for normal-user readers. */
	readonly lease?: { readonly assertFence: () => Promise<unknown> };
	readonly correlationId?: string;
	/** Request cancellation propagated through model preparation. */
	readonly signal?: AbortSignal;
}

/** Alias used by callers that refer to the reader's scope rather than its context. */
export type ModelReaderScope = ModelReaderContext;

export type ModelReaderFactory = (context?: ModelReaderContext, signal?: AbortSignal) => Promise<ModelReader>;
