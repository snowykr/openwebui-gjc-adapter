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

export type {
	GjcLifecycleOwner,
	GjcLifecyclePublicationAddress,
	GjcLifecycleScoped,
	GjcLifecycleTestBarrierEvidence,
	GjcLifecycleTestBarrierHook,
	GjcLifecycleTestBarrierPhase,
	GjcLifecycleTransaction,
	GjcSessionAddress,
} from "./lifecycle-transaction";
export { GjcCloseReceipt } from "./lifecycle-transaction";

export interface GjcStartNewSessionInput {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly projectId: string;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly modelSelection?: NormalizedModelSelection;
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
}

export interface GjcSwitchSessionInput extends GjcSessionAddress, GjcLifecycleScoped {
	readonly sessionFile?: string;
	readonly recoveryAttachment?: SessionAttachmentProof;
}

export interface GjcSessionStateInput extends GjcSessionAddress, GjcLifecycleScoped {
	readonly sessionFile?: string;
	readonly recoveryAttachment?: SessionAttachmentProof;
}

export interface GjcRespondWorkflowGateInput extends GjcSessionAddress, GjcLifecycleScoped {
	readonly gateId: string;
	readonly answer: WorkflowGateAnswer;
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
}

export interface GjcTurnEvent {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly payload?: Readonly<Record<string, unknown>>;
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
}
export interface GjcControlResult {
	readonly result?: GjcTurnResult;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly attachment?: SessionAttachmentProof;
}

export interface GjcTurnRunner {
	stop?(): void;
	resolveSessionRoot?(cwd: string): string;
	discardSessionAttachment?(cwd: string, sessionId: string): void;
	withLifecyclePublication?<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	/** Runs a close-only lifecycle transaction without recovering or attaching a dropped cache entry. */
	withLifecycleClosePreflight?<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress,
			attachment: SessionAttachmentProof,
			lifecycle: GjcLifecycleTransaction,
		) => Promise<void>,
		onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	): Promise<T>;
	continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult>;
	switchSession(input: GjcSwitchSessionInput): Promise<void>;
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
	): Promise<GjcControlResult>;
}

export function getProjectSessionRoot(project: RegisteredProject): string {
	return project.sessionRoot ?? `${project.cwd}/.gjc/sessions`;
}
