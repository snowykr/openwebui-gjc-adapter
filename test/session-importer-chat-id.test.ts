import { describe, expect, test } from "bun:test";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { importProjectedSession } from "../src/projection/importer";

describe("importProjectedSession assigned OpenWebUI chat ids", () => {
	test("normalizes history message chat ids when OpenWebUI assigns a different chat id", async () => {
		const repository = new AssigningChatIdRepository("openwebui-chat-uuid");

		const result = await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project: { id: "project-1", name: "Project One" },
			projectedChat: {
				id: "session-1",
				title: "GJC Session",
				messages: [
					{ id: "m1", role: "user", content: "Hello" },
					{ id: "m2", role: "assistant", content: "Hi" },
				],
			},
		});
		const chat = await repository.getChat("owner-1", result.chatId);

		expect(result.chatId).toBe("openwebui-chat-uuid");
		expect(Object.values(chat?.history.messages ?? {}).map(message => message.chat_id)).toEqual([
			"openwebui-chat-uuid",
			"openwebui-chat-uuid",
		]);
	});
});

class AssigningChatIdRepository extends InMemoryOpenWebUIProjectionRepository {
	readonly #chatId: string;
	#assigned = false;

	constructor(chatId: string) {
		super();
		this.#chatId = chatId;
	}

	override async upsertChat(record: Parameters<InMemoryOpenWebUIProjectionRepository["upsertChat"]>[0]) {
		if (this.#assigned) return await super.upsertChat(record);
		this.#assigned = true;
		return await super.upsertChat({ ...record, id: this.#chatId });
	}
}
