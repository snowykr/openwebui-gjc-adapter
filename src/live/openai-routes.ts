import type { OpenWebUIOwnerContext } from "../openwebui/auth";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import { handleProjectAdminChatCompletion, isProjectAdminChatCompletionRequest } from "../projects/admin-routes";
import type { ProjectLinkService } from "../projects/link-service";
import type { RegisteredProject } from "../projects/registry";
import {
	handleChatCompletions,
	type LiveChatCompletionsResult,
	type LiveGatewayEventSink,
	type LiveGatewayMessageSink,
	type LiveGatewayRunner,
} from "./chat-completions";
import { parseChatCompletionRequest } from "./chat-request-parser";
import type { LiveGatewayFileContextResolver } from "./file-contexts";
import type { ModelReaderFactory } from "./model-reader";
import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";
import { createModelSelectionPolicy } from "./model-selection-policy";

export type ProjectProvider =
	| readonly RegisteredProject[]
	| (() => readonly RegisteredProject[] | Promise<readonly RegisteredProject[]>);

export interface AdapterRouteDependencies {
	readonly projects: readonly RegisteredProject[];
	readonly projectProvider?: ProjectProvider;
	readonly owner: OpenWebUIOwnerContext;
	readonly runner: LiveGatewayRunner;
	readonly projectLinkService?: ProjectLinkService;
	readonly projectContextRepository?: OpenWebUIProjectionRepository;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly fileContextResolver?: LiveGatewayFileContextResolver;
	readonly adapterApiToken?: string;
	readonly requireAdapterApiToken?: boolean;
	readonly modelReaderFactory?: ModelReaderFactory;
	readonly neutralWorkspace?: string;
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers,
		},
	});
}

export async function handleOpenAIModelsRequest(routes: AdapterRouteDependencies): Promise<Response> {
	try {
		if (routes.modelReaderFactory === undefined) throw new TypeError("GJC model reader is unavailable");
		return jsonResponse(await createModelSelectionPolicy(routes.modelReaderFactory).listModels());
	} catch (error) {
		return modelSelectionErrorResponse(error);
	}
}

export async function handleOpenAIChatCompletionsRequest(
	request: Request,
	routes: AdapterRouteDependencies,
): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonResponse(
			{
				error: {
					message: "Request body must be valid JSON.",
					type: "invalid_request_error",
					code: "invalid_json",
				},
			},
			{ status: 400 },
		);
	}
	const parsed = parseChatCompletionRequest(body);
	if (!parsed.ok) {
		return jsonResponse(
			{
				error: {
					message: parsed.message,
					type: "invalid_request_error",
					code: "invalid_request_body",
				},
			},
			{ status: 400 },
		);
	}
	if (routes.projectLinkService !== undefined && isProjectAdminChatCompletionRequest(parsed.request)) {
		const result = await handleProjectAdminChatCompletion(
			routes.projectLinkService,
			parsed.request,
			request.headers,
			routes.owner,
			routes.modelReaderFactory,
		);
		return jsonResponse(result.body, { status: result.status });
	}
	const projectProvider = routes.projectProvider;
	let result: LiveChatCompletionsResult;
	try {
		result = await handleChatCompletions({
			request: parsed.request,
			headers: request.headers,
			projects: routes.projects,
			...(projectProvider === undefined ? {} : { projectProvider: () => resolveProjects(projectProvider) }),
			owner: routes.owner,
			runner: routes.runner,
			eventSink: routes.eventSink,
			messageSink: routes.messageSink,
			fileContextResolver: routes.fileContextResolver,
			projectContextRepository: routes.projectContextRepository,
			neutralWorkspace: routes.neutralWorkspace,
			modelReaderFactory: routes.modelReaderFactory,
		});
	} catch (error) {
		if (error instanceof ModelSelectionError) return modelSelectionErrorResponse(error);
		return jsonResponse(
			{
				error: {
					message: "GJC live runner failed.",
					type: "server_error",
					code: "live_runner_error",
				},
			},
			{ status: 503 },
		);
	}
	if (!result.ok) return jsonResponse(result.body, { status: result.status });
	if ("stream" in result) {
		return new Response(result.stream, {
			status: result.status,
			headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
		});
	}
	return jsonResponse(result.body, { status: result.status });
}

function modelSelectionErrorResponse(error: unknown): Response {
	const selectionError =
		error instanceof ModelSelectionError ? error : modelSelectionError("model_catalog_unavailable");
	return jsonResponse(
		{ error: { message: selectionError.message, type: selectionError.type, code: selectionError.code } },
		{ status: selectionError.status },
	);
}

async function resolveProjects(provider: ProjectProvider): Promise<readonly RegisteredProject[]> {
	return typeof provider === "function" ? await provider() : provider;
}
