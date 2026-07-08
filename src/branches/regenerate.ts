import type { SessionMappingStore } from "../gjc/session-router";
import type { RegisteredProject } from "../projects/registry";

export type BranchRegenerateAction = "branch" | "fork";
export type BranchRegenerateFallbackReason =
	| "missing-session-mapping"
	| "owner-mismatch"
	| "project-mismatch"
	| "session-mismatch"
	| "missing-lineage-metadata"
	| "missing-message-entry"
	| "message-entry-mismatch";

export interface BranchRegenerateMessageMetadata {
	readonly gjc_adapter?: {
		readonly ownerUserId?: string;
		readonly owner_user_id?: string;
		readonly projectId?: string;
		readonly project_id?: string;
		readonly gjcSessionId?: string;
		readonly session_id?: string;
		readonly gjcEntryId?: string | null;
		readonly openwebuiMessageId?: string;
	};
}

export interface ResolveBranchRegenerateInput {
	readonly ownerUserId: string;
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly messageId: string;
	readonly mappings: SessionMappingStore;
	readonly messageMetadata?: BranchRegenerateMessageMetadata;
}

export type BranchRegenerateDecision =
	| {
			readonly action: "branch";
			readonly gjcEntryId: string;
			readonly sessionId: string;
	  }
	| {
			readonly action: "fork";
			readonly reason: BranchRegenerateFallbackReason;
			readonly sourceSessionId?: string;
	  };

export function resolveBranchRegenerateAction(input: ResolveBranchRegenerateInput): BranchRegenerateDecision {
	const mapping = input.mappings.get(input.chatId);
	if (mapping === undefined) {
		return { action: "fork", reason: "missing-session-mapping" };
	}
	if (mapping.projectId !== input.project.id) {
		return { action: "fork", reason: "project-mismatch", sourceSessionId: mapping.sessionId };
	}

	const adapterMetadata = input.messageMetadata?.gjc_adapter;
	const metadataOwnerUserId = adapterMetadata?.ownerUserId ?? adapterMetadata?.owner_user_id;
	if (metadataOwnerUserId === undefined) {
		return { action: "fork", reason: "missing-lineage-metadata", sourceSessionId: mapping.sessionId };
	}
	if (metadataOwnerUserId !== input.ownerUserId) {
		return { action: "fork", reason: "owner-mismatch", sourceSessionId: mapping.sessionId };
	}
	const metadataProjectId = adapterMetadata?.projectId ?? adapterMetadata?.project_id;
	if (metadataProjectId === undefined) {
		return { action: "fork", reason: "missing-lineage-metadata", sourceSessionId: mapping.sessionId };
	}
	if (metadataProjectId !== input.project.id) {
		return { action: "fork", reason: "project-mismatch", sourceSessionId: mapping.sessionId };
	}
	const metadataSessionId = adapterMetadata?.gjcSessionId ?? adapterMetadata?.session_id;
	if (metadataSessionId === undefined) {
		return { action: "fork", reason: "missing-lineage-metadata", sourceSessionId: mapping.sessionId };
	}
	if (metadataSessionId !== mapping.sessionId) {
		return { action: "fork", reason: "session-mismatch", sourceSessionId: mapping.sessionId };
	}
	const gjcEntryId = adapterMetadata?.gjcEntryId;
	if (gjcEntryId === undefined || gjcEntryId === null || gjcEntryId.length === 0) {
		return { action: "fork", reason: "missing-message-entry", sourceSessionId: mapping.sessionId };
	}
	const expectedMessageId = adapterMetadata?.openwebuiMessageId ?? gjcEntryId;
	if (expectedMessageId !== input.messageId) {
		return { action: "fork", reason: "message-entry-mismatch", sourceSessionId: mapping.sessionId };
	}
	return { action: "branch", gjcEntryId, sessionId: mapping.sessionId };
}
