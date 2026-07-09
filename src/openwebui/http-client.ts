import type {
	OpenWebUIChatMessageRecord,
	OpenWebUIChatRecord,
	OpenWebUIFolderRecord,
	OpenWebUIProjectionRepository,
} from "./client";
import type { OpenWebUIMessageEvent } from "./events";
import { OpenWebUIHttpError } from "./http-errors";
import { parseOpenWebUIChatRecord, parseOpenWebUIFileContent } from "./http-parsers";
import { createOpenWebUITransport, type OpenWebUITransport } from "./http-transport";
import {
	adapterProjectId,
	epochSeconds,
	normalizeApiToken,
	normalizeBaseUrl,
	normalizeTimeoutMs,
	type OpenWebUIFolderLookup,
	openWebUIApiPath,
	openWebUIChatBody,
	ownerMatches,
	parseOpenWebUIFolderLookup,
} from "./http-wire";

export { OpenWebUIHttpConfigurationError, OpenWebUIHttpError, OpenWebUITransportError } from "./http-errors";

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

export interface OpenWebUIFileContent {
	readonly id: string;
	readonly filename?: string;
	readonly content?: string;
}

export interface OpenWebUIFileBytes {
	readonly id: string;
	readonly bytes: Uint8Array;
	readonly contentType?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OpenWebUIHttpClient implements OpenWebUIProjectionRepository {
	readonly #transport: OpenWebUITransport;

	constructor(config: OpenWebUIHttpClientConfig) {
		this.#transport = createOpenWebUITransport({
			baseUrl: normalizeBaseUrl(config.baseUrl),
			apiToken: normalizeApiToken(config.apiToken),
			timeoutMs: normalizeTimeoutMs(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
	}

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		const existing = await this.#getFolderById(record.id);
		const folder =
			ownerMatches(existing, record.owner_user_id) ??
			(await this.#findFolderByAdapterMetadata(record)) ??
			(await this.#createFolder({ name: record.name, metadata: record.metadata }));
		await this.#transport.sendJson({
			method: "POST",
			path: openWebUIApiPath(["folders", folder.id, "update"]),
			body: { name: record.name, meta: record.metadata },
		});
		return {
			id: folder.id,
			owner_user_id: record.owner_user_id,
			name: record.name,
			metadata: record.metadata,
		};
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		const existing = await this.getChat(record.owner_user_id, record.id);
		if (existing === undefined) {
			const response = await this.#transport.sendJson({
				method: "POST",
				path: openWebUIApiPath(["chats", "import"]),
				body: {
					chats: [
						{
							chat: openWebUIChatBody(record),
							folder_id: record.folder_id,
							meta: record.metadata,
							...(record.created_at === undefined ? {} : { created_at: epochSeconds(record.created_at) }),
							...(record.updated_at === undefined ? {} : { updated_at: epochSeconds(record.updated_at) }),
						},
					],
				},
			});
			if (!Array.isArray(response) || response.length === 0) {
				throw new OpenWebUIHttpError({
					method: "POST",
					path: openWebUIApiPath(["chats", "import"]),
					status: 502,
					responseBody: "OpenWebUI chat import returned no chats.",
				});
			}
			return parseOpenWebUIChatRecord(response[0], {
				method: "POST",
				path: openWebUIApiPath(["chats", "import"]),
				body: record,
			});
		}
		const request = {
			method: "POST",
			path: openWebUIApiPath(["chats", existing.id]),
			body: {
				chat: openWebUIChatBody({ ...record, id: existing.id }),
				folder_id: record.folder_id,
				meta: record.metadata,
			},
		} as const;
		const response = await this.#transport.sendJson(request);
		const updated = parseOpenWebUIChatRecord(response, request);
		return await this.#moveChatToFolder(updated, record.folder_id);
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		void ownerUserId;
		void chatId;
		return messages;
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined> {
		const request = {
			method: "GET",
			path: openWebUIApiPath(["chats", chatId]),
		} as const;
		const response = await this.#transport.sendJson(request, { missingStatuses: [401, 404] });
		if (response === undefined) return undefined;
		const parsed = parseOpenWebUIChatRecord(response, request);
		return ownerUserId.length > 0 && parsed.owner_user_id === ownerUserId ? parsed : undefined;
	}

