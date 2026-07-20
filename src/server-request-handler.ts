import { randomUUID } from "node:crypto";
import {
	type AdapterHealthCheck,
	type AdapterReadinessOptions,
	buildHealthReport,
	buildReadinessReport,
} from "./health";
import {
	type AdapterRouteDependencies,
	chatIdFromClosePath,
	handleOpenAIChatCloseRequest,
	handleOpenAIChatCompletionsRequest,
	handleOpenAIModelsRequest,
	jsonResponse,
} from "./live/openai-routes";
import {
	handleProjectLinkRequest,
	handleProjectListRequest,
	handleProjectUnlinkRequest,
	isProjectUnlinkPath,
	parseProjectAdminJsonRequest,
	projectIdFromUnlinkPath,
} from "./projects/admin-routes";
import { type AdapterRuntimeConfig, createRuntimeReadinessReconciler } from "./server-runtime-readiness";

export type AdapterRequestHandlerOptions = {
	readonly checks?: readonly AdapterHealthCheck[];
	readonly routes?: AdapterRouteDependencies;
	readonly readiness?: AdapterReadinessOptions;
	readonly runtime?: AdapterRuntimeConfig;
};

export function createAdapterRequestHandler(
	options: readonly AdapterHealthCheck[] | AdapterRequestHandlerOptions = [],
): (request: Request) => Response | Promise<Response> {
	const routeOptions = isHealthCheckList(options) ? undefined : options;
	const checks = routeOptions?.checks ?? (isHealthCheckList(options) ? options : []);
	const routes = routeOptions?.routes;
	const runtime = routeOptions?.runtime;
	const runtimeReadiness: AdapterReadinessOptions = {
		...(runtime?.readiness ?? routeOptions?.readiness ?? { openWebUIAuthenticated: false, promptHintsSeeded: false }),
	};
	const reconcile =
		runtime === undefined ? () => Promise.resolve() : createRuntimeReadinessReconciler(runtime, runtimeReadiness);
	if (runtime !== undefined) void reconcile();
	return async request => {
		const url = new URL(request.url);
		if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
			const authError = authenticateProviderRequest(request, routes, runtime);
			if (authError !== undefined) return authError;
			if (runtime !== undefined) {
				await reconcile();
				if (!runtimeReadiness.openWebUIAuthenticated || !runtimeReadiness.promptHintsSeeded)
					return jsonResponse(
						{ error: "service_unavailable", message: "adapter runtime initialization is incomplete" },
						{ status: 503 },
					);
			}
		}
		if (request.method === "GET" && url.pathname === "/healthz") {
			const report = buildHealthReport(checks);
			return jsonResponse(report, { status: report.status === "ok" ? 200 : 503 });
		}
		if (request.method === "GET" && url.pathname === "/readyz") {
			if (runtime !== undefined && bearerToken(request) !== runtime.readinessToken) return unauthorized();
			await reconcile();
			const report = buildReadinessReport(runtimeReadiness);
			return jsonResponse(report, { status: report.status === "ready" ? 200 : 503 });
		}
		const closeChatId = request.method === "POST" ? chatIdFromClosePath(url.pathname) : undefined;
		if (routes !== undefined && closeChatId !== undefined) {
			const operationId = await closeOperationId(request);
			return operationId instanceof Response
				? operationId
				: handleOpenAIChatCloseRequest(closeChatId, operationId, routes);
		}
		if (routes !== undefined && request.method === "GET" && url.pathname === "/v1/models")
			return handleOpenAIModelsRequest(routes);
		if (routes?.projectLinkService !== undefined && request.method === "GET" && url.pathname === "/admin/projects")
			return projectList(request, routes);
		if (
			routes?.projectLinkService !== undefined &&
			request.method === "POST" &&
			url.pathname === "/admin/projects/link"
		)
			return projectLink(request, routes);
		if (routes?.projectLinkService !== undefined && request.method === "POST" && isProjectUnlinkPath(url.pathname))
			return projectUnlink(request, url.pathname, routes);
		if (routes !== undefined && request.method === "POST" && url.pathname === "/v1/chat/completions")
			return handleOpenAIChatCompletionsRequest(request, routes);
		return jsonResponse({ error: "not_found" }, { status: 404 });
	};
}

async function projectList(request: Request, routes: AdapterRouteDependencies): Promise<Response> {
	const error = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
	if (error !== undefined) return error;
	const result = await handleProjectListRequest(routes.projectLinkService!);
	return jsonResponse(result.body, { status: result.status });
}
async function projectLink(request: Request, routes: AdapterRouteDependencies): Promise<Response> {
	const error = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
	if (error !== undefined) return error;
	const body = await parseProjectAdminJsonRequest(request);
	if (!body.ok) return jsonResponse(body.result.body, { status: body.result.status });
	const result = await handleProjectLinkRequest(routes.projectLinkService!, body.value);
	return jsonResponse(result.body, { status: result.status });
}
async function projectUnlink(request: Request, pathname: string, routes: AdapterRouteDependencies): Promise<Response> {
	const error = authenticateAdapterRequest(request, routes.adapterApiToken, routes.requireAdapterApiToken);
	if (error !== undefined) return error;
	const projectId = projectIdFromUnlinkPath(pathname);
	if (!projectId.ok) return jsonResponse(projectId.result.body, { status: projectId.result.status });
	const result = await handleProjectUnlinkRequest(routes.projectLinkService!, projectId.value);
	return jsonResponse(result.body, { status: result.status });
}
function bearerToken(request: Request): string | undefined {
	return /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}
function unauthorized(): Response {
	return jsonResponse({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}
async function closeOperationId(request: Request): Promise<string | Response> {
	const header = request.headers.get("idempotency-key") ?? request.headers.get("x-operation-id");
	if (header !== null) return validateCloseOperationId(header);
	const body = await request.text();
	if (body.trim() === "") return randomUUID();
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return randomUUID();
		const value = Object.entries(parsed).find(([key]) => key === "operationId" || key === "idempotencyKey")?.[1];
		return value === undefined ? randomUUID() : validateCloseOperationId(value);
	} catch {
		return jsonResponse(
			{
				error: {
					message: "Close request body must be valid JSON.",
					type: "invalid_request_error",
					code: "invalid_close_operation_id",
				},
			},
			{ status: 400 },
		);
	}
}
function validateCloseOperationId(value: unknown): string | Response {
	if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
	return jsonResponse(
		{
			error: {
				message: "Close operation ID must be 1-128 URL-safe characters.",
				type: "invalid_request_error",
				code: "invalid_close_operation_id",
			},
		},
		{ status: 400 },
	);
}
function authenticateProviderRequest(
	request: Request,
	routes: AdapterRouteDependencies | undefined,
	runtime: AdapterRuntimeConfig | undefined,
): Response | undefined {
	return runtime !== undefined
		? bearerToken(request) === runtime.adapterToken
			? undefined
			: unauthorized()
		: authenticateAdapterRequest(request, routes?.adapterApiToken, routes?.requireAdapterApiToken);
}
function authenticateAdapterRequest(
	request: Request,
	token: string | undefined,
	required = false,
): Response | undefined {
	if (token === undefined && required)
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
	if (token === undefined || request.headers.get("authorization") === `Bearer ${token}`) return undefined;
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
