import { describe, expect, test } from "bun:test";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { baseChat } from "./openwebui-test-fixtures";

describe("InMemoryOpenWebUIProjectionRepository", () => {
	test("scopes folders and chats by owner id", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();

		await repository.upsertFolder({
			id: "folder-1",
			owner_user_id: "owner-1",
			name: "Owner 1 folder",
			metadata: {},
		});
		await repository.upsertFolder({
			id: "folder-1",
			owner_user_id: "owner-2",
			name: "Owner 2 folder",
			metadata: {},
		});
		await repository.upsertChat(baseChat);
		await repository.upsertChat({ ...baseChat, owner_user_id: "owner-2", title: "Other owner title" });

		expect(await repository.getChat("owner-1", "chat-1")).toMatchObject({
			owner_user_id: "owner-1",
			title: "Adapter title",
		});
		expect(await repository.getChat("owner-2", "chat-1")).toMatchObject({
			owner_user_id: "owner-2",
			title: "Other owner title",
		});
		expect(await repository.getChat("owner-3", "chat-1")).toBeUndefined();
	});

	test("preserves non-adapter chat metadata, rating, and title on adapter upsert", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();

		await repository.upsertChat({
			...baseChat,
			title: "User renamed title",
			rating: 5,
			metadata: {
				user_note: "keep me",
				gjc_adapter: { operation_id: "old", sessionFile: "/tmp/stale-session.jsonl" },
			},
		});
		await repository.upsertChat({
			...baseChat,
			title: "Adapter replacement title",
			rating: 1,
			metadata: { gjc_adapter: { operation_id: "new" } },
		});

		expect(await repository.getChat("owner-1", "chat-1")).toMatchObject({
			title: "User renamed title",
			rating: 5,
			metadata: {
				user_note: "keep me",
				gjc_adapter: { operation_id: "new" },
			},
		});
		expect(await repository.getChat("owner-1", "chat-1")).not.toMatchObject({
			metadata: { gjc_adapter: { sessionFile: "/tmp/stale-session.jsonl" } },
		});
	});
});
