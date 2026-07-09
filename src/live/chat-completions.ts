import { validateForwardedOwnerUserId } from "../openwebui/auth";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import {
	type HandleChatCompletionsInput,
	type LiveChatCompletionsResult,
	type LiveGatewayRunnerResult,
	LiveGatewayUnavailableError,
	WorkflowGateReplyError,
} from "./chat-completions-types";
import { latestUserText } from "./chat-content";
import { deliverContentAfterChunks, deliverFinalAssistantContent, deliverRunnerEvents } from "./chat-delivery";
import { buildCompletion, buildOpenAIErrorResponse, encodeChatCompletionSse } from "./chat-response-format";
import { appendResolvedFileContexts } from "./file-contexts";
import { isGjcOpenWebUIModelId, resolveLiveProjectContext } from "./project-context";

export type {
	HandleChatCompletionsInput,
	LiveChatCompletionsResult,
	LiveGatewayRunner,
	LiveGatewayRunnerInput,
	LiveGatewayRunnerResult,
} from "./chat-completions-types";
export type { LiveGatewayEventDeliveryInput, LiveGatewayEventSink, LiveGatewayMessageSink } from "./chat-delivery";
export { LiveGatewayUnavailableError, WorkflowGateReplyError };

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

	const created = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const id = input.idFactory?.() ?? `chatcmpl-${created}`;
	if (!isGjcOpenWebUIModelId(input.request.model)) {
		return unknownModelResult(input.request.model);
	}

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

	const latestPrompt = latestUserText(input.request.messages, input.request.files);
	if (latestPrompt === null) {
		return errorResult(
			400,
			"invalid_request_error",
			"missing_user_message",
			"A chat completion requires a user message with text content.",
		);
	}
	const projectContext = await resolveLiveProjectContext({
		projects: input.projects,
		modelId: input.request.model,
		ownerUserId: input.owner.ownerUserId,
		chatId: headers.chatId,
		repository: input.projectContextRepository,
		neutralWorkspace: input.neutralWorkspace,
		now: input.now,
	});
	if (!projectContext.ok) {
		return errorResult(503, "server_error", projectContext.code, projectContext.message);
	}
	const project = projectContext.project;
	let prompt: string;
	try {
		prompt = await appendResolvedFileContexts({
			prompt: latestPrompt,
			messages: input.request.messages,
			files: input.request.files,
			project,
			chatId: headers.chatId,
			userMessageId: headers.userMessageId,
			resolver: input.fileContextResolver,
		});
	} catch {
		return errorResult(
			503,
			"server_error",
			"attachment_resolution_failed",
			"OpenWebUI attachment files could not be resolved.",
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
		if (error instanceof WorkflowGateReplyError) {
			return errorResult(400, "invalid_request_error", error.code, error.message);
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

function unknownModelResult(modelId: string): LiveChatCompletionsResult {
	return errorResult(404, "invalid_request_error", "model_not_found", `Unknown GJC model: ${modelId}`);
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
