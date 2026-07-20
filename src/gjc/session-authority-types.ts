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

export interface SessionOperationResult {
	readonly kind: "turn" | "control" | "close";
	readonly assistantText: string;
	readonly events: readonly GjcTurnEvent[];
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
}

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
}

export type SessionAuthorityInput = Omit<SessionAuthorityRecord, "version" | "createdAt" | "header" | "journal"> &
	Partial<Pick<SessionAuthorityRecord, "createdAt" | "journal" | "header" | "version">>;
