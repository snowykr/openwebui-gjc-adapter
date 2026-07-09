export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIChatMessage {
	readonly role: OpenAIChatRole;
	readonly content: string | readonly OpenAIChatContentPart[] | null;
	readonly name?: string;
}

export type OpenAIChatAttachmentDocument = {
	readonly content: string;
};

export type OpenAIChatAttachment = {
	readonly type?: string;
	readonly id?: string;
	readonly name?: string;
	readonly url?: string;
	readonly content?: string;
	readonly documents: readonly OpenAIChatAttachmentDocument[];
};

export type OpenAIChatContentPart =
	| OpenAIChatTextContentPart
	| OpenAIChatImageUrlContentPart
	| OpenAIChatFileContentPart;

export interface OpenAIChatTextContentPart {
	readonly type: "text";
	readonly text: string;
}

export interface OpenAIChatImageUrlObject {
	readonly url: string;
	readonly detail?: string;
}

export interface OpenAIChatImageUrlContentPart {
	readonly type: "image_url";
	readonly image_url: string | OpenAIChatImageUrlObject;
}

export interface OpenAIChatFileContentPart {
	readonly type: "file";
	readonly file: OpenAIChatAttachment;
}

export interface OpenAIChatCompletionRequest {
	readonly model: string;
	readonly messages: readonly OpenAIChatMessage[];
	readonly stream?: boolean;
	readonly metadata?: Record<string, unknown>;
	readonly files?: readonly OpenAIChatAttachment[];
}

export interface OpenAIModelEntry {
	readonly id: string;
	readonly object: "model";
	readonly created: number;
	readonly owned_by: string;
}

export interface OpenAIModelListResponse {
	readonly object: "list";
	readonly data: readonly OpenAIModelEntry[];
}

export interface OpenAIChatCompletionChoice {
	readonly index: number;
	readonly message: OpenAIChatMessage;
	readonly finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIChatCompletionResponse {
	readonly id: string;
	readonly object: "chat.completion";
	readonly created: number;
	readonly model: string;
	readonly choices: readonly OpenAIChatCompletionChoice[];
	readonly usage?: OpenAIUsage;
	readonly metadata?: Record<string, unknown>;
}

export interface OpenAIChatCompletionChunkChoice {
	readonly index: number;
	readonly delta: Partial<OpenAIChatMessage>;
	readonly finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIChatCompletionChunk {
	readonly id: string;
	readonly object: "chat.completion.chunk";
	readonly created: number;
	readonly model: string;
	readonly choices: readonly OpenAIChatCompletionChunkChoice[];
}

export interface OpenAIUsage {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
}
