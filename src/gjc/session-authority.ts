/**
 * Returns the canonical storage key for a principal/chat tuple.
 *
 * JSON tuple encoding keeps component boundaries unambiguous even when either
 * identifier contains punctuation that would collide with delimiter joins.
 */
export function canonicalSessionMappingKey(principalId: string, chatId: string): string {
	if (typeof principalId !== "string" || principalId.length === 0)
		throw new Error("Scoped session mapping requires a non-empty principal ID.");
	if (typeof chatId !== "string") throw new Error("Scoped session mapping requires a chat ID.");
	return JSON.stringify([principalId, chatId]);
}

export { FileSessionAuthority } from "./session-authority-persistence";
export { SessionAuthority } from "./session-authority-store";
export type {
	ProjectReassignmentState,
	ProvisionalSessionOperation,
	SessionAttachmentProof,
	SessionAuthorityInput,
	SessionAuthorityReassignment,
	SessionAuthorityRecord,
	SessionAuthorityTargetIdentity,
	SessionAuthorityTombstone,
	SessionOperation,
	SessionOperationKind,
	SessionOperationResult,
	SessionOperationState,
} from "./session-authority-types";
export { SESSION_AUTHORITY_VERSION, SessionAuthorityLoadError } from "./session-authority-types";
