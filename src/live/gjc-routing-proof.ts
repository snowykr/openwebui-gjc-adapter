import { resolve } from "node:path";
import type { CliLifecycleAttachment } from "../gjc/cli-lifecycle-backend";
import type {
	GjcCloseReceipt,
	GjcLifecyclePublicationAddress,
	GjcLifecycleTestBarrierEvidence,
	GjcLifecycleTestBarrierHook,
	GjcTurnEvent,
	GjcTurnResult,
} from "../gjc/turn-runner";
import type { PublicSdkSessionAttachment } from "../gjc/public-sdk-contract";

export type SessionAttachment = Omit<CliLifecycleAttachment, "pane"> & {
	readonly pane?: CliLifecycleAttachment["pane"];
	readonly projectId: string;
	readonly published?: PublicSdkSessionAttachment;
};

export function lifecycleBarrierEvidence(attachment: PublicSdkSessionAttachment): GjcLifecycleTestBarrierEvidence {
	const authority = attachment.authority;
	return { cwd: attachment.cwd, sessionId: attachment.sessionId, ...(authority === undefined ? {} : { generation: authority.generation, digestPrefix: authority.payloadDigest.slice(0, 12) }) };
}

export async function runLifecycleTestBarrier(hook: GjcLifecycleTestBarrierHook | undefined, phase: Parameters<GjcLifecycleTestBarrierHook>[0], attachment: PublicSdkSessionAttachment): Promise<void> {
	await hook?.(phase, lifecycleBarrierEvidence(attachment));
}

export function turnResult(outcome: import("../gjc/public-sdk-contract").PublicSdkTurnOutcome, sessionFile: string | undefined, modelSelection?: import("../contracts").NormalizedModelSelection, attachment?: import("../gjc/session-authority").SessionAttachmentProof): GjcTurnResult {
	const events: GjcTurnEvent[] = outcome.events.filter(event => typeof event.type === "string").map(event => ({ type: String(event.type), ...(typeof event.id === "string" ? { id: event.id } : {}), payload: event }));
	if (outcome.gate !== undefined) events.push({ type: "workflow_gate", id: outcome.gate.gateId, payload: { ...outcome.gate.payload, gateId: outcome.gate.gateId, commandId: outcome.gate.correlation.commandId, turnId: outcome.gate.correlation.turnId, sessionId: outcome.gate.correlation.sessionId } });
	return { text: outcome.finalizedAssistantText ?? "", events, ...(sessionFile === undefined ? {} : { sessionFile }), rawFrameCursor: 0, eventCursor: events.length, ...(modelSelection === undefined ? {} : { modelSelection }), ...(attachment === undefined ? {} : { attachment }) };
}

export function attachmentProof(
	attachment: PublicSdkSessionAttachment,
	lifecycle: SessionAttachment,
): import("../gjc/session-authority").SessionAttachmentProof {
	if (attachment.authority === undefined) throw new Error("Published GJC endpoint is missing descriptor authority.");
	if (!isSha256HexDigest(attachment.authority.payloadDigest))
		throw new Error("Published GJC endpoint descriptor authority is missing a SHA-256 payload digest.");
	return {
		...attachment.authority,
		payloadDigest: attachment.authority.payloadDigest,
		...(lifecycle.pane === undefined || lifecycle.pane.socketName === undefined || !isPositiveSafeInteger(lifecycle.pane.panePid) || attachment.endpoint.pid !== lifecycle.pane.panePid
			? {}
			: { tmuxSocket: lifecycle.pane.socketName, tmuxPane: lifecycle.pane.target, tmuxPanePid: lifecycle.pane.panePid, tmuxOwnershipTag: lifecycle.pane.ownershipTag, ownedAt: new Date().toISOString() }),
	};
}

export function canRetainColdResumePane(attachment: CliLifecycleAttachment, published: PublicSdkSessionAttachment): attachment is CliLifecycleAttachment & { readonly pane: NonNullable<CliLifecycleAttachment["pane"]> } {
	return attachment.pane !== undefined && isPositiveSafeInteger(attachment.pane.panePid) && isPositiveSafeInteger(published.endpoint.pid) && attachment.pane.panePid === published.endpoint.pid;
}

export function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256HexDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

export function sameAttachmentProof(proof: import("../gjc/session-authority").SessionAttachmentProof, published: PublicSdkSessionAttachment): boolean {
	const authority = published.authority;
	return authority !== undefined && proof.descriptorPath === authority.descriptorPath && proof.descriptorStat.dev === authority.descriptorStat.dev && proof.descriptorStat.ino === authority.descriptorStat.ino && proof.descriptorStat.size === authority.descriptorStat.size && proof.descriptorStat.mtimeMs === authority.descriptorStat.mtimeMs && proof.generation === authority.generation && proof.payloadDigest === authority.payloadDigest && proof.expectedSessionId === published.sessionId && proof.expectedSessionId === authority.expectedSessionId && proof.expectedCwd === published.cwd && proof.expectedCwd === authority.expectedCwd;
}

