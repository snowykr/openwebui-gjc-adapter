import { closeIngressId, type SessionCloseIngress, type SessionMapping } from "../gjc/session-router";
import type { OpenWebUIOwnerContext } from "../openwebui/auth";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import {
	handleProjectAdminChatCompletion,
	isProjectAdminChatCompletionRequest,
	type ProjectAdminFailureSink,
} from "../projects/admin-routes";
import type { ProjectLinkService, SessionCloseResult } from "../projects/link-service";
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

export type ChatSessionCloser = (mapping: SessionMapping, ingress: SessionCloseIngress) => Promise<SessionCloseResult>;

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
	readonly mappings?: { get(chatId: string): SessionMapping | undefined };
	readonly closeSession?: ChatSessionCloser;
	readonly projectAdminFailureSink?: ProjectAdminFailureSink;
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

export async function handleOpenAIChatCloseRequest(
	chatId: string,
	operationId: string,
	routes: AdapterRouteDependencies,
): Promise<Response> {
	const mapping = routes.mappings?.get(chatId);
	if (mapping === undefined) {
		return jsonResponse(
			{
				error: {
					message: "No GJC session is mapped to this chat.",
					type: "invalid_request_error",
					code: "chat_session_not_found",
				},
				operationId,
			},
			{ status: 404 },
		);
	}
	if (routes.closeSession === undefined) {
		return jsonResponse(
			{ status: "unavailable", message: "GJC session close is unavailable.", operationId },
			{ status: 503 },
		);
	}
	try {
		const ingressId = closeIngressId(operationId, mapping);
		const result = await routes.closeSession(mapping, { ingressId, ingressHash: ingressId });
		return jsonResponse(
			{ ...result, operationId },
			{
				status: result.status === "closed" ? 200 : result.status === "unavailable" ? 503 : 202,
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "GJC session close acknowledgement was not received.";
		if (message.includes("conflicts")) {
			return jsonResponse(
				{ error: { message, type: "invalid_request_error", code: "chat_close_conflict" }, operationId },
				{ status: 409 },
			);
		}
		return jsonResponse({ status: "uncertain", message, operationId }, { status: 202 });
	}
}

export function chatIdFromClosePath(pathname: string): string | undefined {
	const match = /^\/v1\/chats\/([^/]+)\/close$/.exec(pathname);
	if (match === null) return undefined;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
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
			routes.projectAdminFailureSink,
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
		console.error("GJC live runner failed:", sanitizeRunnerError(error));
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
function sanitizeRunnerError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
}

async function resolveProjects(provider: ProjectProvider): Promise<readonly RegisteredProject[]> {
	return typeof provider === "function" ? await provider() : provider;
}
