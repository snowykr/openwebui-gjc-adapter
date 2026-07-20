import type { NormalizedModelSelection } from "../contracts";
import type { RegisteredProject } from "../projects/registry";
import type { SessionMapping, SessionMappingStore } from "./session-mapping-store";
import type { GjcTurnEvent, GjcTurnResult, GjcTurnRunner } from "./turn-runner";

export {
	type RouteGjcSessionCloseInput,
	routeGjcSessionClose,
	type SessionCloseIngress,
	type SessionCloseResult,
} from "./session-close-router";
export { SessionFileBoundaryError, validateSessionFile } from "./session-file";
export { FileBackedSessionMappingStore, type SessionMapping, SessionMappingStore } from "./session-mapping-store";
export {
	closeIngressId,
	normalizeModelSelection,
	operationResult,
	replayCloseOperation,
} from "./session-operation-codec";
export { replayOperation, routeGjcTurn } from "./session-turn-router";

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
}

export interface RouteGjcTurnResult {
	readonly assistantText: string;
	readonly events: readonly GjcTurnEvent[];
	readonly mapping: SessionMapping;
}
