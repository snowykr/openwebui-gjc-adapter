import { resolve } from "node:path";
import type { SessionAttachmentProof } from "./session-authority";
import type { PublicSdkSessionAttachment } from "./public-sdk-contract";

export type GjcLifecycleOwner = object;

export interface GjcSessionAddress {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly chatId: string;
}

export interface GjcLifecyclePublicationAddress extends GjcSessionAddress {
	readonly sessionFile?: string;
	readonly recoveryAttachment?: SessionAttachmentProof;
}

/**
 * Immutable capability issued only by an owner-scoped close preflight.
 * Its proof is retained so close completion can validate a now-absent descriptor
 * against the attachment that was active before acknowledgement.
 */
export class GjcCloseReceipt implements SessionAttachmentProof {
	private constructor(
		readonly address: GjcLifecyclePublicationAddress,
		readonly proof: SessionAttachmentProof,
		/** Immutable endpoint snapshot; never the cached attachment object. */
		readonly attachment: PublicSdkSessionAttachment,
	) {
		Object.freeze(this);
	}
	get descriptorPath(): string { return this.proof.descriptorPath; }
	get descriptorStat(): SessionAttachmentProof["descriptorStat"] { return this.proof.descriptorStat; }
	get payloadDigest(): string { return this.proof.payloadDigest; }
	get generation(): number { return this.proof.generation; }
	get expectedSessionId(): string { return this.proof.expectedSessionId; }
	get expectedCwd(): string { return this.proof.expectedCwd; }
	get tmuxSocket(): string | undefined { return this.proof.tmuxSocket; }
	get tmuxPane(): string | undefined { return this.proof.tmuxPane; }
	get tmuxPanePid(): number | undefined { return this.proof.tmuxPanePid; }
	get tmuxOwnershipTag(): string | undefined { return this.proof.tmuxOwnershipTag; }
	get ownedAt(): string | undefined { return this.proof.ownedAt; }
	static fromPreflight(
		address: GjcLifecyclePublicationAddress,
		proof: SessionAttachmentProof,
		attachment: PublicSdkSessionAttachment,
	): GjcCloseReceipt {
		const recoveryAttachment = address.recoveryAttachment;
		return new GjcCloseReceipt(
			Object.freeze({
				cwd: resolve(address.cwd),
				sessionRoot: resolve(address.sessionRoot),
				projectId: address.projectId,
				sessionId: address.sessionId,
				chatId: address.chatId,
				...(address.sessionFile === undefined ? {} : { sessionFile: address.sessionFile }),
				...(recoveryAttachment === undefined ? {} : { recoveryAttachment: freezeProof(recoveryAttachment) }),
			}),
			freezeProof(proof),
			Object.freeze({
				sessionId: attachment.sessionId,
				cwd: attachment.cwd,
				endpoint: Object.freeze({
					url: attachment.endpoint.url,
					token: attachment.endpoint.token,
					...(attachment.endpoint.pid === undefined ? {} : { pid: attachment.endpoint.pid }),
				}),
				...(attachment.authority === undefined
					? {}
					: {
						authority: Object.freeze({
							...proof,
							descriptorPath: attachment.authority.descriptorPath,
							descriptorStat: Object.freeze({ ...attachment.authority.descriptorStat }),
							payloadDigest: attachment.authority.payloadDigest,
							generation: attachment.authority.generation,
							expectedSessionId: attachment.authority.expectedSessionId,
							expectedCwd: attachment.authority.expectedCwd,
						}),
					}),
			}),
		);
	}
}

function freezeProof(proof: SessionAttachmentProof): SessionAttachmentProof {
	return Object.freeze({
		descriptorPath: proof.descriptorPath,
		descriptorStat: Object.freeze({ ...proof.descriptorStat }),
		payloadDigest: proof.payloadDigest,
		generation: proof.generation,
		expectedSessionId: proof.expectedSessionId,
		expectedCwd: proof.expectedCwd,
		...(proof.tmuxSocket === undefined ? {} : { tmuxSocket: proof.tmuxSocket }),
		...(proof.tmuxPane === undefined ? {} : { tmuxPane: proof.tmuxPane }),
		...(proof.tmuxPanePid === undefined ? {} : { tmuxPanePid: proof.tmuxPanePid }),
		...(proof.tmuxOwnershipTag === undefined ? {} : { tmuxOwnershipTag: proof.tmuxOwnershipTag }),
		...(proof.ownedAt === undefined ? {} : { ownedAt: proof.ownedAt }),
	});
}

export type GjcLifecycleTestBarrierPhase =
	| "post_cli_pre_bind"
	| "post_mutation_pre_proof"
	| "pre_durable_publication"
	| "between_branch_phases"
	| "post_close_proof_pre_commit";

export interface GjcLifecycleTestBarrierEvidence {
	readonly cwd: string;
	readonly sessionId: string;
	readonly generation?: number;
	readonly digestPrefix?: string;
}

/** Test-only synchronization point; evidence deliberately excludes endpoint credentials. */
export type GjcLifecycleTestBarrierHook = (
	phase: GjcLifecycleTestBarrierPhase,
	evidence: GjcLifecycleTestBarrierEvidence,
) => Promise<void> | void;

export interface GjcLifecycleTransaction {
	readonly owner: GjcLifecycleOwner;
	readonly address: GjcLifecyclePublicationAddress;
	/** Returns the exact cached attachment only when persisted descriptor and full pane ownership proof match. */
	assertClosePreflight(proof: SessionAttachmentProof): GjcCloseReceipt;
	publish<T>(proof: SessionAttachmentProof, write: () => T): Promise<T>;
	/** Commits a proven close and evicts its exact active attachment before releasing the lifecycle owner. */
	publishClosed<T>(receipt: GjcCloseReceipt, write: () => T): Promise<T>;
	handoff(address: GjcLifecyclePublicationAddress, proof: SessionAttachmentProof): Promise<void>;
}

export interface GjcLifecycleScoped {
	readonly lifecycle: GjcLifecycleTransaction;
}