	async postMessageEvent(input: PostOpenWebUIMessageEventInput): Promise<void> {
		await this.#transport.sendJson({
			method: "POST",
			path: openWebUIApiPath(["chats", input.chatId, "messages", input.messageId, "event"]),
			body: input.event,
		});
	}

	async updateMessageContent(input: UpdateOpenWebUIMessageContentInput): Promise<void> {
		await this.#transport.sendJson({
			method: "POST",
			path: openWebUIApiPath(["chats", input.chatId, "messages", input.messageId]),
			body: { content: input.content },
		});
	}

	async getFileContent(fileId: string): Promise<OpenWebUIFileContent | undefined> {
		const request = {
			method: "GET",
			path: openWebUIApiPath(["files", fileId]),
		} as const;
		const response = await this.#transport.sendJson(request, { missingStatuses: [401, 404] });
		return response === undefined ? undefined : parseOpenWebUIFileContent(response, request);
	}

	async getFileBytes(fileId: string): Promise<OpenWebUIFileBytes | undefined> {
		const request = {
			method: "GET",
			path: openWebUIApiPath(["files", fileId, "content"]),
		} as const;
		const response = await this.#transport.sendBinary(request, { missingStatuses: [401, 404] });
		if (response === undefined) return undefined;
		return {
			id: fileId,
			bytes: response.bytes,
			...(response.contentType === null ? {} : { contentType: response.contentType }),
		};
	}

	async #getFolderById(folderId: string): Promise<OpenWebUIFolderLookup | undefined> {
		const request = { method: "GET", path: openWebUIApiPath(["folders", folderId]) } as const;
		const response = await this.#transport.sendJson(request, { missingStatuses: [404] });
		return response === undefined ? undefined : parseOpenWebUIFolderLookup(response, request);
	}

	async #findFolderByAdapterMetadata(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderLookup | undefined> {
		const projectId = adapterProjectId(record.metadata);
		if (projectId === undefined) return undefined;
		const request = { method: "GET", path: `${openWebUIApiPath(["folders"])}/` } as const;
		const response = await this.#transport.sendJson(request);
		if (!Array.isArray(response)) return undefined;
		for (const item of response) {
			const summary = parseOpenWebUIFolderLookup(item, request);
			const fullFolder = await this.#getFolderById(summary.id);
			if (
				fullFolder !== undefined &&
				ownerMatches(fullFolder, record.owner_user_id) !== undefined &&
				adapterProjectId(fullFolder.metadata) === projectId
			) {
				return fullFolder;
			}
		}
		return undefined;
	}

	async #createFolder(input: {
		readonly name: string;
		readonly metadata: Record<string, unknown>;
	}): Promise<OpenWebUIFolderLookup> {
		const request = {
			method: "POST",
			path: `${openWebUIApiPath(["folders"])}/`,
			body: { name: input.name, meta: input.metadata },
		} as const;
		const response = await this.#transport.sendJson(request);
		return parseOpenWebUIFolderLookup(response, request);
	}

	async #moveChatToFolder(record: OpenWebUIChatRecord, folderId: string): Promise<OpenWebUIChatRecord> {
		if (record.folder_id === folderId) return record;
		const request = {
			method: "POST",
			path: openWebUIApiPath(["chats", record.id, "folder"]),
			body: { folder_id: folderId },
		} as const;
		const response = await this.#transport.sendJson(request);
		const moved = parseOpenWebUIChatRecord(response, request);
		return { ...moved, metadata: record.metadata };
	}
}
