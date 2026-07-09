import { type AdapterHealthCheck, buildHealthReport } from "./health";
import {
	handleChatCompletions,
	type LiveChatCompletionsResult,
	type LiveGatewayEventSink,
	type LiveGatewayMessageSink,
	type LiveGatewayRunner,
} from "./live/chat-completions";
import { parseChatCompletionRequest } from "./live/chat-request-parser";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import type { OpenWebUIOwnerContext } from "./openwebui/auth";
import {
	buildProjectModelList,
	handleProjectAdminChatCompletion,
	handleProjectLinkRequest,
	handleProjectListRequest,
	handleProjectUnlinkRequest,
	isProjectUnlinkPath,
	parseProjectAdminJsonRequest,
	projectIdFromUnlinkPath,
} from "./projects/admin-routes";
import { ADMIN_PROJECT_MODEL_ID, type ProjectLinkService } from "./projects/link-service";
import type { RegisteredProject } from "./projects/registry";
export interface AdapterServerOptions {
	host: string;
	port: number;
	checks?: readonly AdapterHealthCheck[];
	routes?: AdapterRouteDependencies;
}

export interface AdapterRouteDependencies {
	readonly projects: readonly RegisteredProject[];
	readonly projectProvider?: ProjectProvider;
	readonly owner: OpenWebUIOwnerContext;
	readonly runner: LiveGatewayRunner;
	readonly projectLinkService?: ProjectLinkService;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly fileContextResolver?: LiveGatewayFileContextResolver;
	readonly adapterApiToken?: string;
	readonly requireAdapterApiToken?: boolean;
}

type AdapterRequestHandlerOptions = {
	readonly checks?: readonly AdapterHealthCheck[];
	readonly routes?: AdapterRouteDependencies;
};

type ProjectProvider =
	| readonly RegisteredProject[]
	| (() => readonly RegisteredProject[] | Promise<readonly RegisteredProject[]>);

export interface AdapterServerHandle {
	url: string;
	stop(): Promise<void>;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers,
		},
	});
}

export function createAdapterRequestHandler(
	options: readonly AdapterHealthCheck[] | AdapterRequestHandlerOptions = [],
): (request: Request) => Response | Promise<Response> {
	const routeOptions: AdapterRequestHandlerOptions | undefined = isHealthCheckList(options) ? undefined : options;
	const checks = routeOptions?.checks ?? (isHealthCheckList(options) ? options : []);
	const routes = routeOptions?.routes;

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/healthz") {
			const report = buildHealthReport(checks);
			return jsonResponse(report, { status: report.status === "ok" ? 200 : 503 });
		}
		if (routes !== undefined && request.method === "GET" && url.pathname === "/v1/models") {
			const authError = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
			if (authError !== undefined) return authError;
			return jsonResponse(
				buildProjectModelList(await resolveRouteProjects(routes), routes.projectLinkService !== undefined),
			);
		}
		if (routes?.projectLinkService !== undefined && request.method === "GET" && url.pathname === "/admin/projects") {
			const authError = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
			if (authError !== undefined) return authError;
			const result = await handleProjectListRequest(routes.projectLinkService);
			return jsonResponse(result.body, { status: result.status });
		}
		if (
			routes?.projectLinkService !== undefined &&
			request.method === "POST" &&
			url.pathname === "/admin/projects/link"
		) {
			const authError = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
			if (authError !== undefined) return authError;
			const body = await parseProjectAdminJsonRequest(request);
			if (!body.ok) return jsonResponse(body.result.body, { status: body.result.status });
			const result = await handleProjectLinkRequest(routes.projectLinkService, body.value);
			return jsonResponse(result.body, { status: result.status });
		}
		if (routes?.projectLinkService !== undefined && request.method === "POST" && isProjectUnlinkPath(url.pathname)) {
			const authError = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
			if (authError !== undefined) return authError;
			const projectId = projectIdFromUnlinkPath(url.pathname);
			if (!projectId.ok) return jsonResponse(projectId.result.body, { status: projectId.result.status });
			const result = await handleProjectUnlinkRequest(routes.projectLinkService, projectId.value);
			return jsonResponse(result.body, { status: result.status });
		}
		if (routes !== undefined && request.method === "POST" && url.pathname === "/v1/chat/completions") {
			const authError = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
			if (authError !== undefined) return authError;
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
			if (routes.projectLinkService !== undefined && parsed.request.model === ADMIN_PROJECT_MODEL_ID) {
				const result = await handleProjectAdminChatCompletion(
					routes.projectLinkService,
					parsed.request,
					request.headers,
					routes.owner,
				);
				return jsonResponse(result.body, { status: result.status });
			}
			let result: LiveChatCompletionsResult;
			try {
				result = await handleChatCompletions({
					request: parsed.request,
					headers: request.headers,
					projects: await resolveRouteProjects(routes),
					owner: routes.owner,
					runner: routes.runner,
					eventSink: routes.eventSink,
					messageSink: routes.messageSink,
					fileContextResolver: routes.fileContextResolver,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "GJC live runner failed.";
				return jsonResponse(
					{
						error: {
							message,
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
		return jsonResponse({ error: "not_found" }, { status: 404 });
	};
}

async function resolveProjects(provider: ProjectProvider): Promise<readonly RegisteredProject[]> {
	return typeof provider === "function" ? await provider() : provider;
}

async function resolveRouteProjects(routes: AdapterRouteDependencies): Promise<readonly RegisteredProject[]> {
	return routes.projectProvider === undefined ? routes.projects : await resolveProjects(routes.projectProvider);
}

function authenticateAdapterRequest(
	request: Request,
	adapterApiToken: string | undefined,
	required = false,
): Response | undefined {
	if (adapterApiToken === undefined && required) {
		return jsonResponse(
			{
				error: {
					message: "Adapter API token is not configured.",
					type: "server_error",
					code: "adapter_api_token_unconfigured",
				},
			},
			{ status: 503 },
		);
	}
	if (adapterApiToken === undefined) return undefined;
	const expected = `Bearer ${adapterApiToken}`;
	if (request.headers.get("authorization") === expected) return undefined;
	return jsonResponse(
		{
			error: {
				message: "Adapter API token is missing or invalid.",
				type: "authentication_error",
				code: "invalid_api_key",
			},
		},
		{ status: 401 },
	);
}

function isHealthCheckList(
	options: readonly AdapterHealthCheck[] | AdapterRequestHandlerOptions,
): options is readonly AdapterHealthCheck[] {
	return Array.isArray(options);
}

export function startAdapterServer(options: AdapterServerOptions): AdapterServerHandle {
	const server = Bun.serve({
		hostname: options.host,
		port: options.port,
		fetch: createAdapterRequestHandler({ checks: options.checks, routes: options.routes }),
	});
	return {
		url: server.url.toString(),
		async stop(): Promise<void> {
			await server.stop();
		},
	};
}
