import { buildModelList } from "../live/models";
import type {
	OpenAIChatCompletionRequest,
	OpenAIChatCompletionResponse,
	OpenAIModelEntry,
	OpenAIModelListResponse,
} from "../live/openai-types";
import { type OpenWebUIOwnerContext, validateForwardedOwnerUserId } from "../openwebui/auth";
import type { OpenWebUIHeaderInput } from "../openwebui/headers";
import { parseOpenWebUIHeaders } from "../openwebui/headers";
import { ADMIN_PROJECT_MODEL_ID, ProjectLinkError, type ProjectLinkService } from "./link-service";
import type { RegisteredProject } from "./registry";

export interface ProjectAdminRouteResult {
	readonly status: number;
	readonly body: unknown;
}

export type ProjectAdminJsonResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly result: ProjectAdminRouteResult };

export type ProjectIdPathResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly result: ProjectAdminRouteResult };

export function buildProjectModelList(
	projects: readonly RegisteredProject[],
	includeProjectAdmin: boolean,
): OpenAIModelListResponse {
	const projectModels = buildModelList(projects).data;
	if (!includeProjectAdmin) return { object: "list", data: projectModels };
	return { object: "list", data: [adminProjectModelEntry(), ...projectModels] };
}

export async function parseProjectAdminJsonRequest(request: Request): Promise<ProjectAdminJsonResult> {
	try {
		return { ok: true, value: await request.json() };
	} catch {
		return { ok: false, result: errorResult("Request body must be valid JSON.", "invalid_json", 400) };
	}
}

export function isProjectUnlinkPath(pathname: string): boolean {
	return pathname.startsWith("/admin/projects/") && pathname.endsWith("/unlink");
}

export function projectIdFromUnlinkPath(pathname: string): ProjectIdPathResult {
	try {
		return { ok: true, value: decodeURIComponent(pathname.slice("/admin/projects/".length, -"/unlink".length)) };
	} catch {
		return { ok: false, result: errorResult("Project id path segment is malformed.", "invalid_project_id", 400) };
	}
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
		return { status: 200, body: chatResponse("") };
	}
	const command = latestUserText(request);
	if (command === undefined) return errorResult("A project command is required.", "invalid_project_command", 400);
	try {
		return {
			status: 200,
			body: chatResponse(await executeProjectCommand(service, command)),
		};
	} catch (error) {
		if (error instanceof ProjectLinkError) return projectLinkErrorResult(error);
		return infrastructureErrorResult(error, "project_command_failed");
	}
}

function parseProjectLinkBody(body: unknown):
	| {
			readonly ok: true;
			readonly value: {
				readonly cwd: string;
				readonly name?: string;
				readonly sessionRoot?: string;
			};
	  }
	| { readonly ok: false; readonly message: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, message: "Request body must be an object." };
	}
	const record = body as Record<string, unknown>;
	if (typeof record.cwd !== "string" || record.cwd.trim().length === 0) {
		return { ok: false, message: "cwd must be a non-empty string." };
	}
	return {
		ok: true,
		value: {
			cwd: record.cwd,
			...optionalStringField(record, "name"),
			...optionalStringField(record, "sessionRoot"),
		},
	};
}

function optionalStringField<T extends string>(
	record: Record<string, unknown>,
	key: T,
): { readonly [K in T]?: string } {
	const value = record[key];
	if (value === undefined) return {};
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProjectLinkError(`${key} must be a non-empty string when provided.`, "invalid_project_link");
	}
	return { [key]: value } as { readonly [K in T]?: string };
}

async function executeProjectCommand(service: ProjectLinkService, command: string): Promise<string> {
	if (command === "/gjc project list") {
		await service.reconcileOpenWebUIFolderLinks();
		const projects = service.listProjects();
		if (projects.length === 0) return "No GJC projects are linked.";
		return projects.map(project => `${project.status}: ${project.modelId} ${project.cwd}`).join("\n");
	}
	const linkPrefix = "/gjc project link ";
	if (command.startsWith(linkPrefix)) {
		const cwd = command.slice(linkPrefix.length).trim();
		const result = await service.linkProject({ cwd });
		return `Linked ${result.project.modelId}. Imported ${result.sync.imported.length} session(s).`;
	}
	const unlinkPrefix = "/gjc project unlink ";
	if (command.startsWith(unlinkPrefix)) {
		const projectId = command.slice(unlinkPrefix.length).trim();
		const result = await service.unlinkProject(projectId);
		return `Unlinked ${result.project.modelId}. Local GJC files were left untouched.`;
	}
	throw new ProjectLinkError(
		"Supported commands: /gjc project list, /gjc project link <path>, /gjc project unlink <id>.",
		"invalid_project_command",
	);
}

function latestUserText(request: OpenAIChatCompletionRequest): string | undefined {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("")
				.trim();
		}
	}
	return undefined;
}

function chatResponse(content: string): OpenAIChatCompletionResponse {
	return {
		id: `chatcmpl-${Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: ADMIN_PROJECT_MODEL_ID,
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
	};
}

function adminProjectModelEntry(): OpenAIModelEntry {
	return {
		id: ADMIN_PROJECT_MODEL_ID,
		object: "model",
		created: 1783468800,
		owned_by: "gjc",
	};
}

function projectLinkErrorResult(error: ProjectLinkError): ProjectAdminRouteResult {
	return errorResult(error.message, error.code, error.code === "project_not_found" ? 404 : 400);
}

function infrastructureErrorResult(error: unknown, code: string): ProjectAdminRouteResult {
	const message = error instanceof Error ? error.message : "Project link operation failed.";
	return {
		status: 503,
		body: { error: { message, type: "server_error", code } },
	};
}

function errorResult(message: string, code: string, status: number): ProjectAdminRouteResult {
	return {
		status,
		body: { error: { message, type: "invalid_request_error", code } },
	};
}
