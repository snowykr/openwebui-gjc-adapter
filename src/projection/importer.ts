import type {
	OpenWebUIChatMessageRecord,
	OpenWebUIChatRecord,
	OpenWebUIMetadata,
	OpenWebUIProjectionRepository,
} from "../openwebui/client";
import { OPENWEBUI_METADATA_NAMESPACE } from "../openwebui/persistence-contract";

export interface ProjectedProjectReference {
	id: string;
	name: string;
	metadata?: OpenWebUIMetadata;
}

export interface ProjectedChatMessage {
	id: string;
	role: string;
	content: string;
	created_at?: string;
	timestamp?: number;
	parentId?: string | null;
	childrenIds?: readonly string[];
	metadata?: OpenWebUIMetadata;
}

export interface ProjectedChatHistory {
	messages: Record<string, ProjectedChatMessage>;
	currentId: string | null;
}

export interface ProjectedChat {
	id: string;
	title?: string;
	created_at?: string;
	updated_at?: string;
	metadata?: OpenWebUIMetadata;
	messages?: readonly ProjectedChatMessage[];
	history?: ProjectedChatHistory;
}

export interface ImportProjectedSessionInput {
	repository: OpenWebUIProjectionRepository;
	ownerUserId: string;
	project: ProjectedProjectReference;
	projectedChat: ProjectedChat;
}

export interface ImportProjectedSessionResult {
	folderId: string;
	chatId: string;
	messageIds: readonly string[];
}

const folderIdForProject = (projectId: string): string => `gjc-project-${projectId}`;
const chatIdForSession = (sessionId: string): string => `gjc-session-${sessionId}`;
const messageIdForProjectedMessage = (sessionId: string, messageId: string): string =>
	`gjc-session-${sessionId}-message-${messageId}`;

const mergeProjectedMetadata = (
	metadata: OpenWebUIMetadata | undefined,
	operationId: string,
	ownerUserId: string,
	projectId: string,
	sessionId: string,
): OpenWebUIMetadata => ({
	...(metadata ?? {}),
	[OPENWEBUI_METADATA_NAMESPACE]: {
		...((metadata?.[OPENWEBUI_METADATA_NAMESPACE] as OpenWebUIMetadata | undefined) ?? {}),
		operation_id: operationId,
		owner_user_id: ownerUserId,
		project_id: projectId,
		session_id: sessionId,
	},
});

const projectedMessages = (projectedChat: ProjectedChat): readonly ProjectedChatMessage[] => {
	if (projectedChat.messages !== undefined) return projectedChat.messages;
	if (projectedChat.history !== undefined) return Object.values(projectedChat.history.messages);
	return [];
};

const createdAtForMessage = (message: ProjectedChatMessage): string | undefined => {
	if (message.created_at !== undefined) return message.created_at;
	if (message.timestamp !== undefined) return new Date(message.timestamp).toISOString();
	return undefined;
};

const projectedMessageKey = (projectedChat: ProjectedChat, messageId: string): string =>
	messageIdForProjectedMessage(projectedChat.id, messageId);

const chatHistoryForProjectedChat = (projectedChat: ProjectedChat, messages: readonly OpenWebUIChatMessageRecord[]) => {
	if (projectedChat.history === undefined) {
		return {
			currentId: messages.at(-1)?.id ?? null,
			messages: Object.fromEntries(messages.map(message => [message.id, { ...message }])),
		};
	}

	return {
		currentId:
			projectedChat.history.currentId === null
				? null
				: projectedMessageKey(projectedChat, projectedChat.history.currentId),
		messages: Object.fromEntries(
			Object.values(projectedChat.history.messages).map(message => {
				const id = projectedMessageKey(projectedChat, message.id);
				const mirrored = messages.find(candidate => candidate.id === id);
				return [
					id,
					{
						...mirrored,
						id,
						chat_id: chatIdForSession(projectedChat.id),
						owner_user_id: mirrored?.owner_user_id ?? "",
						role: message.role,
						content: message.content,
						created_at: createdAtForMessage(message),
						metadata:
							mirrored?.metadata ??
							mergeProjectedMetadata(message.metadata, "upsert-chat-message", "", "", projectedChat.id),
						parentId:
							message.parentId === undefined || message.parentId === null
								? message.parentId
								: projectedMessageKey(projectedChat, message.parentId),
						childrenIds: message.childrenIds?.map(childId => projectedMessageKey(projectedChat, childId)),
					},
				];
			}),
		),
	};
};

export const importProjectedSession = async ({
	repository,
	ownerUserId,
	project,
	projectedChat,
}: ImportProjectedSessionInput): Promise<ImportProjectedSessionResult> => {
	const folderId = folderIdForProject(project.id);
	const chatId = chatIdForSession(projectedChat.id);

	await repository.upsertFolder({
		id: folderId,
		owner_user_id: ownerUserId,
		name: project.name,
		metadata: mergeProjectedMetadata(project.metadata, "upsert-folder", ownerUserId, project.id, projectedChat.id),
	});

	const messages = projectedMessages(projectedChat).map<OpenWebUIChatMessageRecord>((message, index) => {
		const openwebuiMessageId = messageIdForProjectedMessage(projectedChat.id, message.id);
		return {
			id: openwebuiMessageId,
			chat_id: chatId,
			owner_user_id: ownerUserId,
			role: message.role,
			content: message.content,
			created_at: createdAtForMessage(message),
			metadata: mergeProjectedMetadata(
				{
					...(message.metadata ?? {}),
					gjc_adapter: {
						...((message.metadata?.gjc_adapter as OpenWebUIMetadata | undefined) ?? {}),
						ownerUserId,
						projectId: project.id,
						gjcSessionId: projectedChat.id,
						gjcEntryId: message.id,
						openwebuiMessageId,
						projected_message_id: message.id,
					},
				},
				`upsert-chat-message-${index}`,
				ownerUserId,
				project.id,
				projectedChat.id,
			),
		};
	});

	const chat: OpenWebUIChatRecord = {
		id: chatId,
		owner_user_id: ownerUserId,
		folder_id: folderId,
		title: projectedChat.title ?? projectedChat.id,
		created_at: projectedChat.created_at,
		updated_at: projectedChat.updated_at,
		metadata: mergeProjectedMetadata(
			projectedChat.metadata,
			"upsert-chat",
			ownerUserId,
			project.id,
			projectedChat.id,
		),
		history: chatHistoryForProjectedChat(projectedChat, messages),
	};

	await repository.upsertChat(chat);
	const storedMessages = await repository.replaceChatMessages(ownerUserId, chatId, messages);

	return {
		folderId,
		chatId,
		messageIds: storedMessages.map(message => message.id),
	};
};
