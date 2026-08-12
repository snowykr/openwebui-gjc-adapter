import type { NormalizedModelSelection } from "../contracts";
import type { GjcTurnEvent } from "./turn-runner";

export const SESSION_AUTHORITY_VERSION = 2 as const;

export class SessionAuthorityLoadError extends Error {
	constructor(
		readonly filePath: string,
		message: string,
		readonly cause?: unknown,
	) {
		super(`Cannot use session authority ${filePath}: ${message}`);
		this.name = "SessionAuthorityLoadError";
	}
}

export type SessionOperationState = "pending" | "complete" | "uncertain" | "conflict";
export type SessionOperationKind =
	| "create"
	| "resume"
	| "close"
	| "prompt"
	| "reply"
	| "gate"
	| "branch"
	| "model"
	| "thinking";
export interface AuthorityMutationLockRecord {
	readonly owner: string;
	readonly pid: number;
	readonly leaseExpiresAt: number;
}

export interface SessionAttachmentProof {
	readonly descriptorPath: string;
	readonly descriptorStat: Readonly<{
		readonly dev: number;
		readonly ino: number;
		readonly size: number;
		readonly mtimeMs: number;
	}>;
	readonly payloadDigest: string;
	readonly generation: number;
	readonly expectedSessionId: string;
	readonly expectedCwd: string;
	readonly tmuxSocket?: string;
	readonly tmuxPane?: string;
	readonly tmuxPanePid?: number;
	readonly tmuxOwnershipTag?: string;
	readonly ownedAt?: string;
}
export type EndpointSessionAttachmentProof = Omit<
	SessionAttachmentProof,
	"tmuxSocket" | "tmuxPane" | "tmuxPanePid" | "tmuxOwnershipTag" | "ownedAt"
>;

export interface AcknowledgedSuccessor {
	readonly sessionId: string;
	readonly attachment: EndpointSessionAttachmentProof;
}

export interface SessionOperationGateBinding {
	readonly gateId: string;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly sessionId?: string;
}

export interface SessionOperationResult {
	readonly kind: "turn" | "control" | "close";
	readonly assistantText: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly mapping: Readonly<{
		chatId: string;
		projectId: string;
		sessionId: string;
		sessionFile?: string;
		activeLeaf?: string;
		rawFrameCursor: number;
		eventCursor: number;
		operationId: string;
		modelSelection?: NormalizedModelSelection;
		attachment?: SessionAttachmentProof;
	}>;
	readonly correlation?: Readonly<Record<string, string>>;
	/** Compact answered-gate identity for workflow gate operations, so replays
	 * of a superseded gate can still recompute the durable request hash even
	 * after the gate event itself is no longer retained on the record. */
	readonly gate?: SessionOperationGateBinding;
}

export interface SessionOperation {
	readonly id: string;
	readonly kind: SessionOperationKind;
	readonly state: SessionOperationState;
	readonly ingressId?: string;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly detail?: string;
	readonly result?: SessionOperationResult;
	readonly acknowledgedSuccessor?: AcknowledgedSuccessor;
}
export type SessionProjectReassignmentState = "pending" | "rolled_back" | "committed";
export type ProjectReassignmentState = SessionProjectReassignmentState;

export interface SessionAuthorityTargetIdentity {
	readonly id: string;
	readonly ingressId?: string;
	readonly kind: SessionOperationKind;
	readonly detail?: string;
}

export interface SessionAuthorityTombstone {
	readonly version: typeof SESSION_AUTHORITY_VERSION;
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly header: Readonly<{ chatId: string; projectId: string; sessionId: string }>;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly observations?: Readonly<Record<string, unknown>>;
	readonly attachment?: SessionAttachmentProof;
	readonly journal: readonly SessionOperation[];
	readonly retiredAt: string;
	readonly prior?: SessionAuthorityTombstone;
}

export interface SessionAuthorityReassignment {
	readonly state: SessionProjectReassignmentState;
	readonly sourceProjectId: string;
	readonly targetProjectId: string;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly target?: SessionAuthorityTargetIdentity;
	/** Set only after commit; it is the durable source identity fence and evidence. */
	readonly sourceTombstone?: SessionAuthorityTombstone;
	readonly priorTombstone?: SessionAuthorityTombstone;
}

/** A mapping's reassignment marker is intentionally optional for v2 documents. */

export interface ProvisionalSessionOperation extends SessionOperation {
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly attachment?: SessionAttachmentProof;
}

/** The mapping identity header is deliberately separate from replaceable observations. */
export interface SessionAuthorityRecord {
	readonly version: typeof SESSION_AUTHORITY_VERSION;
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly header: Readonly<{ chatId: string; projectId: string; sessionId: string }>;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
	readonly modelSelection?: NormalizedModelSelection;
	readonly observations?: Readonly<Record<string, unknown>>;
	readonly attachment?: SessionAttachmentProof;
	readonly journal: readonly SessionOperation[];
	readonly reassignment?: SessionAuthorityReassignment;
}

export type SessionAuthorityInput = Omit<SessionAuthorityRecord, "version" | "createdAt" | "header" | "journal"> &
	Partial<Pick<SessionAuthorityRecord, "createdAt" | "journal" | "header" | "version">>;
export const SESSION_AUTHORITY_MIGRATION_VERSION = 1 as const;

export const SESSION_MAPPING_SCOPE_OBSERVATION = "__gjcSessionMappingScope" as const;

export type SessionAuthorityMigrationStatus = "committed" | "degraded" | "not_needed";
export type SessionAuthorityMigrationItemStatus = "migrated" | "quarantined" | "skipped";

export interface SessionAuthorityMigrationItem {
	readonly identity: string;
	readonly sourceIndex: number;
	readonly legacyChatId?: string;
	readonly destinationChatId?: string;
	readonly status: SessionAuthorityMigrationItemStatus;
	readonly reason?: string;
}

export interface SessionAuthorityMigrationCounts {
	readonly total: number;
	readonly migrated: number;
	readonly quarantined: number;
	readonly skipped: number;
}

export interface SessionAuthorityMigrationCheckpoint {
	readonly kind: "openwebui-gjc-session-authority-migration";
	readonly version: typeof SESSION_AUTHORITY_MIGRATION_VERSION;
	readonly sourcePath: string;
	readonly sourceSha256: string;
	readonly adminPrincipalId: string;
	readonly sourceRecoveryPath: string;
	readonly destinationPath: string;
	readonly destinationSha256?: string;
	readonly status: SessionAuthorityMigrationStatus;
	readonly items: readonly SessionAuthorityMigrationItem[];
	readonly counts: SessionAuthorityMigrationCounts;
	readonly updatedAt: string;
	readonly completedAt?: string;
	readonly quarantinePath?: string;
	readonly reason?: string;
}

export interface SessionAuthorityMigrationResult {
	readonly status: SessionAuthorityMigrationStatus;
	readonly sourcePath: string;
	readonly sourceSha256?: string;
	readonly sourceRecoveryPath?: string;
	readonly originalSourcePath?: string;
	readonly sourceBytesPath?: string;
	readonly migrationRecoveryPath: string;
	readonly recoveryPath: string;
	readonly destinationPath: string;
	readonly checkpointPath?: string;
	readonly auditPath?: string;
	readonly quarantinePath?: string;
	readonly checkpoint?: SessionAuthorityMigrationCheckpoint;
	readonly counts: SessionAuthorityMigrationCounts;
	readonly reason?: string;
}

export interface SessionAuthorityMigrationOptions {
	readonly sourcePath: string;
	readonly stateRoot: string;
	readonly adminPrincipalId: string;
}
