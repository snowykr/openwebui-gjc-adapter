import { type OpenWebUIOwnerContext, validateForwardedOwnerUserId } from "../openwebui/auth";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import type { OpenWebUIHeaderInput } from "../openwebui/headers";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import type { RegisteredProject } from "../projects/registry";
import { latestUserText } from "./chat-content";
import {
	deliverContentAfterChunks,
	deliverFinalAssistantContent,
	deliverRunnerEvents,
	type LiveGatewayEventSink,
	type LiveGatewayMessageSink,
} from "./chat-delivery";
import {
	buildCompletion,
	buildOpenAIErrorResponse,
	encodeChatCompletionSse,
	type OpenAIErrorResponse,
} from "./chat-response-format";
import { findProjectByModelId } from "./models";
import type { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "./openai-types";

export type { LiveGatewayEventDeliveryInput, LiveGatewayEventSink, LiveGatewayMessageSink } from "./chat-delivery";

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

export type LiveChatCompletionsResult =
	| { readonly ok: true; readonly status: 200; readonly body: OpenAIChatCompletionResponse }
	| { readonly ok: true; readonly status: 200; readonly stream: AsyncIterable<string> }
	| { readonly ok: false; readonly status: 400 | 401 | 404 | 503; readonly body: OpenAIErrorResponse };

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
	readonly messageSink?: LiveGatewayMessageSink;
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

	if (!Array.isArray(input.request.messages)) {
		return errorResult(
			400,
			"invalid_request_error",
			"invalid_request_body",
			"Request body must include a messages array.",
		);
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
			stream: encodeChatCompletionSse({
				id,
				created,
				model: input.request.model,
				chunks: deliverContentAfterChunks({
					chunks,
					messageSink: input.messageSink,
					chatId: headers.chatId,
					messageId: headers.messageId,
					ownerUserId: input.owner.ownerUserId,
					projectId: project.id,
				}),
			}),
		};
	}

	if (runnerResult.content !== undefined) {
		await deliverFinalAssistantContent({
			messageSink: input.messageSink,
			chatId: headers.chatId,
			messageId: headers.messageId,
			ownerUserId: input.owner.ownerUserId,
			projectId: project.id,
			content: runnerResult.content,
		});
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
	await deliverFinalAssistantContent({
		messageSink: input.messageSink,
		chatId: headers.chatId,
		messageId: headers.messageId,
		ownerUserId: input.owner.ownerUserId,
		projectId: project.id,
		content,
	});
	return {
		ok: true,
		status: 200,
		body: buildCompletion({ id, created, model: input.request.model, content }),
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
		body: buildOpenAIErrorResponse({ message, type, code }),
	};
}

function toUnixSeconds(date: Date): number {
	return Math.floor(date.getTime() / 1000);
}
