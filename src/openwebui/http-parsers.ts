import type { OpenWebUIChatRecord } from "./client";

export interface ParseOpenWebUIHttpRequest {
	readonly method: string;
	readonly path: string;
	readonly body?: unknown;
}

interface OpenWebUIInvalidResponseErrorInput extends ParseOpenWebUIHttpRequest {
	readonly detail: string;
}

export class OpenWebUIInvalidResponseError extends Error {
	readonly method: string;
	readonly path: string;
	readonly detail: string;

	constructor(input: OpenWebUIInvalidResponseErrorInput) {
		super(`OpenWebUI HTTP ${input.method} ${input.path} returned an invalid response: ${input.detail}`);
		this.name = "OpenWebUIInvalidResponseError";
		this.method = input.method;
		this.path = input.path;
		this.detail = input.detail;
	}
}

export function parseOpenWebUIChatRecord(value: unknown, request: ParseOpenWebUIHttpRequest): OpenWebUIChatRecord {
	if (!isRecord(value)) throw invalidResponse(request, "chat response must be a JSON object");
	const history = parseHistory(value.history, request);
	const record: OpenWebUIChatRecord = {
		id: requireString(value.id, request, "chat.id"),
		owner_user_id: requireString(value.owner_user_id, request, "chat.owner_user_id"),
		folder_id: requireString(value.folder_id, request, "chat.folder_id"),
		title: requireString(value.title, request, "chat.title"),
		metadata: requireRecord(value.metadata, request, "chat.metadata"),
		history,
	};
	if (value.rating === undefined) return record;
	if (value.rating !== null && typeof value.rating !== "number") {
		throw invalidResponse(request, "chat.rating must be a number or null");
	}
	return { ...record, rating: value.rating };
}

function parseHistory(value: unknown, request: ParseOpenWebUIHttpRequest): OpenWebUIChatRecord["history"] {
	if (!isRecord(value)) throw invalidResponse(request, "chat.history must be a JSON object");
	const messages = requireRecord(value.messages, request, "chat.history.messages");
	const parsedMessages: OpenWebUIChatRecord["history"]["messages"] = {};
	for (const [id, message] of Object.entries(messages)) {
		parsedMessages[id] = parseHistoryMessage(message, request);
	}
	const currentId = value.currentId;
	if (currentId !== null && typeof currentId !== "string") {
		throw invalidResponse(request, "chat.history.currentId must be a string or null");
	}
	return { messages: parsedMessages, currentId };
}

function parseHistoryMessage(
	value: unknown,
	request: ParseOpenWebUIHttpRequest,
): OpenWebUIChatRecord["history"]["messages"][string] {
	if (!isRecord(value)) throw invalidResponse(request, "chat history messages must be JSON objects");
	const message = {
		id: requireString(value.id, request, "message.id"),
		chat_id: requireString(value.chat_id, request, "message.chat_id"),
		owner_user_id: requireString(value.owner_user_id, request, "message.owner_user_id"),
		role: requireString(value.role, request, "message.role"),
		content: requireString(value.content, request, "message.content"),
		metadata: requireRecord(value.metadata, request, "message.metadata"),
	};
	const parentId = value.parentId;
	if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
		throw invalidResponse(request, "message.parentId must be a string or null");
	}
	return parentId === undefined ? message : { ...message, parentId };
}

function requireString(value: unknown, request: ParseOpenWebUIHttpRequest, field: string): string {
	if (typeof value !== "string") throw invalidResponse(request, `${field} must be a string`);
	return value;
}

function requireRecord(value: unknown, request: ParseOpenWebUIHttpRequest, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalidResponse(request, `${field} must be a JSON object`);
	return value;
}

function invalidResponse(request: ParseOpenWebUIHttpRequest, detail: string): OpenWebUIInvalidResponseError {
	return new OpenWebUIInvalidResponseError({ ...request, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
