import type {
	OpenAIChatAttachment,
	OpenAIChatAttachmentDocument,
	OpenAIChatCompletionRequest,
	OpenAIChatContentPart,
	OpenAIChatImageUrlObject,
	OpenAIChatMessage,
} from "./openai-types";

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

	let request: OpenAIChatCompletionRequest = {
		model: value.model,
		messages: messages.value,
	};
	if (value.reasoning_effort !== undefined) {
		if (typeof value.reasoning_effort !== "string") {
			return invalidChatCompletionRequest("Request reasoning_effort must be a string when provided.");
		}
		request = { ...request, reasoning_effort: value.reasoning_effort };
	}
	if (value.metadata !== undefined) {
		if (!isRecord(value.metadata)) return invalidChatCompletionRequest("Request metadata must be a JSON object.");
		request = { ...request, metadata: parseMetadata(value.metadata) };
	}
	if (value.files !== undefined) {
		const files = parseFiles(value.files);
		if (!files.ok) return invalidChatCompletionRequest(files.message);
		request = { ...request, files: files.value };
	}
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
		return invalidMessage("Request message content must be a string, null, or supported content parts array.");
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
	if (value.type === "text") {
		if (typeof value.text !== "string")
			return invalidMessage("Request text content parts must include a text string.");
		return { ok: true, value: { type: "text", text: value.text } };
	}
	if (value.type === "image_url") return parseImageUrlPart(value);
	if (value.type === "file") return parseFilePart(value);
	return invalidMessage("Request content parts must include a supported type: text, image_url, or file.");
}

function parseImageUrlPart(
	value: Record<string, unknown>,
): { readonly ok: true; readonly value: OpenAIChatContentPart } | { readonly ok: false; readonly message: string } {
	const imageUrl = parseImageUrl(value.image_url);
	if (!imageUrl.ok) return imageUrl;
	return { ok: true, value: { type: "image_url", image_url: imageUrl.value } };
}

function parseImageUrl(
	value: unknown,
):
	| { readonly ok: true; readonly value: string | OpenAIChatImageUrlObject }
	| { readonly ok: false; readonly message: string } {
	if (typeof value === "string") return { ok: true, value };
	if (!isRecord(value) || typeof value.url !== "string") {
		return invalidMessage(
			"Request image_url content parts must include an image_url string or object with a url string.",
		);
	}
	if (value.detail !== undefined && typeof value.detail !== "string") {
		return invalidMessage("Request image_url detail must be a string when provided.");
	}
	return typeof value.detail === "string"
		? { ok: true, value: { url: value.url, detail: value.detail } }
		: { ok: true, value: { url: value.url } };
}

function parseFilePart(
	value: Record<string, unknown>,
): { readonly ok: true; readonly value: OpenAIChatContentPart } | { readonly ok: false; readonly message: string } {
	if (!isRecord(value.file)) return invalidMessage("Request file content parts must include a file JSON object.");
	return { ok: true, value: { type: "file", file: normalizeAttachment(value.file) } };
}

function parseFiles(
	value: unknown,
):
	| { readonly ok: true; readonly value: readonly OpenAIChatAttachment[] }
	| { readonly ok: false; readonly message: string } {
	if (!Array.isArray(value)) return invalidMessage("Request files must be an array when provided.");
	const files: OpenAIChatAttachment[] = [];
	for (const fileValue of value) {
		if (!isRecord(fileValue)) return invalidMessage("Request files entries must be JSON objects.");
		files.push(normalizeAttachment(fileValue));
	}
	return { ok: true, value: files };
}

function normalizeAttachment(value: Record<string, unknown>): OpenAIChatAttachment {
	const type = stringField(value, "type");
	const id = firstStringField(value, ["id", "file_id"]);
	const name = firstStringField(value, ["name", "filename", "title"]);
	const url = firstStringField(value, ["url", "path"]);
	const content = firstStringField(value, ["content", "text", "document"]);
	const attachment: OpenAIChatAttachment = { documents: normalizeDocuments(value.docs) };
	return {
		...attachment,
		...(type === null ? {} : { type }),
		...(id === null ? {} : { id }),
		...(name === null ? {} : { name }),
		...(url === null ? {} : { url }),
		...(content === null ? {} : { content }),
	};
}

function normalizeDocuments(value: unknown): readonly OpenAIChatAttachmentDocument[] {
	if (!Array.isArray(value)) return [];
	const documents: OpenAIChatAttachmentDocument[] = [];
	for (const entry of value) {
		const content = documentContent(entry);
		if (content !== null) documents.push({ content });
	}
	return documents;
}

function documentContent(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (!isRecord(value)) return null;
	return firstStringField(value, ["content", "text", "page_content", "document"]);
}

function parseMetadata(value: Record<string, unknown>): Record<string, unknown> {
	return { ...value };
}

function firstStringField(value: Record<string, unknown>, names: readonly string[]): string | null {
	for (const name of names) {
		const field = stringField(value, name);
		if (field !== null) return field;
	}
	return null;
}

function stringField(value: Record<string, unknown>, name: string): string | null {
	const field = value[name];
	return typeof field === "string" && field.length > 0 ? field : null;
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
