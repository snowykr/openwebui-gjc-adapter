import {
	type AdapterHealthCheck,
	type AdapterReadinessOptions,
	buildHealthReport,
	buildReadinessReport,
} from "./health";
import { handleChatCompletions, type LiveGatewayEventSink, type LiveGatewayRunner } from "./live/chat-completions";
import { buildModelList } from "./live/models";
import type { OpenAIChatCompletionRequest } from "./live/openai-types";
import type { OpenWebUIOwnerContext } from "./openwebui/auth";
import type { OpenWebUIHeaderInput } from "./openwebui/headers";
import {
	mergePromptHints,
	OPENWEBUI_CONFIG_ENDPOINT,
	OPENWEBUI_PROMPT_HINTS_ENDPOINT,
	promptHintsFromConfig,
} from "./openwebui/prompt-hints";
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
	readonly owner: OpenWebUIOwnerContext;
	readonly runner: LiveGatewayRunner;
	readonly eventSink?: LiveGatewayEventSink;
}

type AdapterRequestHandlerOptions = {
	readonly checks?: readonly AdapterHealthCheck[];
	readonly readiness?: AdapterReadinessOptions;
	readonly routes?: AdapterRouteDependencies;
	readonly runtime?: AdapterRuntimeConfig;
};
type RuntimeReadinessState = AdapterReadinessOptions;
function bearerToken(request: Request): string | undefined {
	const value = request.headers.get("authorization");
	if (value === null) return undefined;
	const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(value);
	return match?.[1];
}

function authorized(request: Request, token: string | undefined): boolean {
	if (token === undefined) return true;
	const presented = bearerToken(request);
	return presented !== undefined && presented === token;
}

