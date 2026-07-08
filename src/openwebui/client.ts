import { OPENWEBUI_METADATA_NAMESPACE } from "./persistence-contract";

export type { OpenWebUIHttpClientConfig, PostOpenWebUIMessageEventInput } from "./http-client";
export {
	OpenWebUIHttpClient,
	OpenWebUIHttpConfigurationError,
	OpenWebUIHttpError,
	OpenWebUITransportError,
} from "./http-client";
export { OpenWebUIInvalidResponseError } from "./http-parsers";

export interface OpenWebUIAdapterMetadata {
	operation_id: string;
	owner_user_id: string;
	project_id: string;
	session_id: string;
	[source: string]: string | number | boolean | null | undefined;
}

export type OpenWebUIMetadata = Record<string, unknown>;

export interface OpenWebUIFolderRecord {
	id: string;
	owner_user_id: string;
	name: string;
	metadata: OpenWebUIMetadata;
}

export interface OpenWebUIChatMessageRecord {
	id: string;
	chat_id: string;
	owner_user_id: string;
	role: string;
	content: string;
	metadata: OpenWebUIMetadata;
	created_at?: string;
}

export interface OpenWebUIChatHistoryMessageRecord extends OpenWebUIChatMessageRecord {
	parentId?: string | null;
	childrenIds?: readonly string[];
}

export interface OpenWebUIChatHistoryRecord {
	messages: Record<string, OpenWebUIChatHistoryMessageRecord>;
	currentId: string | null;
}

export interface OpenWebUIChatRecord {
	id: string;
	owner_user_id: string;
	folder_id: string;
	title: string;
	metadata: OpenWebUIMetadata;
	history: OpenWebUIChatHistoryRecord;
	rating?: number | null;
	created_at?: string;
	updated_at?: string;
}

export interface OpenWebUIProjectionRepository {
	upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord>;
	upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord>;
	replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]>;
	getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined>;
}

const mergeMetadata = (existing: OpenWebUIMetadata, next: OpenWebUIMetadata): OpenWebUIMetadata => ({
	...existing,
	...next,
	[OPENWEBUI_METADATA_NAMESPACE]: {
		...((existing[OPENWEBUI_METADATA_NAMESPACE] as OpenWebUIMetadata | undefined) ?? {}),
		...((next[OPENWEBUI_METADATA_NAMESPACE] as OpenWebUIMetadata | undefined) ?? {}),
	},
});

const mergeAdapterMetadata = (existing: OpenWebUIMetadata, next: OpenWebUIMetadata): OpenWebUIMetadata => ({
	...next,
	...existing,
	[OPENWEBUI_METADATA_NAMESPACE]: {
		...((existing[OPENWEBUI_METADATA_NAMESPACE] as OpenWebUIMetadata | undefined) ?? {}),
		...((next[OPENWEBUI_METADATA_NAMESPACE] as OpenWebUIMetadata | undefined) ?? {}),
	},
});

const hasAdapterMetadata = (metadata: OpenWebUIMetadata): boolean => "gjc_adapter" in metadata;

const cloneFolder = (record: OpenWebUIFolderRecord): OpenWebUIFolderRecord => ({
	...record,
	metadata: { ...record.metadata },
});

const cloneMessage = (record: OpenWebUIChatMessageRecord): OpenWebUIChatMessageRecord => ({
	...record,
	metadata: { ...record.metadata },
});

const cloneChatHistoryMessage = (record: OpenWebUIChatHistoryMessageRecord): OpenWebUIChatHistoryMessageRecord => ({
	...cloneMessage(record),
	parentId: record.parentId,
	childrenIds: record.childrenIds === undefined ? undefined : [...record.childrenIds],
});

const cloneHistory = (history: OpenWebUIChatHistoryRecord): OpenWebUIChatHistoryRecord => ({
	currentId: history.currentId,
	messages: Object.fromEntries(
		Object.entries(history.messages).map(([id, message]) => [id, cloneChatHistoryMessage(message)]),
	),
});

const cloneChat = (record: OpenWebUIChatRecord): OpenWebUIChatRecord => ({
	...record,
	metadata: { ...record.metadata },
	history: cloneHistory(record.history),
});

export class InMemoryOpenWebUIProjectionRepository implements OpenWebUIProjectionRepository {
	#folders = new Map<string, OpenWebUIFolderRecord>();
	#chats = new Map<string, OpenWebUIChatRecord>();
	#messagesByChatId = new Map<string, Map<string, OpenWebUIChatMessageRecord>>();

	async upsertFolder(record: OpenWebUIFolderRecord): Promise<OpenWebUIFolderRecord> {
		const key = this.#ownerScopedKey(record.owner_user_id, record.id);
		const existing = this.#folders.get(key);
		const stored: OpenWebUIFolderRecord = existing
			? {
					...existing,
					...record,
					metadata: mergeMetadata(existing.metadata, record.metadata),
				}
			: cloneFolder(record);

		this.#folders.set(key, stored);
		return cloneFolder(stored);
	}

	async upsertChat(record: OpenWebUIChatRecord): Promise<OpenWebUIChatRecord> {
		const key = this.#ownerScopedKey(record.owner_user_id, record.id);
		const existing = this.#chats.get(key);
		const preserveUserFields = existing !== undefined && hasAdapterMetadata(record.metadata);
		const stored: OpenWebUIChatRecord = existing
			? {
					...existing,
					...record,
					title: preserveUserFields ? existing.title : record.title,
					rating: preserveUserFields ? existing.rating : record.rating,
					metadata: preserveUserFields
						? mergeAdapterMetadata(existing.metadata, record.metadata)
						: mergeMetadata(existing.metadata, record.metadata),
					history: cloneHistory(record.history),
				}
			: cloneChat(record);

		this.#chats.set(key, stored);
		return cloneChat(stored);
	}

	async replaceChatMessages(
		ownerUserId: string,
		chatId: string,
		messages: readonly OpenWebUIChatMessageRecord[],
	): Promise<readonly OpenWebUIChatMessageRecord[]> {
		const messageSetKey = this.#ownerScopedKey(ownerUserId, chatId);
		let storedMessages = this.#messagesByChatId.get(messageSetKey);
		if (!storedMessages) {
			storedMessages = new Map<string, OpenWebUIChatMessageRecord>();
			this.#messagesByChatId.set(messageSetKey, storedMessages);
		}

		storedMessages.clear();

		for (const message of messages) {
			storedMessages.set(message.id, cloneMessage(message));
		}

		return Array.from(storedMessages.values()).map(cloneMessage);
	}

	async getChat(ownerUserId: string, chatId: string): Promise<OpenWebUIChatRecord | undefined> {
		const chat = this.#chats.get(this.#ownerScopedKey(ownerUserId, chatId));
		return chat ? cloneChat(chat) : undefined;
	}

	#ownerScopedKey(ownerUserId: string, id: string): string {
		return `${ownerUserId}:${id}`;
	}
}
