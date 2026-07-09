import type { WorkflowGateAnswer } from "../projection/workflow-gates";
import type { RegisteredProject } from "../projects/registry";

export interface GjcSessionAddress {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly chatId: string;
}

export interface GjcStartNewSessionInput {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly projectId: string;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
}

export interface GjcContinueSessionInput extends GjcSessionAddress {
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
}

export interface GjcSwitchSessionInput extends GjcSessionAddress {
	readonly sessionFile?: string;
}

export interface GjcSessionStateInput extends GjcSessionAddress {
	readonly sessionFile?: string;
}

export interface GjcRespondWorkflowGateInput extends GjcSessionAddress {
	readonly gateId: string;
	readonly answer: WorkflowGateAnswer;
	readonly idempotencyKey?: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
}

export interface GjcSessionState {
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
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
}

export interface GjcTurnRunner {
	startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult>;
	continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult>;
	switchSession(input: GjcSwitchSessionInput): Promise<void>;
	getState(input: GjcSessionStateInput): Promise<GjcSessionState>;
	respondWorkflowGate?(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult>;
	streamTurn?(input: GjcStartNewSessionInput | GjcContinueSessionInput): AsyncIterable<GjcTurnEvent>;
	runTurn?(input: GjcStartNewSessionInput | GjcContinueSessionInput): Promise<GjcTurnResult>;
}

export function getProjectSessionRoot(project: RegisteredProject): string {
	return project.sessionRoot ?? `${project.cwd}/.gjc/sessions`;
}

export interface GjcRpcRunnerClientOptions {
	readonly cwd: string;
	readonly sessionRoot: string;
	readonly cliPath?: string;
}

export interface GjcRpcTransportState {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor?: number;
	readonly eventCursor?: number;
	readonly messageCount?: number;
}

export interface GjcRpcRunnerTransportEvent {
	readonly type: string;
	readonly id?: string;
	readonly gate_id?: string;
	readonly gateId?: string;
	readonly stage?: string;
	readonly kind?: string;
	readonly schema?: unknown;
	readonly schema_hash?: string;
	readonly schemaHash?: string;
	readonly created_at?: string;
	readonly createdAt?: string;
	readonly idempotency_key?: string;
	readonly idempotencyKey?: string;
	readonly options?: unknown;
	readonly context?: unknown;
	readonly status?: string;
	readonly required?: boolean;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly assistantMessageEvent?: unknown;
	readonly args?: unknown;
	readonly intent?: string;
	readonly partialResult?: unknown;
	readonly result?: unknown;
	readonly isError?: boolean;
	readonly level?: string;
	readonly source?: string;
	readonly todos?: unknown;
	readonly attempt?: number;
	readonly maxAttempts?: number;
	readonly goal?: unknown;
	readonly state?: unknown;
	readonly reason?: string;
	readonly action?: string;
	readonly aborted?: boolean;
	readonly willRetry?: boolean;
	readonly skipped?: boolean;
	readonly success?: boolean;
	readonly finalError?: string;
	readonly errorMessage?: string;
	readonly from?: string;
	readonly to?: string;
	readonly model?: string;
	readonly role?: string;
	readonly rules?: unknown;
	readonly thinkingLevel?: string;
	readonly message?: unknown;
	readonly payload?: unknown;
}

export interface GjcRpcRunnerTransport {
	start(): Promise<void>;
	stop(): void;
	newSession(): Promise<undefined | { readonly cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<undefined | { readonly cancelled: boolean }>;
	getState(): Promise<GjcRpcTransportState>;
	promptAndWait(message: string, timeoutMs?: number): Promise<readonly GjcRpcRunnerTransportEvent[]>;
	onWorkflowGate?(listener: (gate: GjcRpcRunnerTransportEvent) => void): () => void;
	respondGate?(gateId: string, answer: WorkflowGateAnswer, idempotencyKey?: string): Promise<unknown>;
	getLastAssistantText(): Promise<string | null>;
}

export type GjcRpcRunnerClientFactory = (options: GjcRpcRunnerClientOptions) => GjcRpcRunnerTransport;

export interface CreateGjcRpcTurnRunnerInput {
	readonly clientFactory?: GjcRpcRunnerClientFactory;
	readonly cliPath?: string;
	readonly turnTimeoutMs?: number;
}

export { createGjcRpcTurnRunner, GjcRpcRunnerError } from "./rpc-client-runner";
