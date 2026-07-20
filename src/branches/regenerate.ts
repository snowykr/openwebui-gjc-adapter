import type { SessionMappingStore } from "../gjc/session-router";
import type { RegisteredProject } from "../projects/registry";

export type BranchRegenerateAction = "branch" | "uncertain";
export type BranchRegenerateUncertainReason =
	| "missing-session-mapping"
	| "missing-owner"
	| "owner-mismatch"
	| "project-mismatch"
	| "session-mismatch"
	| "missing-lineage-metadata"
	| "missing-message-entry"
	| "message-entry-mismatch"
	| "branch-candidate-absent"
	| "branch-candidate-duplicate"
	| "branch-candidate-drift";

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
	readonly ownerUserId?: string;
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly messageId: string;
	readonly mappings: Pick<SessionMappingStore, "get">;
	readonly messageMetadata?: unknown;
}

export type BranchRegenerateDecision =
	| {
			readonly action: "branch";
			readonly gjcEntryId: string;
			readonly sessionId: string;
	  }
	| {
			/**
			 * The lineage cannot safely be replayed. Callers must surface this
			 * outcome; they must not substitute a CLI fork or another prompt.
			 */
			readonly action: "uncertain";
			readonly reason: BranchRegenerateUncertainReason;
			readonly sourceSessionId?: string;
	  };

export function resolveBranchRegenerateAction(input: ResolveBranchRegenerateInput): BranchRegenerateDecision {
	const mapping = input.mappings.get(input.chatId);
	if (mapping === undefined) {
		return { action: "uncertain", reason: "missing-session-mapping" };
	}
	if (mapping.projectId !== input.project.id) {
		return { action: "uncertain", reason: "project-mismatch", sourceSessionId: mapping.sessionId };
	}

	if (input.ownerUserId === undefined || input.ownerUserId.trim().length === 0) {
		return { action: "uncertain", reason: "missing-owner", sourceSessionId: mapping.sessionId };
	}
	const adapterMetadata = adapterMetadataFrom(input.messageMetadata);
	const metadataOwnerUserId =
		stringMetadata(adapterMetadata?.ownerUserId) ?? stringMetadata(adapterMetadata?.owner_user_id);
	if (metadataOwnerUserId === undefined) {
		return { action: "uncertain", reason: "missing-lineage-metadata", sourceSessionId: mapping.sessionId };
	}
	if (metadataOwnerUserId !== input.ownerUserId) {
		return { action: "uncertain", reason: "owner-mismatch", sourceSessionId: mapping.sessionId };
	}
	const metadataProjectId = stringMetadata(adapterMetadata?.projectId) ?? stringMetadata(adapterMetadata?.project_id);
	if (metadataProjectId === undefined) {
		return { action: "uncertain", reason: "missing-lineage-metadata", sourceSessionId: mapping.sessionId };
	}
	if (metadataProjectId !== input.project.id) {
		return { action: "uncertain", reason: "project-mismatch", sourceSessionId: mapping.sessionId };
	}
	const metadataSessionId =
		stringMetadata(adapterMetadata?.gjcSessionId) ?? stringMetadata(adapterMetadata?.session_id);
	if (metadataSessionId === undefined) {
		return { action: "uncertain", reason: "missing-lineage-metadata", sourceSessionId: mapping.sessionId };
	}
	if (metadataSessionId !== mapping.sessionId) {
		return { action: "uncertain", reason: "session-mismatch", sourceSessionId: mapping.sessionId };
	}
	const gjcEntryId = stringMetadata(adapterMetadata?.gjcEntryId);
	if (gjcEntryId === undefined || gjcEntryId === null || gjcEntryId.length === 0) {
		return { action: "uncertain", reason: "missing-message-entry", sourceSessionId: mapping.sessionId };
	}
	const expectedMessageId = stringMetadata(adapterMetadata?.openwebuiMessageId) ?? gjcEntryId;
	if (expectedMessageId !== input.messageId) {
		return { action: "uncertain", reason: "message-entry-mismatch", sourceSessionId: mapping.sessionId };
	}
	return { action: "branch", gjcEntryId, sessionId: mapping.sessionId };
}
export function authorizeBranchRegenerateCandidate(
	decision: Extract<BranchRegenerateDecision, { readonly action: "branch" }>,
	candidates: readonly { readonly entryId: string; readonly source: Readonly<Record<string, unknown>> }[],
): BranchRegenerateDecision {
	const matches = candidates.filter(candidate => candidate.entryId === decision.gjcEntryId);
	if (matches.length === 0)
		return { action: "uncertain", reason: "branch-candidate-absent", sourceSessionId: decision.sessionId };
	if (matches.length !== 1)
		return { action: "uncertain", reason: "branch-candidate-duplicate", sourceSessionId: decision.sessionId };
	const source = matches[0]?.source;
	if (source?.id !== decision.gjcEntryId || source.type !== "message")
		return { action: "uncertain", reason: "branch-candidate-drift", sourceSessionId: decision.sessionId };
	return decision;
}

function adapterMetadataFrom(metadata: unknown): BranchRegenerateMessageMetadata["gjc_adapter"] | undefined {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
	const adapter = Reflect.get(metadata, "gjc_adapter");
	if (typeof adapter !== "object" || adapter === null || Array.isArray(adapter)) return undefined;
	return adapter as BranchRegenerateMessageMetadata["gjc_adapter"];
}

function stringMetadata(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
