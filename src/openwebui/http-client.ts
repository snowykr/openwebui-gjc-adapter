import {
	createOpenWebUIPrincipalContext,
	type OpenWebUIAdminPrincipal,
	type OpenWebUIPrincipal,
	type OpenWebUIPrincipalContext,
	OpenWebUIPrincipalProjectionError,
	requireOpenWebUIAdminPrincipal,
} from "./auth";
import type {
	OpenWebUIChatMessageRecord,
	OpenWebUIChatRecord,
	OpenWebUIFolderRecord,
	OpenWebUIProjectionRepository,
} from "./client";
import type { OpenWebUIMessageEvent } from "./events";
import { OpenWebUIHttpError, OpenWebUITransportError } from "./http-errors";
import type { OpenWebUIFileBytes, OpenWebUIFileContent } from "./http-file-types";
import {
	assertOpenWebUIOwnerChatProof,
	createOpenWebUIOwnerChatProof,
	type OpenWebUIOwnerChatProof,
	OpenWebUIPrincipalScopeError,
} from "./http-message-writer";
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

export type {
	AdminPrincipalContext,
	OpenWebUIAdminPrincipal,
	OpenWebUIPrincipal,
	OpenWebUIPrincipalContext,
	OpenWebUIPrincipalWorkspaceContext,
} from "./auth";
export { OpenWebUIPrincipalProjectionError } from "./auth";
export { OpenWebUIHttpConfigurationError, OpenWebUIHttpError, OpenWebUITransportError } from "./http-errors";
export type { OpenWebUIFileBytes, OpenWebUIFileContent } from "./http-file-types";
export type { OpenWebUIOwnerChatProof } from "./http-message-writer";
export {
	assertOpenWebUIOwnerChatProof,
	createOpenWebUIOwnerChatProof,
	OpenWebUIPrincipalScopeError,
} from "./http-message-writer";

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
export interface OpenWebUIBootstrapClientConfig extends OpenWebUIHttpClientConfig {
	readonly ownerUserId?: string;
}

export interface OpenWebUIPrincipalFileContent extends OpenWebUIFileContent {
	readonly owner_user_id: string;
}

export interface OpenWebUIPrincipalFile {
	readonly metadata: OpenWebUIPrincipalFileContent;
	readonly bytes?: OpenWebUIFileBytes;
	readonly original?: OpenWebUIFileBytes;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CAPABILITY_CONSTRUCTION_TOKEN = Symbol("OpenWebUICapabilityConstructionToken");
type CapabilityConstructionToken = typeof CAPABILITY_CONSTRUCTION_TOKEN;
export class OpenWebUIMessageEventResponseError extends Error {
	readonly method = "POST";
	readonly path: string;
	readonly detail: string;

