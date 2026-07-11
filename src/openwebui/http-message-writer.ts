import type { OpenWebUIChatMessageRecord } from "./client";
import type { OpenWebUITransport } from "./http-transport";
import { openWebUIApiPath } from "./http-wire";

export async function replaceOpenWebUIChatMessages(
	transport: OpenWebUITransport,
	chatId: string,
	messages: readonly OpenWebUIChatMessageRecord[],
): Promise<readonly OpenWebUIChatMessageRecord[]> {
	for (const message of messages) {
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
