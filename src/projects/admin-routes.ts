import type { ModelReaderFactory } from "../live/model-reader";
import { ModelSelectionError, modelSelectionError } from "../live/model-selection-errors";
import { createModelSelectionPolicy } from "../live/model-selection-policy";
import { buildModelList, classifyGjcModelId, formatCanonicalModelId } from "../live/models";
import type {
	OpenAIChatCompletionRequest,
	OpenAIChatCompletionResponse,
	OpenAIModelListResponse,
} from "../live/openai-types";
import { type OpenWebUIOwnerContext, validateForwardedOwnerUserId } from "../openwebui/auth";
import type { OpenWebUIHeaderInput } from "../openwebui/headers";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import { executeProjectCommand, latestUserText } from "./admin-chat-command";
import {
	isProjectUnlinkPath,
	parseProjectAdminJsonRequest,
	parseProjectLinkBody,
	projectIdFromUnlinkPath,
	type ProjectAdminJsonResult,
	type ProjectAdminRouteResult,
	type ProjectIdPathResult,
} from "./admin-request-parser";
import { ProjectLinkError, type ProjectLinkService } from "./link-service";
import type { RegisteredProject } from "./registry";

export type { ProjectAdminJsonResult, ProjectAdminRouteResult, ProjectIdPathResult };
export { isProjectUnlinkPath, parseProjectAdminJsonRequest, projectIdFromUnlinkPath };

export type ProjectAdminFailureSink = (error: unknown) => void;

export function buildProjectModelList(
	projects: readonly RegisteredProject[],
	includeProjectAdmin: boolean,
): OpenAIModelListResponse {
	void projects;
	void includeProjectAdmin;
	return buildModelList();
}

export async function handleProjectLinkRequest(
	service: ProjectLinkService,
	body: unknown,
): Promise<ProjectAdminRouteResult> {
	try {
		const input = parseProjectLinkBody(body);
		if (!input.ok) return errorResult(input.message, "invalid_project_link", 400);
		const result = await service.linkProject(input.value);
		return { status: 200, body: result };
	} catch (error) {
		if (error instanceof ProjectLinkError) return projectLinkErrorResult(error);
		return infrastructureErrorResult(error, "project_link_failed");
	}
}

export async function handleProjectUnlinkRequest(
	service: ProjectLinkService,
	projectId: string,
): Promise<ProjectAdminRouteResult> {
	try {
		return { status: 200, body: await service.unlinkProject(projectId) };
	} catch (error) {
		if (error instanceof ProjectLinkError) return projectLinkErrorResult(error);
		return infrastructureErrorResult(error, "project_unlink_failed");
	}
}

export async function handleProjectListRequest(service: ProjectLinkService): Promise<ProjectAdminRouteResult> {
	await service.reconcileOpenWebUIFolderLinks();
	return { status: 200, body: { projects: service.listProjects() } };
}

export async function handleProjectAdminChatCompletion(
	service: ProjectLinkService,
	request: OpenAIChatCompletionRequest,
	headers: OpenWebUIHeaderInput,
	ownerContext: OpenWebUIOwnerContext,
	modelReaderFactory?: ModelReaderFactory,
	failureSink?: ProjectAdminFailureSink,
): Promise<ProjectAdminRouteResult> {
	const parsedHeaders = parseOpenWebUIHeaders(headers);
	if (!parsedHeaders.ok) {
		return errorResult(parsedHeaders.errors.map(error => error.message).join("; "), "invalid_openwebui_headers", 400);
	}
	const owner = validateForwardedOwnerUserId(ownerContext, parsedHeaders.userId);
	if (!owner.ok) {
		return errorResult("Forwarded OpenWebUI owner does not match adapter owner.", owner.reason, 401);
	}
	if (parsedHeaders.isBackgroundTask) {
		try {
			return await canonicalAdminResponse("", request.model, modelReaderFactory);
		} catch (error) {
			if (error instanceof ModelSelectionError) return modelSelectionErrorResult(error);
			failureSink?.(error);
			return infrastructureErrorResult(error, "project_command_failed");
		}
	}
	const command = latestUserText(request);
	if (command === undefined) return errorResult("A project command is required.", "invalid_project_command", 400);
	try {
		const content = await executeProjectCommand(service, command);
		return await canonicalAdminResponse(content, request.model, modelReaderFactory);
	} catch (error) {
		if (error instanceof ProjectLinkError) return projectLinkErrorResult(error);
		if (error instanceof ModelSelectionError) return modelSelectionErrorResult(error);
		failureSink?.(error);
		return infrastructureErrorResult(error, "project_command_failed");
	}
}

export function isProjectAdminChatCompletionRequest(request: OpenAIChatCompletionRequest): boolean {
	const command = latestUserText(request);
	const model = classifyGjcModelId(request.model);
	return (model.kind === "alias" || model.kind === "canonical") && (command?.startsWith("/gjc project ") ?? false);
}

async function canonicalAdminResponse(
	content: string,
	requestedModelId: string,
	modelReaderFactory?: ModelReaderFactory,
): Promise<ProjectAdminRouteResult> {
	if (modelReaderFactory === undefined) {
		throw modelSelectionError(
			classifyGjcModelId(requestedModelId).kind === "canonical"
				? "model_selection_not_available"
				: "model_selection_default_read_failed",
		);
	}
	const model = formatCanonicalModelId(await createModelSelectionPolicy(modelReaderFactory).resolve(requestedModelId));
	return { status: 200, body: chatResponse(content, model) };
}

function chatResponse(content: string, model: string): OpenAIChatCompletionResponse {
	return {
		id: `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
	};
}

function modelSelectionErrorResult(error: ModelSelectionError): ProjectAdminRouteResult {
	return { status: error.status, body: { error: { message: error.message, type: error.type, code: error.code } } };
}

function projectLinkErrorResult(error: ProjectLinkError): ProjectAdminRouteResult {
	return errorResult(error.message, error.code, error.code === "project_not_found" ? 404 : 400);
}

function infrastructureErrorResult(error: unknown, code: string): ProjectAdminRouteResult {
	void error;
	return {
		status: 503,
		body: { error: { message: "Project administration operation failed.", type: "server_error", code } },
	};
}

function errorResult(message: string, code: string, status: number): ProjectAdminRouteResult {
	return {
		status,
		body: { error: { message, type: "invalid_request_error", code } },
	};
}
