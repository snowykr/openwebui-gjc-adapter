import { type OpenWebUIOwnerContext, validateForwardedOwnerUserId } from "../openwebui/auth";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import type { OpenWebUIHeaderInput } from "../openwebui/headers";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import type { RegisteredProject } from "../projects/registry";
import { findProjectByModelId } from "./models";
import type {
	OpenAIChatCompletionChunk,
	OpenAIChatCompletionRequest,
	OpenAIChatCompletionResponse,
	OpenAIChatContentPart,
	OpenAIChatMessage,
} from "./openai-types";

export interface LiveGatewayRunnerInput {
	readonly project: RegisteredProject;
	readonly prompt: string;
	readonly chatId: string;
	readonly messageId: string;
	readonly userMessageId: string;
	readonly userMessageParentId: string | null;
	readonly continued: boolean;
}

export type LiveGatewayRunnerResult =
	| { readonly content: string; readonly chunks?: undefined; readonly events?: readonly OpenWebUIMessageEvent[] }
	| {
			readonly content?: undefined;
			readonly chunks: AsyncIterable<string> | Iterable<string>;
			readonly events?: readonly OpenWebUIMessageEvent[];
	  };

export interface LiveGatewayRunner {
	run(input: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> | LiveGatewayRunnerResult;
}

export class LiveGatewayUnavailableError extends Error {
	readonly code = "live_runner_unavailable";
}

export interface LiveGatewayEventDeliveryInput {
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
	readonly events: readonly OpenWebUIMessageEvent[];
}

export type LiveGatewayEventSink = (input: LiveGatewayEventDeliveryInput) => Promise<void> | void;

export type LiveChatCompletionsResult =
	| { readonly ok: true; readonly status: 200; readonly body: OpenAIChatCompletionResponse }
	| { readonly ok: true; readonly status: 200; readonly stream: AsyncIterable<string> }
	| { readonly ok: false; readonly status: 400 | 401 | 404 | 503; readonly body: OpenAIErrorResponse };

export interface OpenAIErrorResponse {
	readonly error: {
		readonly message: string;
		readonly type: string;
		readonly code: string;
	};
}

export interface HandleChatCompletionsInput {
	readonly request: OpenAIChatCompletionRequest;
	readonly headers: OpenWebUIHeaderInput;
	readonly projects: readonly RegisteredProject[];
	readonly owner: OpenWebUIOwnerContext;
	readonly runner: LiveGatewayRunner;
	readonly now?: Date;
	readonly idFactory?: () => string;
	readonly outbox?: unknown;
	readonly eventSink?: LiveGatewayEventSink;
}

export async function handleChatCompletions(input: HandleChatCompletionsInput): Promise<LiveChatCompletionsResult> {
	const headers = parseOpenWebUIHeaders(input.headers);
	if (!headers.ok) {
		return errorResult(
			400,
			"invalid_request_error",
			"invalid_openwebui_headers",
			headers.errors.map(error => error.message).join("; "),
		);
	}

	const owner = validateForwardedOwnerUserId(input.owner, headers.userId);
	if (!owner.ok) {
		return errorResult(
			401,
			"authentication_error",
			owner.reason,
			"Forwarded OpenWebUI owner does not match adapter owner.",
		);
	}

	const project = findProjectByModelId(input.projects, input.request.model);
	if (project === null) {
		return errorResult(404, "invalid_request_error", "model_not_found", `Unknown GJC model: ${input.request.model}`);
	}

	const created = toUnixSeconds(input.now ?? new Date());
	const id = input.idFactory?.() ?? `chatcmpl-${created}`;
	if (headers.isBackgroundTask) {
		return {
			ok: true,
			status: 200,
			body: buildCompletion({
				id,
				created,
				model: input.request.model,
				content: "",
				metadata: { task: headers.task, noop: true },
			}),
		};
	}

	const prompt = latestUserText(input.request.messages);
	if (prompt === null) {
		return errorResult(
			400,
			"invalid_request_error",
			"missing_user_message",
			"A chat completion requires a user message with text content.",
		);
	}

	let runnerResult: LiveGatewayRunnerResult;
	try {
		runnerResult = await input.runner.run({
			project,
			prompt,
			chatId: headers.chatId,
			messageId: headers.messageId,
			userMessageId: headers.userMessageId,
			userMessageParentId: headers.userMessageParentId,
			continued: headers.userMessageParentId !== null,
		});
	} catch (error) {
		if (error instanceof LiveGatewayUnavailableError) {
			return errorResult(503, "server_error", error.code, error.message);
		}
		throw error;
	}

	await deliverRunnerEvents({
		eventSink: input.eventSink,
		events: runnerResult.events,
		chatId: headers.chatId,
		messageId: headers.messageId,
		ownerUserId: input.owner.ownerUserId,
		projectId: project.id,
	});

	if (input.request.stream === true) {
		const chunks = runnerResult.chunks ?? [runnerResult.content];
		return {
			ok: true,
			status: 200,
			stream: encodeChatCompletionSse({ id, created, model: input.request.model, chunks }),
		};
	}

	if (runnerResult.content !== undefined) {
		return {
			ok: true,
			status: 200,
			body: buildCompletion({ id, created, model: input.request.model, content: runnerResult.content }),
		};
	}

	let content = "";
	for await (const chunk of runnerResult.chunks) {
		content += chunk;
	}
	return {
		ok: true,
		status: 200,
		body: buildCompletion({ id, created, model: input.request.model, content }),
	};
}

export async function* encodeChatCompletionSse(input: {
	readonly id: string;
	readonly created: number;
	readonly model: string;
	readonly chunks: AsyncIterable<string> | Iterable<string>;
}): AsyncIterable<string> {
	for await (const content of input.chunks) {
		const chunk: OpenAIChatCompletionChunk = {
			id: input.id,
			object: "chat.completion.chunk",
			created: input.created,
			model: input.model,
			choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
		};
		yield `data: ${JSON.stringify(chunk)}\n\n`;
	}
	yield "data: [DONE]\n\n";
}

function latestUserText(messages: readonly OpenAIChatMessage[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		return messageContentText(message.content);
	}
	return null;
}

function messageContentText(content: OpenAIChatMessage["content"]): string | null {
	if (typeof content === "string") return content;
	if (content === null) return null;
	const text = content.map(partText).join("").trim();
	return text.length > 0 ? text : null;
}

function partText(part: OpenAIChatContentPart): string {
	return part.text;
}

function buildCompletion(input: {
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

function errorResult(
	status: 400 | 401 | 404 | 503,
	type: string,
	code: string,
	message: string,
): LiveChatCompletionsResult {
	return {
		ok: false,
		status,
		body: {
			error: { message, type, code },
		},
	};
}

async function deliverRunnerEvents(input: {
	readonly eventSink?: LiveGatewayEventSink;
	readonly events?: readonly OpenWebUIMessageEvent[];
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
}): Promise<void> {
	if (input.eventSink === undefined || input.events === undefined || input.events.length === 0) return;
	await input.eventSink({
		chatId: input.chatId,
		messageId: input.messageId,
		ownerUserId: input.ownerUserId,
		projectId: input.projectId,
		events: input.events,
	});
}

function toUnixSeconds(date: Date): number {
	return Math.floor(date.getTime() / 1000);
}
