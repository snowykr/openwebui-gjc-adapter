import { validateForwardedOwnerUserId } from "../openwebui/auth";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import {
	type HandleChatCompletionsInput,
	type LiveChatCompletionsResult,
	type LiveGatewayRunnerResult,
	LiveGatewayUnavailableError,
	WorkflowGateReplyError,
	OpenWebUIControlError,
} from "./chat-completions-types";
import { latestUserText } from "./chat-content";
import { deliverChatCompletion } from "./chat-completion-delivery";
import { controlFromMetadata } from "./chat-control-metadata";
import { deliverRunnerEvents } from "./chat-delivery";
import { buildCompletion, buildOpenAIErrorResponse } from "./chat-response-format";
import { appendResolvedFileContexts } from "./file-contexts";
import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";
import { createModelSelectionPolicy } from "./model-selection-policy";
import { classifyGjcModelId, formatCanonicalModelId } from "./models";
import { resolveLiveProjectContext } from "./project-context";

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
	const classifiedModel = classifyGjcModelId(input.request.model);
	if (classifiedModel.kind === "malformed")
		return selectionErrorResult(modelSelectionError("model_selection_invalid_id"));
	if (classifiedModel.kind === "foreign")
		return selectionErrorResult(modelSelectionError("model_not_found", input.request.model));

	if (headers.isBackgroundTask) {
		try {
			if (input.modelReaderFactory === undefined) {
				throw modelSelectionError(
					classifiedModel.kind === "canonical"
						? "model_selection_not_available"
						: "model_selection_default_read_failed",
				);
			}
			const selection = await createModelSelectionPolicy(input.modelReaderFactory).resolve(input.request.model);
			const model = formatCanonicalModelId(selection);
			return {
				ok: true,
				status: 200,
				body: buildCompletion({ id, created, model, content: "", metadata: { task: headers.task, noop: true } }),
			};
		} catch (error) {
			if (error instanceof ModelSelectionError) return selectionErrorResult(error);
			return selectionErrorResult(
				modelSelectionError(
					classifiedModel.kind === "canonical"
						? "model_selection_not_available"
						: "model_selection_default_read_failed",
				),
			);
		}
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
	const projects = input.projectProvider === undefined ? input.projects : await input.projectProvider();
	const projectContext = await resolveLiveProjectContext({
		projects,
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
			requestedModelId: input.request.model,
			ownerUserId: input.owner.ownerUserId,
			...(input.request.metadata === undefined ? {} : { messageMetadata: input.request.metadata }),
			...(controlFromMetadata(input.request.metadata) === undefined
				? {}
				: { control: controlFromMetadata(input.request.metadata) }),
		});
	} catch (error) {
		if (error instanceof LiveGatewayUnavailableError) {
			return errorResult(503, "server_error", error.code, error.message);
		}
		if (error instanceof OpenWebUIControlError) {
			return errorResult(400, "invalid_request_error", error.code, error.message);
		}
		if (error instanceof WorkflowGateReplyError) {
			return errorResult(400, "invalid_request_error", error.code, error.message);
		}
		if (error instanceof ModelSelectionError) return selectionErrorResult(error);
		throw error;
	}
	const resultModel = runnerResult.model;
	if (resultModel === undefined || classifyGjcModelId(resultModel).kind !== "canonical") {
		return errorResult(
			503,
			"server_error",
			"live_runner_error",
			"GJC live runner returned an invalid model selection.",
		);
	}

	await deliverRunnerEvents({
		eventSink: input.eventSink,
		events: runnerResult.events,
		chatId: headers.chatId,
		messageId: headers.messageId,
		ownerUserId: input.owner.ownerUserId,
		projectId: project.id,
	});

	return deliverChatCompletion({
		stream: input.request.stream === true,
		runnerResult,
		id,
		created,
		model: resultModel,
		messageSink: input.messageSink,
		chatId: headers.chatId,
		messageId: headers.messageId,
		ownerUserId: input.owner.ownerUserId,
		projectId: project.id,
	});
}

function selectionErrorResult(error: ModelSelectionError): LiveChatCompletionsResult {
	return errorResult(error.status, error.type, error.code, error.message);
}

function errorResult(
	status: 400 | 401 | 404 | 409 | 503,
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
