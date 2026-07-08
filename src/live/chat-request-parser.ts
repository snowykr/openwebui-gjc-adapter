import type { OpenAIChatCompletionRequest, OpenAIChatContentPart, OpenAIChatMessage } from "./openai-types";

export type ChatCompletionRequestParseResult =
	| { readonly ok: true; readonly request: OpenAIChatCompletionRequest }
	| { readonly ok: false; readonly message: string };

export function parseChatCompletionRequest(value: unknown): ChatCompletionRequestParseResult {
	if (!isRecord(value)) return invalidChatCompletionRequest("Request body must be a JSON object.");
	if (typeof value.model !== "string")
		return invalidChatCompletionRequest("Request body must include a model string.");
	if (!Array.isArray(value.messages))
		return invalidChatCompletionRequest("Request body must include a messages array.");

	const messages = parseMessages(value.messages);
	if (!messages.ok) return invalidChatCompletionRequest(messages.message);

	const request: OpenAIChatCompletionRequest = {
		model: value.model,
		messages: messages.value,
	};
	if (value.stream !== undefined && typeof value.stream !== "boolean") {
		return invalidChatCompletionRequest("Request stream must be a boolean when provided.");
	}
	if (typeof value.stream === "boolean") {
		return { ok: true, request: { ...request, stream: value.stream } };
	}
	return { ok: true, request };
}

function parseMessages(
	values: readonly unknown[],
):
	| { readonly ok: true; readonly value: readonly OpenAIChatMessage[] }
	| { readonly ok: false; readonly message: string } {
	const messages: OpenAIChatMessage[] = [];
	for (const value of values) {
		const message = parseMessage(value);
		if (!message.ok) return message;
		messages.push(message.value);
	}
	return { ok: true, value: messages };
}

function parseMessage(
	value: unknown,
): { readonly ok: true; readonly value: OpenAIChatMessage } | { readonly ok: false; readonly message: string } {
	if (!isRecord(value)) return invalidMessage("Request messages must be JSON objects.");
	const role = value.role;
	if (!isChatRole(role)) return invalidMessage("Request messages must include a supported role.");
	const content = parseMessageContent(value.content);
	if (!content.ok) return invalidMessage(content.message);
	if (value.name !== undefined && typeof value.name !== "string")
		return invalidMessage("Request message names must be strings.");
	if (typeof value.name === "string") return { ok: true, value: { role, content: content.value, name: value.name } };
	return { ok: true, value: { role, content: content.value } };
}

function parseMessageContent(
	value: unknown,
):
	| { readonly ok: true; readonly value: OpenAIChatMessage["content"] }
	| { readonly ok: false; readonly message: string } {
	if (typeof value === "string" || value === null) return { ok: true, value };
	if (!Array.isArray(value))
		return invalidMessage("Request message content must be a string, null, or text parts array.");
	const parts: OpenAIChatContentPart[] = [];
	for (const partValue of value) {
		const part = parseContentPart(partValue);
		if (!part.ok) return part;
		parts.push(part.value);
	}
	return { ok: true, value: parts };
}

function parseContentPart(
	value: unknown,
): { readonly ok: true; readonly value: OpenAIChatContentPart } | { readonly ok: false; readonly message: string } {
	if (!isRecord(value)) return invalidMessage("Request content parts must be JSON objects.");
	if (value.type !== "text" || typeof value.text !== "string") {
		return invalidMessage("Request content parts must include type text and a text string.");
	}
	return { ok: true, value: { type: "text", text: value.text } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatRole(value: unknown): value is OpenAIChatMessage["role"] {
	return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function invalidChatCompletionRequest(message: string): ChatCompletionRequestParseResult {
	return { ok: false, message };
}

function invalidMessage(message: string): { readonly ok: false; readonly message: string } {
	return { ok: false, message };
}
