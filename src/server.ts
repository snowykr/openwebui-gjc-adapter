import {
	type AdapterHealthCheck,
	type AdapterReadinessOptions,
	buildHealthReport,
	buildReadinessReport,
} from "./health";
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
import type { OpenWebUIProjectionRepository } from "./openwebui/client";
import {
	mergePromptHints,
	OPENWEBUI_CONFIG_ENDPOINT,
	OPENWEBUI_PROMPT_HINTS_ENDPOINT,
	promptHintsFromConfig,
} from "./openwebui/prompt-hints";
import {
	buildProjectModelList,
	handleProjectAdminChatCompletion,
	handleProjectLinkRequest,
	handleProjectListRequest,
	handleProjectUnlinkRequest,
	isProjectAdminChatCompletionRequest,
	isProjectUnlinkPath,
	parseProjectAdminJsonRequest,
	projectIdFromUnlinkPath,
} from "./projects/admin-routes";
import type { ProjectLinkService } from "./projects/link-service";
import type { RegisteredProject } from "./projects/registry";
export interface AdapterServerOptions {
	host: string;
	port: number;
	checks?: readonly AdapterHealthCheck[];
	readiness?: AdapterReadinessOptions;
	runtime?: AdapterRuntimeConfig;
	routes?: AdapterRouteDependencies;
}
export interface AdapterRuntimeConfig {
	/** The token OpenWebUI presents to the adapter provider. */
	readonly adapterToken: string;
	/** A distinct token used only by the readiness probe. */
	readonly readinessToken: string;
	/** Non-secret state recorded by the authenticated setup flow. */
	readonly readiness?: AdapterReadinessOptions;
	/** Runtime OpenWebUI peer URL used for bounded startup authentication. */
	readonly openWebUIBaseUrl?: string;
	/** Persisted OpenWebUI API token; never included in responses or diagnostics. */
	readonly openWebUIApiToken?: string;
}

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
}

type AdapterRequestHandlerOptions = {
	readonly checks?: readonly AdapterHealthCheck[];
	readonly routes?: AdapterRouteDependencies;
	readonly readiness?: AdapterReadinessOptions;
	readonly runtime?: AdapterRuntimeConfig;
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
function bearerToken(request: Request): string | undefined {
	const value = request.headers.get("authorization");
	const match = value === null ? undefined : /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(value);
	return match?.[1];
}

function unauthorized(): Response {
	return jsonResponse({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

/** Validates the persisted token and reconciles config-suggestion hints without exposing credentials. */
export async function initializeRuntimeReadiness(runtime: AdapterRuntimeConfig): Promise<AdapterReadinessOptions> {
	if (!runtime.openWebUIApiToken?.trim())
		return {
			...(runtime.readiness ?? {}),
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI API token is missing",
		};
	if (!runtime.openWebUIBaseUrl?.trim())
		return {
			...(runtime.readiness ?? {}),
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI runtime URL is not configured",
		};

	const baseUrl = runtime.openWebUIBaseUrl.trim().replace(/\/+$/, "");
	let result: AdapterReadinessOptions = {
		...(runtime.readiness ?? {}),
		openWebUIAuthenticated: false,
		promptHintsSeeded: false,
	};
	for (let attempt = 0; attempt < 3; attempt += 1) {
		result = await initializeRuntimeReadinessAttempt(baseUrl, runtime.openWebUIApiToken, result);
		if (result.openWebUIAuthenticated && result.promptHintsSeeded) return result;
		if (attempt < 2) await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 100 : 250));
	}
	return result;
}

async function initializeRuntimeReadinessAttempt(
	baseUrl: string,
	token: string,
	fallback: AdapterReadinessOptions,
): Promise<AdapterReadinessOptions> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2_000);
	try {
		const authResponse = await fetch(`${baseUrl}/api/v1/auths/`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!authResponse.ok)
			return {
				...fallback,
				openWebUIAuthenticated: false,
				promptHintsSeeded: false,
				reason: "OpenWebUI API token was rejected",
			};
		const authUser = (await authResponse.json()) as { id?: string } | Array<{ id?: string }>;
		if (!(Array.isArray(authUser) ? authUser[0]?.id : authUser.id)?.trim())
			return {
				...fallback,
				openWebUIAuthenticated: false,
				promptHintsSeeded: false,
				reason: "OpenWebUI authentication response was invalid",
			};

		const configResponse = await fetch(`${baseUrl}${OPENWEBUI_CONFIG_ENDPOINT}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!configResponse.ok)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint read was not verified",
			};
		let config: unknown;
		try {
			config = await configResponse.json();
		} catch {
			config = undefined;
		}
		const payload = mergePromptHints(promptHintsFromConfig(config));
		if (payload === undefined)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint read was invalid",
			};

		const seedResponse = await fetch(`${baseUrl}${OPENWEBUI_PROMPT_HINTS_ENDPOINT}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!seedResponse.ok)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint seed was not verified",
			};
		let readback: unknown;
		try {
			readback = await seedResponse.json();
		} catch {
			readback = undefined;
		}
		const seeded = JSON.stringify(readback) === JSON.stringify(payload.suggestions);
		return {
			...fallback,
			openWebUIAuthenticated: true,
			promptHintsSeeded: seeded,
			...(seeded ? {} : { reason: "OpenWebUI prompt-hint readback did not match the merged seed" }),
		};
	} catch {
		return {
			...fallback,
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI authentication or prompt-hint probe failed",
		};
	} finally {
		clearTimeout(timeout);
	}
}

function createRuntimeReadinessReconciler(
	runtime: AdapterRuntimeConfig,
	state: AdapterReadinessOptions,
): () => Promise<void> {
	let inFlight: Promise<void> | undefined;
	let retryCount = 0;
	let retryAt = 0;
	const ready = (): boolean => state.openWebUIAuthenticated === true && state.promptHintsSeeded === true;
	return () => {
		if (ready() || inFlight !== undefined || Date.now() < retryAt) return inFlight ?? Promise.resolve();
		inFlight = initializeRuntimeReadiness(runtime)
			.then(next => Object.assign(state, next))
			.catch(() =>
				Object.assign(state, {
					openWebUIAuthenticated: false,
					promptHintsSeeded: false,
					reason: "OpenWebUI runtime reconciliation failed",
				}),
			)
			.then(() => {
				if (ready()) {
					retryCount = 0;
					retryAt = 0;
				} else {
					retryAt = Date.now() + Math.min(2_000, 100 * 2 ** retryCount);
					retryCount += 1;
				}
			})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};
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
					projectContextRepository: routes.projectContextRepository,
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
