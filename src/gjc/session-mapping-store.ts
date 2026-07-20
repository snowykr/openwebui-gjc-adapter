export interface SessionMapping {
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly import("./turn-runner").GjcTurnEvent[];
	readonly modelSelection?: import("../contracts").NormalizedModelSelection;
	readonly attachment?: import("./session-authority").SessionAttachmentProof;
}

export { FileBackedSessionMappingStore } from "./session-file-backed-mapping-store";
export { copySessionMapping } from "./session-mapping-copy";
export { SessionMappingStore } from "./session-mapping-memory-store";
