import { copyEvents } from "./session-authority-copy";
import type { SessionMapping } from "./session-mapping-store";
import { copyAttachment } from "./session-operation-codec";

export function copySessionMapping(mapping: SessionMapping): SessionMapping {
	return {
		chatId: mapping.chatId,
		projectId: mapping.projectId,
		sessionId: mapping.sessionId,
		...(mapping.sessionFile === undefined ? {} : { sessionFile: mapping.sessionFile }),
		...(mapping.activeLeaf === undefined ? {} : { activeLeaf: mapping.activeLeaf }),
		rawFrameCursor: mapping.rawFrameCursor,
		eventCursor: mapping.eventCursor,
		operationId: mapping.operationId,
		...(mapping.assistantText === undefined ? {} : { assistantText: mapping.assistantText }),
		...(mapping.events === undefined ? {} : { events: copyEvents(mapping.events) }),
		...(mapping.modelSelection === undefined ? {} : { modelSelection: { ...mapping.modelSelection } }),
		...(mapping.attachment === undefined ? {} : { attachment: copyAttachment(mapping.attachment) }),
	};
}
