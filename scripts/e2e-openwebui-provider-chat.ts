import { describeJson, type E2EContext, type HttpJson, isRecord, type JsonRecord } from "./e2e-real-openwebui-support";

export interface ProviderChatIds {
	readonly chatId: string;
	readonly userMessageId: string;
	readonly assistantMessageId: string;
	readonly title: string;
	readonly userContent: string;
}

export type ProviderChatPayload = JsonRecord & {
	readonly model: string;
};

export async function providerChatThroughOpenWebUI(
	ctx: E2EContext,
	payload: ProviderChatPayload,
	ids: ProviderChatIds,
): Promise<HttpJson> {
	const timestamp = Math.floor(Date.now() / 1000);
	const createChatPayload = {
		chat: {
			id: "",
			title: ids.title,
			models: [payload.model],
			params: {},
			history: {
				messages: {
					[ids.userMessageId]: {
						id: ids.userMessageId,
						parentId: null,
						childrenIds: [ids.assistantMessageId],
						role: "user",
						content: ids.userContent,
						timestamp,
						models: [payload.model],
					},
					[ids.assistantMessageId]: {
						id: ids.assistantMessageId,
						parentId: ids.userMessageId,
						childrenIds: [],
						role: "assistant",
						content: "",
						model: payload.model,
						timestamp,
					},
				},
				currentId: ids.assistantMessageId,
			},
			messages: [],
			tags: [],
			timestamp,
		},
	};
	await ctx.writeJson(`${ids.chatId}-create-chat-request.json`, createChatPayload);
	const created = await ctx.postJson(
		`${ctx.config.openWebUIBaseUrl}/api/v1/chats/new`,
		ctx.openWebUIHeaders(),
		createChatPayload,
	);
	await ctx.writeJson(`${ids.chatId}-create-chat-response.json`, created.body);
	if (created.status !== 200 || !isRecord(created.body) || typeof created.body.id !== "string") {
		throw new Error(`OpenWebUI chat creation failed (${created.status}): ${describeJson(created.body)}`);
	}
	return await ctx.postJson(
		`${ctx.config.adapterBaseUrl}/v1/chat/completions`,
		ctx.adapterHeaders({
			...ctx.openWebUIForwardHeaders(),
			"x-openwebui-chat-id": created.body.id,
			"x-openwebui-message-id": ids.assistantMessageId,
			"x-openwebui-session-id": created.body.id,
			"x-openwebui-user-message-id": ids.userMessageId,
			"x-openwebui-user-message-parent-id": "",
		}),
		payload,
		180_000,
	);
}
