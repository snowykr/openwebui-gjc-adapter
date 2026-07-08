import type {
	OpenWebUIChatMessageRecord,
	OpenWebUIChatRecord,
	OpenWebUIFolderRecord,
	OpenWebUIProjectionRepository,
} from "./client";
import type { OpenWebUIMessageEvent } from "./events";
import { parseOpenWebUIChatRecord } from "./http-parsers";

export interface OpenWebUIHttpClientConfig {
	readonly baseUrl: string;
	readonly apiToken: string;
	readonly timeoutMs?: number;
}

export interface PostOpenWebUIMessageEventInput {
	readonly chatId: string;
	readonly messageId: string;
	readonly event: OpenWebUIMessageEvent;
}

export interface UpdateOpenWebUIMessageContentInput {
	readonly chatId: string;
	readonly messageId: string;
	readonly content: string;
}

interface OpenWebUIHttpRequest {
	readonly method: "GET" | "PUT" | "POST";
	readonly path: string;
	readonly body?: unknown;
}

interface OpenWebUIHttpErrorInput extends OpenWebUIHttpRequest {
	readonly status: number;
	readonly responseBody: string;
}

interface OpenWebUITransportErrorInput extends OpenWebUIHttpRequest {
	readonly detail: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OpenWebUIHttpConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenWebUIHttpConfigurationError";
	}
}

export class OpenWebUIHttpError extends Error {
	readonly method: string;
	readonly path: string;
	readonly status: number;
	readonly responseBody: string;

	constructor(input: OpenWebUIHttpErrorInput) {
		super(`OpenWebUI HTTP ${input.method} ${input.path} failed with ${input.status}: ${input.responseBody}`);
		this.name = "OpenWebUIHttpError";
		this.method = input.method;
		this.path = input.path;
		this.status = input.status;
		this.responseBody = input.responseBody;
	}
}

export class OpenWebUITransportError extends Error {
	readonly method: string;
	readonly path: string;
	readonly detail: string;

	constructor(input: OpenWebUITransportErrorInput) {
		super(`OpenWebUI HTTP ${input.method} ${input.path} could not be delivered: ${input.detail}`);
		this.name = "OpenWebUITransportError";
		this.method = input.method;
		this.path = input.path;
		this.detail = input.detail;
	}
}

export class OpenWebUIHttpClient implements OpenWebUIProjectionRepository {
	readonly #baseUrl: string;
	readonly #apiToken: string;
	readonly #timeoutMs: number;

	constructor(config: OpenWebUIHttpClientConfig) {
		this.#baseUrl = normalizeBaseUrl(config.baseUrl);
		this.#apiToken = normalizeApiToken(config.apiToken);
		this.#timeoutMs = normalizeTimeoutMs(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	}

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		await this.#sendJson({
			method: "PUT",
			path: openWebUIApiPath(["folders", record.id]),
			body: record,
		});
		return record;
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		await this.#sendJson({
			method: "PUT",
			path: openWebUIApiPath(["chats", record.id]),
			body: record,
		});
		return record;
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		await this.#sendJson({
			method: "PUT",
			path: openWebUIApiPath(["chats", chatId, "messages"]),
			body: { owner_user_id: ownerUserId, messages },
		});
		return messages;
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined> {
		const request = {
			method: "GET",
			path: `${openWebUIApiPath(["chats", chatId])}?owner_user_id=${encodeURIComponent(ownerUserId)}`,
		} as const;
		const response = await this.#sendJson(request);
		if (response === undefined) return undefined;
		return parseOpenWebUIChatRecord(response, request);
	}

	async postMessageEvent(input: PostOpenWebUIMessageEventInput): Promise<void> {
		await this.#sendJson({
			method: "POST",
			path: openWebUIApiPath(["chats", input.chatId, "messages", input.messageId, "event"]),
			body: input.event,
		});
	}

	async updateMessageContent(input: UpdateOpenWebUIMessageContentInput): Promise<void> {
		await this.#sendJson({
			method: "POST",
			path: openWebUIApiPath(["chats", input.chatId, "messages", input.messageId]),
			body: { content: input.content },
		});
	}

	async #sendJson(request: OpenWebUIHttpRequest): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`${this.#baseUrl}${request.path}`, {
				method: request.method,
				headers: {
					accept: "application/json",
					authorization: `Bearer ${this.#apiToken}`,
					...(request.body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : "non-Error fetch failure";
			throw new OpenWebUITransportError({ ...request, detail });
		}

		if (request.method === "GET" && response.status === 404) {
			return undefined;
		}
		if (!response.ok) {
			throw new OpenWebUIHttpError({
				...request,
				status: response.status,
				responseBody: await response.text(),
			});
		}
		if (response.status === 204) return undefined;
		return await response.json();
	}
}

function openWebUIApiPath(segments: readonly string[]): string {
	return `/api/v1/${segments.map(segment => encodeURIComponent(segment)).join("/")}`;
}

function normalizeBaseUrl(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "invalid URL";
		throw new OpenWebUIHttpConfigurationError(`GJC OpenWebUI base URL is invalid: ${detail}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new OpenWebUIHttpConfigurationError("GJC OpenWebUI base URL must use http or https.");
	}
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString().replace(/\/+$/, "");
}

function normalizeApiToken(apiToken: string): string {
	const trimmed = apiToken.trim();
	if (trimmed.length === 0) {
		throw new OpenWebUIHttpConfigurationError("GJC OpenWebUI API token must be configured.");
	}
	return trimmed;
}

function normalizeTimeoutMs(timeoutMs: number): number {
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new OpenWebUIHttpConfigurationError("GJC OpenWebUI HTTP timeout must be a positive integer.");
	}
	return timeoutMs;
}
