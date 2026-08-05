import type { SessionMappingScope } from "../gjc/session-mapping-store";
import type { SessionCloseIngress, SessionMapping } from "../gjc/session-router";
import type { OpenWebUIOwnerContext, OpenWebUIPrincipal } from "../openwebui/auth";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import {
	handleProjectAdminChatCompletion,
	isProjectAdminChatCompletionRequest,
	type ProjectAdminFailureSink,
} from "../projects/admin-routes";
import type { ProjectLinkService, SessionCloseResult } from "../projects/link-service";
import type { RegisteredProject } from "../projects/registry";
import type { UserWorkspaceRegistry } from "../security/user-workspace";
import type { WorkspaceCleanupService } from "../security/workspace-cleanup";
import type { WorkspaceLeaseManager } from "../security/workspace-lease";
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
import { ModelSelectionError } from "./model-selection-errors";
import { handleOpenAIModelsRequest } from "./openai-models-route";
import {
	asyncIterableBody,
	jsonResponse,
	modelSelectionErrorResponse,
	sanitizeRunnerError,
} from "./openai-response-utils";

export { asyncIterableBody, jsonResponse } from "./openai-response-utils";

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
	readonly workspaceRegistry?: Pick<UserWorkspaceRegistry, "open">;
	readonly workspaceLeaseManager?: Pick<WorkspaceLeaseManager, "acquire">;
	readonly workspaceLeaseDurationMs?: number;
	readonly workspaceLeaseHeartbeatMs?: number;
	readonly mappings?: {
		readonly getScoped: (scope: SessionMappingScope) => SessionMapping | undefined;
	};
	readonly closeSession?: ChatSessionCloser;
	readonly projectAdminFailureSink?: ProjectAdminFailureSink;
	readonly workspaceCleanupService?: Pick<WorkspaceCleanupService, "preview" | "cleanup">;
}

export { chatIdFromClosePath, handleOpenAIChatCloseRequest } from "./openai-close-route";
export { handleOpenAIModelsRequest };

export async function handleOpenAIChatCompletionsRequest(
	request: Request,
	routes: AdapterRouteDependencies,
	principal?: OpenWebUIPrincipal,
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
	if (principal === undefined) {
		return jsonResponse(
			{
				error: {
					message: "A non-empty OpenWebUI user identity is required.",
					type: "authentication_error",
					code: "missing-forwarded-user",
				},
			},
			{ status: 401 },
		);
	}
	if (routes.projectLinkService !== undefined && isProjectAdminChatCompletionRequest(parsed.request)) {
		if (principal.role !== "admin" || principal.userId !== routes.owner.ownerUserId)
			return jsonResponse(
				{
					error: {
						message: "OpenWebUI administrator privileges are required.",
						type: "authorization_error",
						code: "admin_required",
					},
				},
				{ status: 403 },
			);
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
			workspaceRegistry: routes.workspaceRegistry,
			workspaceLeaseManager: routes.workspaceLeaseManager,
			workspaceLeaseDurationMs: routes.workspaceLeaseDurationMs,
			workspaceLeaseHeartbeatMs: routes.workspaceLeaseHeartbeatMs,
			principal,
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
		return new Response(asyncIterableBody(result.stream), {
			status: result.status,
			headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
		});
	}
	return jsonResponse(result.body, { status: result.status });
}
async function resolveProjects(provider: ProjectProvider): Promise<readonly RegisteredProject[]> {
	return typeof provider === "function" ? await provider() : provider;
}
