import type { TextContent } from "@gajae-code/ai";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "@gajae-code/coding-agent";
import { ADAPTER_PROJECTION_VERSION, buildLineageHash } from "../state/metadata";

export type SessionEntryGraphDiagnosticCode = "duplicate_entry_id" | "missing_parent";

export interface SessionEntryGraphDiagnostic {
	code: SessionEntryGraphDiagnosticCode;
	message: string;
	entryId: string;
	parentId?: string;
}

export interface SessionEntryGraphValidationResult {
	diagnostics: SessionEntryGraphDiagnostic[];
	childrenById: Map<string, string[]>;
	currentId: string | null;
}

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
			sessionFile: string;
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
			sessionFile: string;
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

export function validateSessionEntryGraph(entries: readonly SessionEntry[]): SessionEntryGraphValidationResult {
	const diagnostics: SessionEntryGraphDiagnostic[] = [];
	const entriesById = new Map<string, SessionEntry>();
	const childrenById = new Map<string, string[]>();

	for (const entry of entries) {
		if (entriesById.has(entry.id)) {
			diagnostics.push({
				code: "duplicate_entry_id",
				message: `Duplicate GJC session entry id: ${entry.id}`,
				entryId: entry.id,
			});
			continue;
		}
		entriesById.set(entry.id, entry);
		childrenById.set(entry.id, []);
	}

	for (const entry of entriesById.values()) {
		if (entry.parentId === null) continue;
		const siblings = childrenById.get(entry.parentId);
		if (siblings === undefined) {
			diagnostics.push({
				code: "missing_parent",
				message: `GJC session entry ${entry.id} references missing parent ${entry.parentId}`,
				entryId: entry.id,
				parentId: entry.parentId,
			});
			continue;
		}
		siblings.push(entry.id);
	}

	assertAcyclic(entriesById);

	return {
		diagnostics,
		childrenById,
		currentId: findCurrentId(entriesById, childrenById),
	};
}

export function projectGjcSessionToOpenWebUIChat(input: GjcSessionProjectionInput): OpenWebUIProjectedChat {
	const validation = validateSessionEntryGraph(input.entries);
	const entriesById = new Map(input.entries.map(entry => [entry.id, entry]));
	const messages: Record<string, OpenWebUIProjectedMessage> = {};
	const visibleParentByMessageId = new Map<string, string | null>();
	const messageChildrenById = new Map<string, string[]>();
	let messageEntryCount = 0;

	for (const entry of input.entries) {
		if (entry.type !== "message") continue;
		messageEntryCount++;
		visibleParentByMessageId.set(entry.id, findNearestMessageAncestor(entry.parentId, entriesById));
		messageChildrenById.set(entry.id, []);
	}

	for (const [messageId, parentMessageId] of visibleParentByMessageId) {
		if (parentMessageId === null) continue;
		messageChildrenById.get(parentMessageId)?.push(messageId);
	}

	for (const entry of input.entries) {
		if (entry.type !== "message") continue;
		messages[entry.id] = projectMessageEntry(
			input,
			entry,
			visibleParentByMessageId.get(entry.id) ?? null,
			messageChildrenById.get(entry.id) ?? [],
		);
	}

	const currentId = findProjectedCurrentId(validation.currentId, input.entries, messages);
	const lineageHash = buildLineageHash([input.sessionFile, input.header.id, currentId ?? ""]);

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
				sessionFile: input.sessionFile,
				gjcSessionId: input.header.id,
				gjcEntryId: currentId,
				lineageHash,
				entryCount: input.entries.length,
				messageEntryCount,
				nonMessageEntryCount: input.entries.length - messageEntryCount,
				diagnostics: validation.diagnostics,
			},
		},
	};
}

function assertAcyclic(entriesById: Map<string, SessionEntry>): void {
	const visited = new Set<string>();
	const visiting = new Set<string>();

	const visit = (entry: SessionEntry): void => {
		if (visited.has(entry.id)) return;
		if (visiting.has(entry.id)) throw new Error(`GJC session entry parent cycle detected at ${entry.id}`);
		visiting.add(entry.id);
		if (entry.parentId !== null) {
			const parent = entriesById.get(entry.parentId);
			if (parent !== undefined) visit(parent);
		}
		visiting.delete(entry.id);
		visited.add(entry.id);
	};

	for (const entry of entriesById.values()) visit(entry);
}

function findCurrentId(entriesById: Map<string, SessionEntry>, childrenById: Map<string, string[]>): string | null {
	let currentId: string | null = null;
	for (const id of entriesById.keys()) {
		if ((childrenById.get(id) ?? []).length === 0) currentId = id;
	}
	return currentId;
}

function findProjectedCurrentId(
	currentId: string | null,
	entries: readonly SessionEntry[],
	messages: Record<string, OpenWebUIProjectedMessage>,
): string | null {
	let cursor = currentId;
	const entriesById = new Map(entries.map(entry => [entry.id, entry]));
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
				sessionFile: input.sessionFile,
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
