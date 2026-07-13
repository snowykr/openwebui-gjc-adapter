import {
	type AdapterHealthCheck,
	type AdapterReadinessOptions,
	buildHealthReport,
	buildReadinessReport,
} from "./health";
import {
	type AdapterRouteDependencies,
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

export type { AdapterRouteDependencies } from "./live/openai-routes";
export type { AdapterRuntimeConfig } from "./server-runtime-readiness";
export { initializeRuntimeReadiness } from "./server-runtime-readiness";

export interface AdapterServerOptions {
	host: string;
	port: number;
	checks?: readonly AdapterHealthCheck[];
	readiness?: AdapterReadinessOptions;
	runtime?: AdapterRuntimeConfig;
	routes?: AdapterRouteDependencies;
}

type AdapterRequestHandlerOptions = {
	readonly checks?: readonly AdapterHealthCheck[];
	readonly routes?: AdapterRouteDependencies;
	readonly readiness?: AdapterReadinessOptions;
	readonly runtime?: AdapterRuntimeConfig;
};

export interface AdapterServerHandle {
	url: string;
	stop(): Promise<void>;
}

function bearerToken(request: Request): string | undefined {
	const value = request.headers.get("authorization");
	const match = value === null ? undefined : /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(value);
	return match?.[1];
}

function unauthorized(): Response {
	return jsonResponse({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

export function createAdapterRequestHandler(
	options: readonly AdapterHealthCheck[] | AdapterRequestHandlerOptions = [],
): (request: Request) => Response | Promise<Response> {
	const routeOptions: AdapterRequestHandlerOptions | undefined = isHealthCheckList(options) ? undefined : options;
	const checks = routeOptions?.checks ?? (isHealthCheckList(options) ? options : []);
	const routes = routeOptions?.routes;
	const runtime = routeOptions?.runtime;
	const runtimeReadiness: AdapterReadinessOptions = {
		...(runtime?.readiness ??
			routeOptions?.readiness ?? {
				openWebUIAuthenticated: false,
				promptHintsSeeded: false,
			}),
	};
	const reconcileRuntimeReadiness =
		runtime === undefined ? () => Promise.resolve() : createRuntimeReadinessReconciler(runtime, runtimeReadiness);
	if (runtime !== undefined) void reconcileRuntimeReadiness();

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
			const authError = authenticateProviderRequest(request, routes, runtime);
			if (authError !== undefined) return authError;
			if (runtime !== undefined) {
				await reconcileRuntimeReadiness();
				if (!runtimeReadiness.openWebUIAuthenticated || !runtimeReadiness.promptHintsSeeded) {
					return jsonResponse(
						{ error: "service_unavailable", message: "adapter runtime initialization is incomplete" },
						{ status: 503 },
					);
				}
			}
		}
		if (request.method === "GET" && url.pathname === "/healthz") {
			const report = buildHealthReport(checks);
			return jsonResponse(report, { status: report.status === "ok" ? 200 : 503 });
		}
		if (request.method === "GET" && url.pathname === "/readyz") {
			if (runtime !== undefined && bearerToken(request) !== runtime.readinessToken) return unauthorized();
			await reconcileRuntimeReadiness();
			const report = buildReadinessReport(runtimeReadiness);
			return jsonResponse(report, { status: report.status === "ready" ? 200 : 503 });
		}
		if (routes !== undefined && request.method === "GET" && url.pathname === "/v1/models") {
			return handleOpenAIModelsRequest(routes);
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
			return handleOpenAIChatCompletionsRequest(request, routes);
		}
		return jsonResponse({ error: "not_found" }, { status: 404 });
	};
}

function authenticateProviderRequest(
	request: Request,
	routes: AdapterRouteDependencies | undefined,
	runtime: AdapterRuntimeConfig | undefined,
): Response | undefined {
	if (runtime !== undefined) return bearerToken(request) === runtime.adapterToken ? undefined : unauthorized();
	return authenticateAdapterRequest(request, routes?.adapterApiToken, routes?.requireAdapterApiToken);
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
		fetch: createAdapterRequestHandler({
			checks: options.checks,
			readiness: options.readiness,
			routes: options.routes,
			runtime: options.runtime,
		}),
	});
	return {
		url: server.url.toString(),
		async stop(): Promise<void> {
			await server.stop();
		},
	};
}
