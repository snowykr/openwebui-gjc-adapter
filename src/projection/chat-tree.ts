import * as path from "node:path";
import type { TextContent } from "@gajae-code/ai";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import { ADAPTER_PROJECTION_VERSION, buildLineageHash } from "../state/metadata";
import { type SessionEntryGraphDiagnostic, validateSessionEntryGraph } from "./chat-tree-graph";

export type {
	SessionEntryGraphDiagnostic,
	SessionEntryGraphDiagnosticCode,
	SessionEntryGraphValidationResult,
} from "./chat-tree-graph";
export { validateSessionEntryGraph } from "./chat-tree-graph";

export interface GjcSessionProjectionInput {
	sessionFile: string;
	header: SessionHeader;
	entries: SessionEntry[];
}

export interface OpenWebUIProjectedMessage {
	id: string;
	parentId: string | null;
	childrenIds: string[];
	role: string;
	content: string;
	timestamp: number;
	metadata: {
		gjc_adapter: {
			projectionVersion: number;
			sessionFileName: string;
			gjcSessionId: string;
			gjcEntryId: string;
			lineageHash: string;
		};
	};
}

export interface OpenWebUIProjectedChat {
	id: string;
	title?: string;
	history: {
		messages: Record<string, OpenWebUIProjectedMessage>;
		currentId: string | null;
	};
	metadata: {
		gjc_adapter: {
			projectionVersion: number;
			sessionFileName: string;
			gjcSessionId: string;
			gjcEntryId: string | null;
			lineageHash: string;
			entryCount: number;
			messageEntryCount: number;
			nonMessageEntryCount: number;
			diagnostics: SessionEntryGraphDiagnostic[];
		};
	};
}

export function projectGjcSessionToOpenWebUIChat(input: GjcSessionProjectionInput): OpenWebUIProjectedChat {
	const validation = validateSessionEntryGraph(input.entries);
	const entriesById = validation.entriesById;
	const messages: Record<string, OpenWebUIProjectedMessage> = {};
	const visibleParentByMessageId = new Map<string, string | null>();
	const messageChildrenById = new Map<string, string[]>();
	let messageEntryCount = 0;

	for (const entry of entriesById.values()) {
		if (entry.type !== "message") continue;
		messageEntryCount++;
		visibleParentByMessageId.set(entry.id, findNearestMessageAncestor(entry.parentId, entriesById));
		messageChildrenById.set(entry.id, []);
	}

	for (const [messageId, parentMessageId] of visibleParentByMessageId) {
		if (parentMessageId === null) continue;
		messageChildrenById.get(parentMessageId)?.push(messageId);
	}

	for (const entry of entriesById.values()) {
		if (entry.type !== "message") continue;
		messages[entry.id] = projectMessageEntry(
			input,
			entry,
			visibleParentByMessageId.get(entry.id) ?? null,
			messageChildrenById.get(entry.id) ?? [],
		);
	}

	const currentId = findProjectedCurrentId(validation.currentId, entriesById, messages);
	const lineageHash = buildLineageHash([input.sessionFile, input.header.id, currentId ?? ""]);
	const sessionFileName = path.basename(input.sessionFile);

	return {
		id: input.header.id,
		title: input.header.title,
		history: {
			messages,
			currentId,
		},
		metadata: {
			gjc_adapter: {
				projectionVersion: ADAPTER_PROJECTION_VERSION,
				sessionFileName,
				gjcSessionId: input.header.id,
				gjcEntryId: currentId,
				lineageHash,
				entryCount: entriesById.size,
				messageEntryCount,
				nonMessageEntryCount: entriesById.size - messageEntryCount,
				diagnostics: validation.diagnostics,
			},
		},
	};
}

function findProjectedCurrentId(
	currentId: string | null,
	entriesById: Map<string, SessionEntry>,
	messages: Record<string, OpenWebUIProjectedMessage>,
): string | null {
	let cursor = currentId;
	while (cursor !== null) {
		if (messages[cursor] !== undefined) return cursor;
		cursor = entriesById.get(cursor)?.parentId ?? null;
	}
	return null;
}

function projectMessageEntry(
	input: GjcSessionProjectionInput,
	entry: SessionMessageEntry,
	parentId: string | null,
	childrenIds: string[],
): OpenWebUIProjectedMessage {
	return {
		id: entry.id,
		parentId,
		childrenIds,
		role: entry.message.role,
		content: extractMessageText(entry.message),
		timestamp: entry.message.timestamp,
		metadata: {
			gjc_adapter: {
				projectionVersion: ADAPTER_PROJECTION_VERSION,
				sessionFileName: path.basename(input.sessionFile),
				gjcSessionId: input.header.id,
				gjcEntryId: entry.id,
				lineageHash: buildLineageHash([input.sessionFile, input.header.id, entry.id, parentId ?? ""]),
			},
		},
	};
}

function findNearestMessageAncestor(parentId: string | null, entriesById: Map<string, SessionEntry>): string | null {
	let cursor = parentId;
	const seen = new Set<string>();
	while (cursor !== null) {
		if (seen.has(cursor)) throw new Error(`GJC session entry parent cycle detected at ${cursor}`);
		seen.add(cursor);
		const entry = entriesById.get(cursor);
		if (entry === undefined) return null;
		if (entry.type === "message") return entry.id;
		cursor = entry.parentId;
	}
	return null;
}

function extractMessageText(message: SessionMessageEntry["message"]): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextContent)
		.map(part => part.text)
		.join("");
}

function isTextContent(value: unknown): value is TextContent {
	if (
		typeof value !== "object" ||
		value === null ||
		!("type" in value) ||
		value.type !== "text" ||
		!("text" in value)
	) {
		return false;
	}
	return typeof value.text === "string";
}
