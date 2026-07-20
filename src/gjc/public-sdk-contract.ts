import type { NormalizedModelSelection } from "../contracts";

/** A discovery result that authorizes one public SDK session attachment. */
export interface PublicSdkSessionAttachment {
	readonly sessionId: string;
	readonly cwd: string;
	readonly endpoint: {
		readonly url: string;
		readonly token: string;
		/** Released 0.11.2 descriptor PID, when the SDK host publishes it. */
		readonly pid?: number;
	};
	readonly authority?: PublicSdkAttachmentAuthority;
}
/** Descriptor-only proof for one public SDK endpoint; pane ownership is adapter lifecycle evidence, not transport authority. */
export interface PublicSdkAttachmentAuthority {
	readonly descriptorPath: string;
	readonly descriptorStat: Readonly<{
		readonly dev: number;
		readonly ino: number;
		readonly size: number;
		readonly mtimeMs: number;
	}>;
	/** SHA-256 of the exact descriptor bytes, encoded as 64 lowercase hexadecimal characters. */
	readonly payloadDigest: string;
	readonly generation: number;
	readonly expectedSessionId: string;
	readonly expectedCwd: string;
}

export interface PublicSdkTurnCorrelation {
	readonly sessionId: string;
	readonly commandId: string;
	readonly turnId: string;
}

export interface PublicSdkGate {
	readonly gateId: string;
	readonly correlation: PublicSdkTurnCorrelation;
	readonly payload: Readonly<Record<string, unknown>>;
}

export interface PublicSdkTurnOutcome {
	readonly events: readonly Readonly<Record<string, unknown>>[];
	readonly finalizedAssistantText?: string;
	readonly gate?: PublicSdkGate;
}

export interface PublicSdkBranchCandidate {
	readonly entryId: string;
	readonly source: Readonly<Record<string, unknown>>;
}

export interface PublicSdkSessionState {
	readonly sessionId: string;
	readonly model: { readonly provider: string; readonly id: string };
	readonly thinkingLevel: string;
}

/** Reentrant lease token for mutations of one durable session descriptor. */
export type PublicSdkSessionCoordinatorOwner = object;
export interface PublicSdkSessionPort {
	attach(
		attachment: PublicSdkSessionAttachment,
		timeoutMs?: number,
		coordinatorOwner?: PublicSdkSessionCoordinatorOwner,
	): Promise<void>;
	/** Disconnects this transport only; it never closes the remote session. */
	detach(): void;
	getState(timeoutMs?: number): Promise<PublicSdkSessionState>;
	getAvailableModels(timeoutMs?: number): Promise<readonly unknown[]>;
	setModel(
		selection: NormalizedModelSelection,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<NormalizedModelSelection>;
	setThinking(
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<NormalizedModelSelection>;
	prompt(text: string, timeoutMs?: number): Promise<PublicSdkTurnOutcome>;
	reply(
		operation: string,
		input: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<unknown>;
	steer(text: string, idempotencyKey?: string, timeoutMs?: number): Promise<unknown>;
	followUp(text: string, idempotencyKey?: string, timeoutMs?: number): Promise<PublicSdkTurnOutcome>;
	abort(idempotencyKey?: string, timeoutMs?: number): Promise<unknown>;
	abortAndPrompt(text: string, idempotencyKey?: string, timeoutMs?: number): Promise<PublicSdkTurnOutcome>;
	replyToAction(actionId: string, answer: unknown, idempotencyKey?: string, timeoutMs?: number): Promise<unknown>;
	planApprove(input: Readonly<Record<string, unknown>>, idempotencyKey?: string, timeoutMs?: number): Promise<unknown>;
	answerGate(
		gate: PublicSdkGate,
		answer: unknown,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<PublicSdkTurnOutcome>;
	branchCandidates(timeoutMs?: number): Promise<readonly PublicSdkBranchCandidate[]>;
	branch(
		input: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<PublicSdkSessionAttachment>;
	newSession(
		input?: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<PublicSdkSessionAttachment>;
	resumeSession(
		input?: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<PublicSdkSessionAttachment>;
	switchSession(
		input: Readonly<Record<string, unknown>>,
		idempotencyKey?: string,
		timeoutMs?: number,
	): Promise<PublicSdkSessionAttachment>;
	closeSession(idempotencyKey?: string, timeoutMs?: number): Promise<void>;
}
