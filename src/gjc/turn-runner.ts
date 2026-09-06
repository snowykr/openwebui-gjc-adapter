import type { NormalizedModelSelection } from "../contracts";
import type { LiveGatewayRunnerInput } from "../live/chat-completions";
import type { WorkflowGateAnswer } from "../projection/workflow-gates";
import type { RegisteredProject } from "../projects/registry";
import type {
	GjcLifecyclePublicationAddress,
	GjcLifecycleScoped,
	GjcLifecycleTransaction,
	GjcSessionAddress,
} from "./lifecycle-transaction";
import type { SessionAttachmentProof } from "./session-authority";
import type { AcknowledgedSuccessor } from "./session-authority-types";
import type { SessionMapping } from "./session-mapping-store";

/** Complete, durable authority required before a managed SDK operation can cross process ownership. */
export interface ManagedTurnAuthority {
	readonly principalId: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly leaseId: string;
	readonly epoch: string;
	readonly requestKey: string;
}

/**
 * Credential-free authority admitted before managed session creation. Session
 * identity and generation are assigned only by the managed lifecycle service.
 */
export interface ManagedPreparedTurnAuthority {
	readonly principalId: string;
	readonly projectId: string;
	readonly canonicalWorkspace: string;
	readonly chatId: string;
	readonly leaseId: string;
	readonly epoch: string;
	readonly requestKey: string;
}

/** Durable managed authority proof; unlike legacy proof it contains no descriptor or terminal identity. */
export interface ManagedGenerationProof {
	readonly kind: "managed-generation";
	readonly sessionId: string;
	readonly generation: number;
	readonly leaseId: string;
	readonly epoch: string;
}

/** Explicit managed variants prevent legacy inputs from being mistaken for tenant-authorized traffic. */
export type ManagedContinueSessionInput = GjcContinueSessionInput & { readonly authority: ManagedTurnAuthority };
export type ManagedStartNewSessionInput = GjcStartNewSessionInput & {
	readonly authority: ManagedPreparedTurnAuthority;
};
export type ManagedSessionStateInput = GjcSessionStateInput & { readonly authority: ManagedTurnAuthority };
export type ManagedRespondWorkflowGateInput = GjcRespondWorkflowGateInput & {
	readonly authority: ManagedTurnAuthority;
};
export type ManagedCancelTurnInput = GjcCancelTurnInput & { readonly authority: ManagedTurnAuthority };
export interface ManagedLifecycleControlInput {
	readonly authority: ManagedTurnAuthority;
	readonly operation: "session.create" | "session.resume" | "session.close" | "session.delete";
}
export interface ManagedCloseInput {
	readonly authority: ManagedTurnAuthority;
}

export type GjcTurnEventObserver = (event: GjcTurnEvent) => Promise<void> | void;
export type {
	GjcLifecyclePublicationAddress,
	GjcLifecycleScoped,
	GjcLifecycleTransaction,
	GjcSessionAddress,
} from "./lifecycle-transaction";

export interface GjcStartNewSessionInput {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly projectId: string;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly modelSelection?: NormalizedModelSelection;
	readonly observer?: GjcTurnEventObserver;
	readonly signal?: AbortSignal;
	readonly principalId?: string;
	readonly preparedManagedAuthority?: ManagedPreparedTurnAuthority;
}

export interface GjcContinueSessionInput extends GjcSessionAddress, GjcLifecycleScoped {
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly sessionFile?: string;
	readonly recoveryAttachment?: SessionAttachmentProof;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly modelSelection?: NormalizedModelSelection;
	readonly observer?: GjcTurnEventObserver;
	readonly signal?: AbortSignal;
	readonly principalId?: string;
	/** Persisted managed authority. It is distinct from new-session prepared authority. */
	readonly managedAuthority?: ManagedTurnAuthority;
	readonly onDispatch?: () => void;
}

export interface GjcSessionStateInput extends GjcSessionAddress, GjcLifecycleScoped {
	readonly sessionFile?: string;
	readonly recoveryAttachment?: SessionAttachmentProof;
	readonly managedAuthority?: ManagedTurnAuthority;
}

export interface GjcRespondWorkflowGateInput extends GjcSessionAddress, GjcLifecycleScoped {
	readonly gateId: string;
	readonly answer: WorkflowGateAnswer;
	readonly promptText: string;
	readonly idempotencyKey?: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly sessionFile?: string;
	readonly recoveryAttachment?: SessionAttachmentProof;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly gateCorrelation?: GjcWorkflowGateCorrelation;
	readonly observer?: GjcTurnEventObserver;
	readonly signal?: AbortSignal;
	readonly principalId?: string;
	readonly managedAuthority?: ManagedTurnAuthority;
	readonly onDispatch?: () => void;
}

export interface GjcWorkflowGateCorrelation {
	readonly commandId: string;
	readonly turnId: string;
	readonly sessionId: string;
}

export interface GjcSessionState {
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly attachment?: SessionAttachmentProof;
	readonly managedProof?: ManagedGenerationProof;
	readonly managedAuthority?: ManagedTurnAuthority;
}

export interface GjcTurnEvent {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly payload?: Readonly<Record<string, unknown>>;
}

export interface GjcCancelTurnInput {
	readonly projectId: string;
	readonly chatId: string;
	readonly sessionId?: string;
	readonly operationId?: string;
	readonly principalId?: string;
	readonly managedAuthority?: ManagedTurnAuthority;
}

export class GjcTurnCancelledError extends Error {
	readonly code = "gjc_turn_cancelled";

	constructor() {
		super("GJC turn was cancelled.");
		this.name = "GjcTurnCancelledError";
	}
}

export interface GjcTurnResult {
	readonly text: string;
	readonly events: readonly GjcTurnEvent[];
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly modelSelection?: NormalizedModelSelection;
	readonly attachment?: SessionAttachmentProof;
	readonly managedProof?: ManagedGenerationProof;
	readonly managedAuthority?: ManagedTurnAuthority;
}
export interface GjcControlResult {
	readonly result?: GjcTurnResult;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly attachment?: SessionAttachmentProof;
}

export interface GjcTurnRunner {
	stop?(): void;
	cancelTurn?(input: GjcCancelTurnInput): void | Promise<void>;
	clearTurnCancellation?(input: GjcCancelTurnInput): void;
	withLifecyclePublication?<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	startManagedSession?<T>(
		input: GjcStartNewSessionInput & { readonly preparedManagedAuthority: ManagedPreparedTurnAuthority },
		publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress,
			proof: ManagedGenerationProof,
			lifecycle: GjcLifecycleTransaction,
		) => Promise<void>,
		onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	): Promise<T>;
	continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult>;
	getState(input: GjcSessionStateInput): Promise<GjcSessionState>;
	getAvailableModels?(input: GjcSessionStateInput): Promise<readonly unknown[]>;
	respondWorkflowGate?(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult>;
	streamTurn?(input: GjcStartNewSessionInput | GjcContinueSessionInput): AsyncIterable<GjcTurnEvent>;
	runTurn?(input: GjcStartNewSessionInput | GjcContinueSessionInput): Promise<GjcTurnResult>;
	runControl?(
		input: LiveGatewayRunnerInput,
		mapping: SessionMapping,
		lifecycle: GjcLifecycleTransaction,
		onAcknowledgedSuccessor?: (successor: AcknowledgedSuccessor) => Promise<void> | void,
		onDispatch?: () => void,
	): Promise<GjcControlResult>;
}

export function getProjectSessionRoot(project: RegisteredProject): string {
	return project.sessionRoot ?? `${project.cwd}/.gjc/sessions`;
}