export function sameActiveAttachmentProof(proof: import("../gjc/session-authority").SessionAttachmentProof, attachment: SessionAttachment): boolean {
	if (attachment.published === undefined || !sameAttachmentProof(proof, attachment.published)) return false;
	const pane = attachment.pane;
	const paneAuthorized = pane !== undefined && pane.socketName !== undefined && isPositiveSafeInteger(pane.panePid) && attachment.published.endpoint.pid === pane.panePid;
	return (proof.tmuxSocket === undefined) === !paneAuthorized && (proof.tmuxPane === undefined) === !paneAuthorized && (proof.tmuxPanePid === undefined) === !paneAuthorized && (proof.tmuxOwnershipTag === undefined) === !paneAuthorized && (!paneAuthorized || (proof.tmuxSocket === pane.socketName && proof.tmuxPane === pane.target && proof.tmuxPanePid === pane.panePid && proof.tmuxOwnershipTag === pane.ownershipTag));
}

export function sameExactActiveCloseProof(proof: import("../gjc/session-authority").SessionAttachmentProof, attachment: SessionAttachment): boolean {
	if (!sameActiveAttachmentProof(proof, attachment)) return false;
	const pane = attachment.pane;
	return pane !== undefined && typeof pane.socketName === "string" && pane.socketName.length > 0 && typeof pane.target === "string" && pane.target.length > 0 && isPositiveSafeInteger(pane.panePid) && typeof pane.ownershipTag === "string" && pane.ownershipTag.length > 0 && proof.tmuxSocket === pane.socketName && proof.tmuxPane === pane.target && proof.tmuxPanePid === pane.panePid && proof.tmuxOwnershipTag === pane.ownershipTag;
}

export function sameLifecycleAddress(receipt: GjcLifecyclePublicationAddress, active: GjcLifecyclePublicationAddress): boolean {
	return receipt.cwd === resolve(active.cwd) && receipt.sessionRoot === resolve(active.sessionRoot) && receipt.projectId === active.projectId && receipt.sessionId === active.sessionId && receipt.chatId === active.chatId && receipt.sessionFile === active.sessionFile && sameProof(receipt.recoveryAttachment, active.recoveryAttachment);
}

export function sameCloseReceiptSnapshot(receipt: GjcCloseReceipt, snapshot: GjcCloseReceipt): boolean {
	return sameLifecycleAddress(receipt.address, snapshot.address) && sameProof(receipt.proof, snapshot.proof) && samePublishedAttachmentSnapshot(receipt.attachment, snapshot.attachment);
}

export function sameProof(left: import("../gjc/session-authority").SessionAttachmentProof | undefined, right: import("../gjc/session-authority").SessionAttachmentProof | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.descriptorPath === right.descriptorPath && left.descriptorStat.dev === right.descriptorStat.dev && left.descriptorStat.ino === right.descriptorStat.ino && left.descriptorStat.size === right.descriptorStat.size && left.descriptorStat.mtimeMs === right.descriptorStat.mtimeMs && left.payloadDigest === right.payloadDigest && left.generation === right.generation && left.expectedSessionId === right.expectedSessionId && left.expectedCwd === right.expectedCwd && left.tmuxSocket === right.tmuxSocket && left.tmuxPane === right.tmuxPane && left.tmuxPanePid === right.tmuxPanePid && left.tmuxOwnershipTag === right.tmuxOwnershipTag && left.ownedAt === right.ownedAt;
}

export function samePublishedAttachmentSnapshot(left: PublicSdkSessionAttachment, right: PublicSdkSessionAttachment): boolean {
	const leftAuthority = left.authority;
	const rightAuthority = right.authority;
	return left.sessionId === right.sessionId && left.cwd === right.cwd && left.endpoint.url === right.endpoint.url && left.endpoint.token === right.endpoint.token && left.endpoint.pid === right.endpoint.pid && (leftAuthority === undefined || rightAuthority === undefined ? leftAuthority === rightAuthority : leftAuthority.descriptorPath === rightAuthority.descriptorPath && leftAuthority.descriptorStat.dev === rightAuthority.descriptorStat.dev && leftAuthority.descriptorStat.ino === rightAuthority.descriptorStat.ino && leftAuthority.descriptorStat.size === rightAuthority.descriptorStat.size && leftAuthority.descriptorStat.mtimeMs === rightAuthority.descriptorStat.mtimeMs && leftAuthority.payloadDigest === rightAuthority.payloadDigest && leftAuthority.generation === rightAuthority.generation && leftAuthority.expectedSessionId === rightAuthority.expectedSessionId && leftAuthority.expectedCwd === rightAuthority.expectedCwd);
}