function unauthorized(): Response {
	return jsonResponse({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

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

/** Validate the persisted token and reconcile adapter-owned prompt hints without ever returning or logging the token.
 * OpenWebUI v0.10 exposes GET /api/config for authenticated prompt-hint readback and POST /api/v1/configs/suggestions for writes. */
export async function initializeRuntimeReadiness(runtime: AdapterRuntimeConfig): Promise<AdapterReadinessOptions> {
	if (!runtime.openWebUIApiToken?.trim()) {
		return {
			...(runtime.readiness ?? {}),
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI API token is missing",
		};
	}
	if (!runtime.openWebUIBaseUrl?.trim()) {
		return {
			...(runtime.readiness ?? {}),
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI runtime URL is not configured",
		};
	}
	const baseUrl = runtime.openWebUIBaseUrl.trim().replace(/\/+$/, "");
	const token = runtime.openWebUIApiToken;
	let result: AdapterReadinessOptions = {
		...(runtime.readiness ?? {}),
		openWebUIAuthenticated: false,
		promptHintsSeeded: false,
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		result = await initializeRuntimeReadinessAttempt(baseUrl, token, result);
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
		const response = await fetch(`${baseUrl}/api/v1/auths/`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!response.ok)
			return {
				...fallback,
				openWebUIAuthenticated: false,
				promptHintsSeeded: false,
				reason: "OpenWebUI API token was rejected",
			};
		const authUser = (await response.json()) as { id?: string } | Array<{ id?: string }>;
		const id = (Array.isArray(authUser) ? authUser[0]?.id : authUser?.id)?.trim();
		if (!id)
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
		const mergedPayload = mergePromptHints(promptHintsFromConfig(config));
		if (mergedPayload === undefined)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint read was invalid",
			};
		const seedResponse = await fetch(`${baseUrl}${OPENWEBUI_PROMPT_HINTS_ENDPOINT}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(mergedPayload),
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
		const seeded = JSON.stringify(readback) === JSON.stringify(mergedPayload.suggestions);
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
const RUNTIME_RETRY_BASE_DELAY_MS = 100;
const RUNTIME_RETRY_MAX_DELAY_MS = 2_000;

function createRuntimeReadinessReconciler(
	runtime: AdapterRuntimeConfig,
	runtimeReadiness: RuntimeReadinessState,
): () => Promise<void> {
	let inFlight: Promise<void> | undefined;
	let retryCount = 0;
	let retryAt = 0;

	const isReady = (): boolean =>
		runtimeReadiness.openWebUIAuthenticated === true && runtimeReadiness.promptHintsSeeded === true;
	const reconcile = (): Promise<void> => {
		if (isReady() || inFlight !== undefined || Date.now() < retryAt) return inFlight ?? Promise.resolve();

		inFlight = initializeRuntimeReadiness(runtime)
			.then(state => {
				Object.assign(runtimeReadiness, state);
				if (isReady()) {
					retryCount = 0;
					retryAt = 0;
				} else {
					const delay = Math.min(RUNTIME_RETRY_MAX_DELAY_MS, RUNTIME_RETRY_BASE_DELAY_MS * 2 ** retryCount);
					retryCount++;
					retryAt = Date.now() + delay;
				}
			})
			.catch(() => {
				Object.assign(runtimeReadiness, {
					openWebUIAuthenticated: false,
					promptHintsSeeded: false,
					reason: "OpenWebUI runtime reconciliation failed",
				});
				const delay = Math.min(RUNTIME_RETRY_MAX_DELAY_MS, RUNTIME_RETRY_BASE_DELAY_MS * 2 ** retryCount);
				retryCount++;
				retryAt = Date.now() + delay;
			})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};

	return reconcile;
}
export function createAdapterRequestHandler(
	options: readonly AdapterHealthCheck[] | AdapterRequestHandlerOptions = [],
): (request: Request) => Response | Promise<Response> {
	const routeOptions: AdapterRequestHandlerOptions | undefined = isHealthCheckList(options) ? undefined : options;
	const checks = routeOptions?.checks ?? (isHealthCheckList(options) ? options : []);
	const readiness = routeOptions?.readiness;
	const routes = routeOptions?.routes;
	const runtime = routeOptions?.runtime;
	const runtimeReadiness: RuntimeReadinessState = {
		...(runtime?.readiness ?? readiness ?? { openWebUIAuthenticated: false, promptHintsSeeded: false }),
	};
	const reconcileRuntimeReadiness =
		runtime === undefined ? () => Promise.resolve() : createRuntimeReadinessReconciler(runtime, runtimeReadiness);
	if (runtime !== undefined) void reconcileRuntimeReadiness();

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if ((url.pathname === "/v1" || url.pathname.startsWith("/v1/")) && !authorized(request, runtime?.adapterToken)) {
			return unauthorized();
		}
		if (runtime !== undefined && (url.pathname === "/v1" || url.pathname.startsWith("/v1/"))) {
			await reconcileRuntimeReadiness();
			if (!runtimeReadiness.openWebUIAuthenticated || !runtimeReadiness.promptHintsSeeded) {
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
			if (runtime !== undefined && !authorized(request, runtime.readinessToken)) {
				return unauthorized();
			}
			await reconcileRuntimeReadiness();
			const report = buildReadinessReport(runtimeReadiness);
			return jsonResponse(report, { status: report.status === "ready" ? 200 : 503 });
		}
		if (routes !== undefined && request.method === "GET" && url.pathname === "/v1/models") {
			return jsonResponse(buildModelList());
		}
		if (routes !== undefined && request.method === "POST" && url.pathname === "/v1/chat/completions") {
			let body: OpenAIChatCompletionRequest;
			try {
				body = (await request.json()) as OpenAIChatCompletionRequest;
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
			const result = await handleChatCompletions({
				request: body,
				headers: headersFromRequest(request),
				projects: routes.projects,
				owner: routes.owner,
				runner: routes.runner,
				eventSink: routes.eventSink,
			});
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

function headersFromRequest(request: Request): OpenWebUIHeaderInput {
	return request.headers;
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