	constructor(input: { readonly path: string; readonly detail: string }) {
		super(`OpenWebUI message event POST ${input.path} returned an invalid response: ${input.detail}`);
		this.name = "OpenWebUIMessageEventResponseError";
		this.path = input.path;
		this.detail = input.detail;
	}
}

/** @deprecated Use OpenWebUIBootstrapClient and its capability factories for route-facing access. */
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
		const request = {
			method: "POST",
			path: openWebUIApiPath(["folders", folder.id, "update"]),
			body: { name: record.name, meta: record.metadata },
		} as const;
		const updated = ownerMatches(
			parseOpenWebUIFolderLookup(await this.#transport.sendJson(request), request),
			record.owner_user_id,
		);
		if (updated === undefined)
			throw new OpenWebUIPrincipalScopeError("OpenWebUI folder ownership could not be verified after update.");
		return {
			id: updated.id,
			owner_user_id: record.owner_user_id,
			name: updated.name,
			metadata: updated.metadata,
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
		const chat = await this.getChat(ownerUserId, chatId);
		if (chat === undefined) throw new OpenWebUIPrincipalScopeError("OpenWebUI chat ownership could not be verified.");
		return await this.replaceChatMessagesWithProof(createOpenWebUIOwnerChatProof(chat), messages);
	}
	async replaceChatMessagesWithProof(
		proof: OpenWebUIOwnerChatProof,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		assertOpenWebUIOwnerChatProof(proof, { ownerUserId: proof.ownerUserId, chatId: proof.chatId });
		return await replaceOpenWebUIChatMessages(this.#transport, proof.chatId, messages, proof);
	}

	async getFolder(ownerUserId: string, folderId: string): Promise<OpenWebUIFolderRecord | undefined> {
		const folder = ownerMatches(await this.#getFolderById(folderId), ownerUserId);
		if (folder === undefined) return undefined;
		return { id: folder.id, owner_user_id: ownerUserId, name: folder.name, metadata: folder.metadata };
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

	async deleteFolder(
		ownerUserId: string,
		folderId: string,
		options: { readonly deleteContents: boolean; readonly expectedProjectId?: string },
	): Promise<void> {
		const existing = await this.#getFolderById(folderId);
		if (existing === undefined || ownerMatches(existing, ownerUserId) === undefined) return;
		if (
			options.expectedProjectId !== undefined &&
			adapterProjectId(existing.metadata) !== options.expectedProjectId
		) {
			return;
		}
		const path = `${openWebUIApiPath(["folders", folderId])}?delete_contents=${options.deleteContents ? "true" : "false"}`;
		await this.#transport.sendJson({ method: "DELETE", path }, { missingStatuses: [404] });
	}
	async postMessageEvent(input: PostOpenWebUIMessageEventInput): Promise<void> {
		const request = {
			method: "POST",
			path: openWebUIApiPath(["chats", input.chatId, "messages", input.messageId, "event"]),
			body: input.event,
		} as const;
		let response: unknown;
		try {
			response = await this.#transport.sendJson(request);
		} catch (error) {
			if (error instanceof OpenWebUIHttpError || error instanceof OpenWebUITransportError) throw error;
			throw new OpenWebUIMessageEventResponseError({
				path: request.path,
				detail: "response must be valid JSON boolean true",
			});
		}
		if (response !== true) {
			throw new OpenWebUIMessageEventResponseError({
				path: request.path,
				detail: "response must be JSON boolean true",
			});
		}
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
	async getFileContentWithOwner(
		fileId: string,
	): Promise<(OpenWebUIFileContent & { readonly owner_user_id?: string }) | undefined> {
		const request = {
			method: "GET",
			path: openWebUIApiPath(["files", fileId]),
		} as const;
		const response = await this.#transport.sendJson(request, { missingStatuses: [401, 404] });
		const parsed = response === undefined ? undefined : parseOpenWebUIFileContent(response, request);
		if (parsed === undefined) return undefined;
		const ownerUserId = openWebUIFileOwner(response);
		return ownerUserId === undefined ? parsed : { ...parsed, owner_user_id: ownerUserId };
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

export function createOpenWebUIBootstrapClient(config: OpenWebUIBootstrapClientConfig): OpenWebUIBootstrapClient {
	return new OpenWebUIBootstrapClient(config);
}
export class OpenWebUIBootstrapClient {
	readonly #client: OpenWebUIHttpClient;
	readonly #principalClientFactory: OpenWebUIPrincipalClientFactory;
	readonly #runtimeAdminClientFactory: RuntimeAdminClientFactory;

	constructor(config: OpenWebUIBootstrapClientConfig) {
		this.#client = new OpenWebUIHttpClient(config);
		this.#principalClientFactory = new OpenWebUIPrincipalClientFactory(this.#client, CAPABILITY_CONSTRUCTION_TOKEN);
		this.#runtimeAdminClientFactory = new RuntimeAdminClientFactory(
			this.#client,
			config.ownerUserId,
			CAPABILITY_CONSTRUCTION_TOKEN,
		);
		Object.freeze(this);
	}

	get principalClientFactory(): OpenWebUIPrincipalClientFactory {
		return this.#principalClientFactory;
	}

	get runtimeAdminClientFactory(): RuntimeAdminClientFactory {
		return this.#runtimeAdminClientFactory;
	}
}

export class OpenWebUIPrincipalClientFactory {
	readonly #client: OpenWebUIHttpClient;

	constructor(client: unknown, token: CapabilityConstructionToken) {
		if (token !== CAPABILITY_CONSTRUCTION_TOKEN) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal capability construction is private.");
		}
		this.#client = requireCapabilityClient(client);
		Object.freeze(this);
	}

	create(principal: OpenWebUIPrincipal, context: OpenWebUIPrincipalContext): OpenWebUIPrincipalClient {
		const normalizedPrincipal = normalizeCapabilityPrincipal(principal);
		const normalizedContext = normalizePrincipalCapabilityContext(context);
		if (
			normalizedContext.principal.userId !== normalizedPrincipal.userId ||
			normalizedContext.principal.role !== normalizedPrincipal.role
		) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal context does not match the requested principal.");
		}
		if (normalizedPrincipal.role === "user" && normalizedContext.workspace === undefined) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI normal principal requires a workspace context.");
		}
		return new OpenWebUIPrincipalClient(
			{
				client: this.#client,
				principal: normalizedPrincipal,
				context: normalizedContext,
			},
			CAPABILITY_CONSTRUCTION_TOKEN,
		);
	}

	/** @deprecated Prefer create(principal, context). */
	forPrincipal(principal: OpenWebUIPrincipal, context?: OpenWebUIPrincipalContext): OpenWebUIPrincipalClient {
		const normalizedPrincipal = normalizeCapabilityPrincipal(principal);
		return this.create(
			normalizedPrincipal,
			context ??
				createOpenWebUIPrincipalContext({
					principal: normalizedPrincipal,
					correlationId: "legacy-openwebui-principal",
					...(normalizedPrincipal.role === "user"
						? { workspace: { safeKey: normalizedPrincipal.userId, root: normalizedPrincipal.userId } }
						: {}),
				}),
		);
	}
}

export class RuntimeAdminClientFactory {
	readonly #client: OpenWebUIHttpClient;
	readonly #ownerUserId: string | undefined;

	constructor(client: unknown, ownerUserId: string | undefined, token: CapabilityConstructionToken) {
		if (token !== CAPABILITY_CONSTRUCTION_TOKEN) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI runtime administrator factory construction is private.");
		}
		this.#client = requireCapabilityClient(client);
		this.#ownerUserId = ownerUserId === undefined ? undefined : normalizeOptionalOwnerUserId(ownerUserId);
		Object.freeze(this);
	}

	create(principal: OpenWebUIAdminPrincipal, reason: string): OpenWebUIRuntimeAdminClient {
		const normalizedReason = normalizeCapabilityReason(reason);
		if (this.#ownerUserId === undefined) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI runtime administrator requires the exact configured owner.");
		}
		let admin: OpenWebUIAdminPrincipal;
		try {
			admin = requireOpenWebUIAdminPrincipal(principal, this.#ownerUserId);
		} catch (error) {
			throw new OpenWebUIPrincipalScopeError(error instanceof Error ? error.message : String(error));
		}
		return new OpenWebUIRuntimeAdminClient(this.#client, admin, normalizedReason, CAPABILITY_CONSTRUCTION_TOKEN);
	}

	forAdmin(principal: OpenWebUIAdminPrincipal, reason: string): OpenWebUIRuntimeAdminClient {
		return this.create(principal, reason);
	}
}

export class OpenWebUIRuntimeAdminClient implements OpenWebUIProjectionRepository {
	readonly #client: OpenWebUIHttpClient;
	readonly #principal: OpenWebUIAdminPrincipal;
	readonly #reason: string;

	constructor(
		client: unknown,
		principal: OpenWebUIAdminPrincipal,
		reason: string,
		token: CapabilityConstructionToken,
	) {
		if (token !== CAPABILITY_CONSTRUCTION_TOKEN) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI runtime administrator construction is private.");
		}
		this.#client = requireCapabilityClient(client);
		this.#principal = Object.freeze({ userId: principal.userId, role: "admin" });
		this.#reason = reason;
		Object.freeze(this);
	}

	get principal(): OpenWebUIAdminPrincipal {
		return this.#principal;
	}

	get reason(): string {
		return this.#reason;
	}

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		return await this.#client.upsertFolder(record);
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		return await this.#client.upsertChat(record);
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		return await this.#client.replaceChatMessages(ownerUserId, chatId, messages);
	}

	async getFolder(ownerUserId: string, folderId: string): Promise<OpenWebUIFolderRecord | undefined> {
		return await this.#client.getFolder(ownerUserId, folderId);
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined> {
		return await this.#client.getChat(ownerUserId, chatId);
	}

	async deleteFolder(
		ownerUserId: string,
		folderId: string,
		options: { readonly deleteContents: boolean; readonly expectedProjectId?: string },
	): Promise<void> {
		await this.#client.deleteFolder(ownerUserId, folderId, options);
	}
}
export class OpenWebUIPrincipalClient implements OpenWebUIProjectionRepository {
	readonly #client: OpenWebUIHttpClient;
	readonly #principal: OpenWebUIPrincipal;
	readonly #context: OpenWebUIPrincipalContext;

	constructor(input: unknown, token: CapabilityConstructionToken) {
		if (token !== CAPABILITY_CONSTRUCTION_TOKEN) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal capability construction is private.");
		}
		if (typeof input !== "object" || input === null || Array.isArray(input)) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal capability input is invalid.");
		}
		const capabilityInput = input as {
			readonly client: unknown;
			readonly principal: OpenWebUIPrincipal;
			readonly context?: OpenWebUIPrincipalContext;
		};
		const normalizedPrincipal = normalizeCapabilityPrincipal(capabilityInput.principal);
		this.#client = requireCapabilityClient(capabilityInput.client);
		this.#principal = normalizedPrincipal;
		const normalizedContext =
			capabilityInput.context === undefined
				? createOpenWebUIPrincipalContext({
						principal: normalizedPrincipal,
						correlationId: "legacy-openwebui-principal",
						...(normalizedPrincipal.role === "user"
							? { workspace: { safeKey: normalizedPrincipal.userId, root: normalizedPrincipal.userId } }
							: {}),
					})
				: normalizePrincipalCapabilityContext(capabilityInput.context);
		if (
			normalizedContext.principal.userId !== normalizedPrincipal.userId ||
			normalizedContext.principal.role !== normalizedPrincipal.role
		) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal context does not match the requested principal.");
		}
		this.#context = Object.freeze({ ...normalizedContext, principal: normalizedPrincipal });
		Object.freeze(this);
	}

