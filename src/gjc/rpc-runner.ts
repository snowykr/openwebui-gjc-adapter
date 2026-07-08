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
