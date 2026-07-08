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
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly message?: unknown;
}

export interface GjcRpcRunnerTransport {
	start(): Promise<void>;
	stop(): void;
	newSession(): Promise<undefined | { readonly cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<undefined | { readonly cancelled: boolean }>;
	getState(): Promise<GjcRpcTransportState>;
	promptAndWait(message: string, timeoutMs?: number): Promise<readonly GjcRpcRunnerTransportEvent[]>;
	getLastAssistantText(): Promise<string | null>;
}

export type GjcRpcRunnerClientFactory = (options: GjcRpcRunnerClientOptions) => GjcRpcRunnerTransport;

export interface CreateGjcRpcTurnRunnerInput {
	readonly clientFactory?: GjcRpcRunnerClientFactory;
	readonly cliPath?: string;
	readonly turnTimeoutMs?: number;
}

export { createGjcRpcTurnRunner, GjcRpcRunnerError } from "./rpc-client-runner";