	get principal(): OpenWebUIPrincipal {
		return this.#principal;
	}
	get context(): OpenWebUIPrincipalContext {
		return this.#context;
	}

	get userId(): string {
		return this.#principal.userId;
	}

	get ownerUserId(): string {
		return this.#principal.userId;
	}

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		requirePrincipalId(record.id, "folder");
		assertPrincipalOwner(this.#principal.userId, record.owner_user_id, "folder");
		assertPrincipalProjectionWriteCapability(this.#principal);
		const stored = await this.#client.upsertFolder(record);
		assertPrincipalOwner(this.#principal.userId, stored.owner_user_id, "folder");
		return stored;
	}

	async getFolder(ownerUserId: string, folderId: string): Promise<OpenWebUIFolderRecord | undefined> {
		assertPrincipalOwner(this.#principal.userId, ownerUserId, "folder");
		requirePrincipalId(folderId, "folder");
		const folder = await this.#client.getFolder(this.#principal.userId, folderId);
		if (folder === undefined) return undefined;
		assertPrincipalOwner(this.#principal.userId, folder.owner_user_id, "folder");
		return folder;
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined>;
	async getChat(chatId: string): Promise<OpenWebUIChatRecord | undefined>;
	async getChat(ownerUserIdOrChatId: string, maybeChatId?: string): Promise<OpenWebUIChatRecord | undefined> {
		const chatId =
			maybeChatId === undefined
				? ownerUserIdOrChatId
				: (() => {
						assertPrincipalOwner(this.#principal.userId, ownerUserIdOrChatId, "chat");
						return maybeChatId;
					})();
		requirePrincipalId(chatId, "chat");
		const chat = await this.#client.getChat(this.#principal.userId, chatId);
		if (chat === undefined) return undefined;
		assertPrincipalOwner(this.#principal.userId, chat.owner_user_id, "chat");
		return chat;
	}
	async deleteFolder(
		ownerUserId: string,
		folderId: string,
		options: { readonly deleteContents: boolean; readonly expectedProjectId?: string },
	): Promise<void> {
		assertPrincipalOwner(this.#principal.userId, ownerUserId, "folder");
		requirePrincipalId(folderId, "folder");
		assertPrincipalProjectionWriteCapability(this.#principal);
		await this.#client.deleteFolder(this.#principal.userId, folderId, options);
	}

	async getChatProof(chatId: string): Promise<OpenWebUIOwnerChatProof | undefined> {
		const chat = await this.getChat(chatId);
		return chat === undefined ? undefined : createOpenWebUIOwnerChatProof(chat);
	}

	async proveChat(chatId: string): Promise<OpenWebUIOwnerChatProof | undefined> {
		return await this.getChatProof(chatId);
	}

	async requireChatProof(chatId: string): Promise<OpenWebUIOwnerChatProof> {
		const proof = await this.getChatProof(chatId);
		if (proof === undefined) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI owner/chat proof could not be established.");
		}
		return proof;
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		requirePrincipalId(record.id, "chat");
		assertPrincipalOwner(this.#principal.userId, record.owner_user_id, "chat");
		assertPrincipalProjectionWriteCapability(this.#principal);
		const stored = await this.#client.upsertChat(record);
		assertPrincipalOwner(this.#principal.userId, stored.owner_user_id, "chat");
		return stored;
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]>;
	async replaceChatMessages(
		proof: OpenWebUIOwnerChatProof,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]>;
	async replaceChatMessages(
		ownerUserIdOrProof: string | OpenWebUIOwnerChatProof,
		chatIdOrMessages: string | readonly OpenWebUIChatMessageRecord[],
		maybeMessages?: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		if (typeof ownerUserIdOrProof === "string") {
			assertPrincipalOwner(this.#principal.userId, ownerUserIdOrProof, "chat");
			if (typeof chatIdOrMessages !== "string" || maybeMessages === undefined || !Array.isArray(maybeMessages))
				throw new OpenWebUIPrincipalScopeError("OpenWebUI projection chat messages are incomplete.");
			const proof = await this.requireChatProof(chatIdOrMessages);
			return await this.replaceChatMessages(proof, maybeMessages);
		}
		if (typeof chatIdOrMessages === "string" || !Array.isArray(chatIdOrMessages))
			throw new OpenWebUIPrincipalScopeError("OpenWebUI projection chat messages are incomplete.");
		const proof = ownerUserIdOrProof;
		assertOpenWebUIOwnerChatProof(proof, { ownerUserId: this.#principal.userId, chatId: proof.chatId });
		for (const message of chatIdOrMessages) {
			if (message.chat_id !== proof.chatId || message.owner_user_id !== this.#principal.userId) {
				throw new OpenWebUIPrincipalScopeError(
					"OpenWebUI message write record does not match the owner/chat proof.",
				);
			}
		}
		assertPrincipalProjectionWriteCapability(this.#principal);
		return await this.#client.replaceChatMessagesWithProof(proof, chatIdOrMessages);
	}

	async replaceMessages(
		proof: OpenWebUIOwnerChatProof,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		return await this.replaceChatMessages(proof, messages);
	}

	async postMessageEvent(
		input: PostOpenWebUIMessageEventInput & { readonly proof: OpenWebUIOwnerChatProof },
	): Promise<void> {
		assertOpenWebUIOwnerChatProof(input.proof, { ownerUserId: this.#principal.userId, chatId: input.chatId });
		requirePrincipalId(input.chatId, "chat");
		requirePrincipalId(input.messageId, "message");
		assertPrincipalProjectionWriteCapability(this.#principal);
		await this.#client.postMessageEvent(input);
	}

	async updateMessageContent(
		input: UpdateOpenWebUIMessageContentInput & { readonly proof: OpenWebUIOwnerChatProof },
	): Promise<void> {
		assertOpenWebUIOwnerChatProof(input.proof, { ownerUserId: this.#principal.userId, chatId: input.chatId });
		requirePrincipalId(input.chatId, "chat");
		requirePrincipalId(input.messageId, "message");
		assertPrincipalProjectionWriteCapability(this.#principal);
		await this.#client.updateMessageContent(input);
	}

	async getFileContent(fileId: string): Promise<OpenWebUIPrincipalFileContent | undefined> {
		requirePrincipalId(fileId, "file");
		const metadata = await this.#client.getFileContentWithOwner(fileId);
		if (metadata === undefined) return undefined;
		return assertPrincipalFileMetadata(this.#principal.userId, fileId, metadata);
	}

	async getFileBytes(fileId: string): Promise<OpenWebUIFileBytes | undefined> {
		requirePrincipalId(fileId, "file");
		const metadata = await this.getFileContent(fileId);
		if (metadata === undefined) return undefined;
		const bytes = await this.#client.getFileBytes(fileId);
		if (bytes !== undefined && bytes.id !== fileId) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal file content ID does not match metadata.");
		}
		return bytes;
	}

	async getFile(fileId: string): Promise<OpenWebUIPrincipalFile | undefined> {
		requirePrincipalId(fileId, "file");
		const metadata = await this.getFileContent(fileId);
		if (metadata === undefined) return undefined;
		const bytes = await this.#client.getFileBytes(fileId);
		if (bytes !== undefined && bytes.id !== fileId) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal file content ID does not match metadata.");
		}
		return {
			metadata,
			...(bytes === undefined ? {} : { bytes, original: bytes }),
		};
	}
}

/** @deprecated Compatibility helper; prefer OpenWebUIPrincipalClientFactory.create. */
export function createOpenWebUIPrincipalClient(
	input: OpenWebUIHttpClient,
	principalOrUserId: OpenWebUIPrincipal | string,
): OpenWebUIPrincipalClient {
	const principal =
		typeof principalOrUserId === "string"
			? { userId: normalizePrincipalUserId(principalOrUserId), role: "user" as const }
			: normalizeCapabilityPrincipal(principalOrUserId);
	return new OpenWebUIPrincipalClient({ client: input, principal }, CAPABILITY_CONSTRUCTION_TOKEN);
}

async function replaceOpenWebUIChatMessages(
	transport: OpenWebUITransport,
	chatId: string,
	messages: readonly OpenWebUIChatMessageRecord[],
	proof?: OpenWebUIOwnerChatProof,
): Promise<readonly OpenWebUIChatMessageRecord[]> {
	if (proof !== undefined) {
		assertOpenWebUIOwnerChatProof(proof, { ownerUserId: proof.ownerUserId, chatId });
		for (const message of messages) {
			if (message.chat_id !== chatId || message.owner_user_id !== proof.ownerUserId) {
				throw new OpenWebUIPrincipalScopeError(
					"OpenWebUI message write record does not match the owner/chat proof.",
				);
			}
		}
	}
	if (proof !== undefined) assertOpenWebUIOwnerChatProof(proof, { ownerUserId: proof.ownerUserId, chatId });
	for (const message of messages) {
		if (proof !== undefined) {
			assertOpenWebUIOwnerChatProof(proof, {
				ownerUserId: proof.ownerUserId,
				chatId,
			});
		}
		await transport.sendJson({
			method: "POST",
			path: openWebUIApiPath(["chats", chatId, "messages", message.id]),
			body: {
				role: message.role,
				content: message.content,
				metadata: message.metadata,
				...(message.created_at === undefined ? {} : { created_at: message.created_at }),
			},
		});
	}
	return messages;
}
function requireCapabilityClient(value: unknown): OpenWebUIHttpClient {
	if (!(value instanceof OpenWebUIHttpClient)) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI capability requires a private OpenWebUI transport client.");
	}
	return value;
}
function normalizeCapabilityPrincipal(principal: OpenWebUIPrincipal): OpenWebUIPrincipal {
	try {
		if (typeof principal !== "object" || principal === null || Array.isArray(principal)) {
			throw new Error("OpenWebUI principal is required.");
		}
		if (typeof principal.userId !== "string" || principal.userId.trim().length === 0) {
			throw new Error("OpenWebUI principal requires a non-empty user ID.");
		}
		if (principal.role !== "admin" && principal.role !== "user") {
			throw new Error("OpenWebUI principal role is invalid.");
		}
		return Object.freeze({ userId: principal.userId.trim(), role: principal.role });
	} catch (error) {
		throw new OpenWebUIPrincipalScopeError(error instanceof Error ? error.message : String(error));
	}
}

function normalizePrincipalCapabilityContext(value: OpenWebUIPrincipalContext): OpenWebUIPrincipalContext {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("OpenWebUI principal context is required.");
		}
		return createOpenWebUIPrincipalContext({
			principal: value.principal,
			correlationId: value.correlationId,
			...(value.workspace === undefined ? {} : { workspace: value.workspace }),
		});
	} catch (error) {
		throw new OpenWebUIPrincipalScopeError(error instanceof Error ? error.message : String(error));
	}
}

function normalizeOptionalOwnerUserId(ownerUserId: string): string {
	if (typeof ownerUserId !== "string" || ownerUserId.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI runtime administrator requires a configured owner.");
	}
	return ownerUserId.trim();
}

function normalizeCapabilityReason(reason: string): string {
	if (typeof reason !== "string" || reason.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI runtime administrator requires an audit reason.");
	}
	return reason.trim();
}
function normalizePrincipalUserId(userId: string): string {
	if (typeof userId !== "string" || userId.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI principal requires a non-empty user ID.");
	}
	return userId.trim();
}

function assertPrincipalOwner(userId: string, ownerUserId: string, resource: string): void {
	if (typeof ownerUserId !== "string" || ownerUserId.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError(`OpenWebUI principal ${resource} requires a non-empty owner.`);
	}
	if (ownerUserId !== userId) {
		throw new OpenWebUIPrincipalScopeError(`OpenWebUI principal cannot access a foreign ${resource} owner.`);
	}
}
function assertPrincipalProjectionWriteCapability(principal: OpenWebUIPrincipal): void {
	if (principal.role === "user") throw new OpenWebUIPrincipalProjectionError();
}

function requirePrincipalId(value: string, resource: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError(`OpenWebUI principal ${resource} requires a non-empty ID.`);
	}
}

function assertPrincipalFileMetadata(
	userId: string,
	fileId: string,
	metadata: OpenWebUIFileContent,
): OpenWebUIPrincipalFileContent {
	if (metadata.id !== fileId) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI principal file metadata ID does not match the requested file.");
	}
	const ownerUserId = fileOwnerUserId(metadata);
	if (ownerUserId === undefined) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI principal file response has no owner proof.");
	}
	if (ownerUserId !== userId) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI principal cannot access a foreign file owner.");
	}
	return { ...metadata, owner_user_id: ownerUserId };
}

function openWebUIFileOwner(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["owner_user_id", "user_id", "ownerUserId"] as const) {
		if (typeof record[key] === "string" && record[key].trim().length > 0) return record[key];
	}
	for (const key of ["data", "meta", "metadata"] as const) {
		const nested = record[key];
		if (typeof nested !== "object" || nested === null || Array.isArray(nested)) continue;
		for (const ownerKey of ["owner_user_id", "user_id", "ownerUserId"] as const) {
			const owner = (nested as Record<string, unknown>)[ownerKey];
			if (typeof owner === "string" && owner.trim().length > 0) return owner;
		}
	}
	return undefined;
}

function fileOwnerUserId(value: OpenWebUIFileContent): string | undefined {
	const owner = (value as OpenWebUIFileContent & { readonly owner_user_id?: unknown }).owner_user_id;
	return typeof owner === "string" && owner.trim().length > 0 ? owner : undefined;
}
