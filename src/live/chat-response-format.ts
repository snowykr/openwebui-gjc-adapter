import type { OpenAIChatCompletionChunk, OpenAIChatCompletionResponse } from "./openai-types";

export interface OpenAIErrorResponse {
	readonly error: {
		readonly message: string;
		readonly type: string;
		readonly code: string;
	};
}

export interface AbandonableAsyncIterable<T> extends AsyncIterable<T> {
	abandon(): Promise<void>;
}

export function encodeChatCompletionSse(input: {
	readonly id: string;
	readonly created: number;
	readonly model: string;
	readonly chunks: AsyncIterable<string> | Iterable<string>;
	readonly onAbandon?: () => Promise<void>;
}): AbandonableAsyncIterable<string> {
	const base = {
		id: input.id,
		object: "chat.completion.chunk" as const,
		created: input.created,
		model: input.model,
	};
	const initial: OpenAIChatCompletionChunk = {
		...base,
		choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
	};
	let abandonment: Promise<void> | undefined;
	const abandon = (): Promise<void> => {
		if (abandonment === undefined) abandonment = input.onAbandon?.() ?? Promise.resolve();
		return abandonment;
	};
	return {
		abandon,
		async *[Symbol.asyncIterator](): AsyncGenerator<string> {
			let completed = false;
			try {
				yield `data: ${JSON.stringify(initial)}\n\n`;
				for await (const content of input.chunks) {
					const chunk: OpenAIChatCompletionChunk = {
						...base,
						choices: [{ index: 0, delta: { content }, finish_reason: null }],
					};
					yield `data: ${JSON.stringify(chunk)}\n\n`;
				}
				const terminal: OpenAIChatCompletionChunk = {
					...base,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				};
				yield `data: ${JSON.stringify(terminal)}\n\n`;
				completed = true;
				yield "data: [DONE]\n\n";
			} finally {
				if (!completed) void abandon().catch(() => {});
			}
		},
	};
}

export function buildCompletion(input: {
	readonly id: string;
	readonly created: number;
	readonly model: string;
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
}): OpenAIChatCompletionResponse {
	return {
		id: input.id,
		object: "chat.completion",
		created: input.created,
		model: input.model,
		choices: [{ index: 0, message: { role: "assistant", content: input.content }, finish_reason: "stop" }],
		metadata: input.metadata,
	};
}

export function buildOpenAIErrorResponse(input: {
	readonly type: string;
	readonly code: string;
	readonly message: string;
}): OpenAIErrorResponse {
	return {
		error: {
			message: input.message,
			type: input.type,
			code: input.code,
		},
	};
}
