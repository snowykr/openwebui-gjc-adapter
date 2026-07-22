import type { NormalizedModelSelection } from "../contracts";
import type { RegisteredProject } from "../projects/registry";
import type { SessionMapping, SessionMappingStore } from "./session-mapping-store";
import type { GjcTurnEvent, GjcTurnEventObserver, GjcTurnResult, GjcTurnRunner } from "./turn-runner";

export interface RouteGjcTurnInput {
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly runner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly modelSelection?: NormalizedModelSelection;
	readonly projectAssistantText?: (result: GjcTurnResult) => string;
	readonly afterPublish?: (result: RouteGjcTurnResult) => void;
	readonly onObservedTurn?: GjcTurnEventObserver;
}

export interface RouteGjcTurnResult {
	readonly assistantText: string;
	readonly events: readonly GjcTurnEvent[];
	readonly mapping: SessionMapping;
}
