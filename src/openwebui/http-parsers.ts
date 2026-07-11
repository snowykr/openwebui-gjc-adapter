import type { OpenWebUIChatRecord } from "./client";
import type { OpenWebUIFileContent } from "./http-client";

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
	const id = requireString(value.id, request, "chat.id");
	const ownerUserId =
		typeof value.owner_user_id === "string"
			? value.owner_user_id
			: requireString(value.user_id, request, "chat.user_id");
	const chatBody = value.chat === undefined ? value : requireRecord(value.chat, request, "chat.chat");
	const history = parseHistory(chatBody.history, request, { chatId: id, ownerUserId });
	const record: OpenWebUIChatRecord = {
		id,
		owner_user_id: ownerUserId,
		folder_id: optionalString(value.folder_id, request, "chat.folder_id") ?? "",
		title: requireString(value.title, request, "chat.title"),
		metadata: requireRecord(
			value.metadata ?? value.meta ?? chatBody.metadata ?? chatBody.meta ?? {},
			request,
			"chat.metadata",
		),
		history,
	};
	if (value.rating === undefined) return record;
	if (value.rating !== null && typeof value.rating !== "number") {
		throw invalidResponse(request, "chat.rating must be a number or null");
	}
	return { ...record, rating: value.rating };
}

function parseHistory(
	value: unknown,
	request: ParseOpenWebUIHttpRequest,
	context: { readonly chatId: string; readonly ownerUserId: string },
): OpenWebUIChatRecord["history"] {
	if (!isRecord(value)) throw invalidResponse(request, "chat.history must be a JSON object");
	const messages = requireRecord(value.messages, request, "chat.history.messages");
	const parsedMessages: OpenWebUIChatRecord["history"]["messages"] = {};
	for (const [id, message] of Object.entries(messages)) {
		parsedMessages[id] = parseHistoryMessage(message, request, context);
	}
	const currentId = value.currentId;
	if (currentId !== null && typeof currentId !== "string") {
		throw invalidResponse(request, "chat.history.currentId must be a string or null");
	}
	return { messages: parsedMessages, currentId };
}

export function parseOpenWebUIFileContent(value: unknown, request: ParseOpenWebUIHttpRequest): OpenWebUIFileContent {
	if (!isRecord(value)) throw invalidResponse(request, "file response must be a JSON object");
	const id = requireString(value.id, request, "file.id");
	const filename = optionalString(value.filename, request, "file.filename");
	const data =
		value.data === undefined || value.data === null ? undefined : requireRecord(value.data, request, "file.data");
	const content = data === undefined ? undefined : optionalString(data.content, request, "file.data.content");
	return {
		id,
		...(filename === undefined ? {} : { filename }),
		...(content === undefined ? {} : { content }),
	};
}

function parseHistoryMessage(
	value: unknown,
	request: ParseOpenWebUIHttpRequest,
	context: { readonly chatId: string; readonly ownerUserId: string },
): OpenWebUIChatRecord["history"]["messages"][string] {
	if (!isRecord(value)) throw invalidResponse(request, "chat history messages must be JSON objects");
	const message = {
		id: requireString(value.id, request, "message.id"),
		chat_id: optionalString(value.chat_id, request, "message.chat_id") ?? context.chatId,
		owner_user_id: optionalString(value.owner_user_id, request, "message.owner_user_id") ?? context.ownerUserId,
		role: requireString(value.role, request, "message.role"),
		content: requireString(value.content, request, "message.content"),
		metadata: requireRecord(value.metadata ?? {}, request, "message.metadata"),
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

function optionalString(value: unknown, request: ParseOpenWebUIHttpRequest, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw invalidResponse(request, `${field} must be a string or null`);
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
