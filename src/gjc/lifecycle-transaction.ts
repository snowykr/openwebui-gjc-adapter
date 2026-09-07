import type { ManagedGenerationProof } from "./turn-runner";

export interface GjcSessionAddress {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly chatId: string;
}

export type GjcLifecyclePublicationAddress = GjcSessionAddress;

export interface GjcLifecycleTransaction {
	readonly address: GjcLifecyclePublicationAddress;
	/** Publishes an exact credential-free managed generation after Router proof. */
	publishManaged<T>(proof: ManagedGenerationProof, write: () => T): Promise<T>;
}

export interface GjcLifecycleScoped {
	readonly lifecycle: GjcLifecycleTransaction;
}
