import { OpenWebUIHttpError, type OpenWebUIHttpRequest, OpenWebUITransportError } from "./http-errors";

export interface OpenWebUIBinaryResponse {
	readonly bytes: Uint8Array;
	readonly contentType: string | null;
}

export interface OpenWebUITransportConfig {
	readonly baseUrl: string;
	readonly apiToken: string;
	readonly timeoutMs: number;
}

export interface OpenWebUITransport {
	sendJson(
		request: OpenWebUIHttpRequest,
		options?: { readonly missingStatuses?: readonly number[] },
	): Promise<unknown>;
	sendBinary(
		request: OpenWebUIHttpRequest,
		options?: { readonly missingStatuses?: readonly number[] },
	): Promise<OpenWebUIBinaryResponse | undefined>;
}

export function createOpenWebUITransport(config: OpenWebUITransportConfig): OpenWebUITransport {
	return {
		async sendJson(request, options = {}) {
			const response = await sendOpenWebUIRequest(config, request, {
				accept: "application/json",
				...(request.body === undefined ? {} : { "content-type": "application/json" }),
			});
			if (isMissingResponse(request, response, options.missingStatuses)) return undefined;
			await assertOpenWebUIResponseOk(request, response);
			if (response.status === 204) return undefined;
			return await response.json();
		},
		async sendBinary(request, options = {}) {
			const response = await sendOpenWebUIRequest(config, request, {
				accept: "application/octet-stream, */*",
			});
			if (isMissingResponse(request, response, options.missingStatuses)) return undefined;
			await assertOpenWebUIResponseOk(request, response);
			return {
				bytes: new Uint8Array(await response.arrayBuffer()),
				contentType: response.headers.get("content-type"),
			};
		},
	};
}

async function sendOpenWebUIRequest(
	config: OpenWebUITransportConfig,
	request: OpenWebUIHttpRequest,
	headers: Record<string, string>,
): Promise<Response> {
	try {
		return await fetch(`${config.baseUrl}${request.path}`, {
			method: request.method,
			headers: {
				...headers,
				authorization: `Bearer ${config.apiToken}`,
			},
			...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
			signal: AbortSignal.timeout(config.timeoutMs),
		});
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : "non-Error fetch failure";
		throw new OpenWebUITransportError({ ...request, detail });
	}
}

function isMissingResponse(
	request: OpenWebUIHttpRequest,
	response: Response,
	missingStatuses: readonly number[] | undefined,
): boolean {
	if (missingStatuses !== undefined) return missingStatuses.includes(response.status);
	return request.method === "GET" && response.status === 404;
}

async function assertOpenWebUIResponseOk(request: OpenWebUIHttpRequest, response: Response): Promise<void> {
	if (response.ok) return;
	throw new OpenWebUIHttpError({
		...request,
		status: response.status,
		responseBody: await response.text(),
	});
}
