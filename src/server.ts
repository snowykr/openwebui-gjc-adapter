import { type AdapterHealthCheck, buildHealthReport } from "./health";
import { handleChatCompletions, type LiveGatewayEventSink, type LiveGatewayRunner } from "./live/chat-completions";
import { buildModelList } from "./live/models";
import type { OpenAIChatCompletionRequest } from "./live/openai-types";
import type { OpenWebUIOwnerContext } from "./openwebui/auth";
import type { OpenWebUIHeaderInput } from "./openwebui/headers";
import type { RegisteredProject } from "./projects/registry";

export interface AdapterServerOptions {
	host: string;
	port: number;
	checks?: readonly AdapterHealthCheck[];
	routes?: AdapterRouteDependencies;
}

export interface AdapterRouteDependencies {
	readonly projects: readonly RegisteredProject[];
	readonly owner: OpenWebUIOwnerContext;
	readonly runner: LiveGatewayRunner;
	readonly eventSink?: LiveGatewayEventSink;
}

type AdapterRequestHandlerOptions = {
	readonly checks?: readonly AdapterHealthCheck[];
	readonly routes?: AdapterRouteDependencies;
};

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
			return jsonResponse(buildModelList(routes.projects));
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
		fetch: createAdapterRequestHandler({ checks: options.checks, routes: options.routes }),
	});
	return {
		url: server.url.toString(),
		async stop(): Promise<void> {
			await server.stop();
		},
	};
}
