import { describe, expect, test } from "bun:test";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import { OPENWEBUI_METADATA_NAMESPACE } from "../src/openwebui/persistence-contract";
import { importProjectedSession } from "../src/projection/importer";

const project = {
	id: "project-1",
	name: "Project One",
	metadata: { color: "blue" },
};
const projectedChat = {
	id: "session-1",
	title: "GJC Session",
	metadata: { pinned: true },
	messages: [
		{ id: "m1", role: "user", content: "Hello", metadata: { source: "human" } },
		{ id: "m2", role: "assistant", content: "Hi", metadata: { source: "gjc" } },
	],
};

describe("importProjectedSession", () => {
	test("creates owner-scoped folder, chat, and one chat_message mirror per projected message", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const result = await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project,
			projectedChat,
		});
		const chat = await repository.getChat("owner-1", result.chatId);

		expect(result).toEqual({
			folderId: "gjc-project-project-1",
			chatId: "gjc-session-session-1",
			messageIds: ["gjc-session-session-1-message-m1", "gjc-session-session-1-message-m2"],
		});
		expect(chat).toMatchObject({
			owner_user_id: "owner-1",
			folder_id: "gjc-project-project-1",
			title: "GJC Session",
			metadata: {
				pinned: true,
				[OPENWEBUI_METADATA_NAMESPACE]: {
					operation_id: "upsert-chat",
					owner_user_id: "owner-1",
					project_id: "project-1",
					session_id: "session-1",
				},
			},
		});
		expect(Object.keys(chat?.history.messages ?? {})).toEqual([
			"gjc-session-session-1-message-m1",
			"gjc-session-session-1-message-m2",
		]);
		expect(chat?.history.currentId).toBe("gjc-session-session-1-message-m2");
		expect(Object.values(chat?.history.messages ?? {}).map(message => message.content)).toEqual(["Hello", "Hi"]);
		expect(chat?.history.messages["gjc-session-session-1-message-m1"]?.metadata).toMatchObject({
			source: "human",
			[OPENWEBUI_METADATA_NAMESPACE]: {
				operation_id: "upsert-chat-message-0",
				projected_message_id: "m1",
			},
		});
	});

	test("is idempotent on reimport and preserves user metadata outside gjc_adapter", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();

		const first = await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project,
			projectedChat,
		});
		await repository.upsertChat({
			id: first.chatId,
			owner_user_id: "owner-1",
			folder_id: first.folderId,
			title: "User title",
			rating: 4,
			metadata: { user_label: "important" },
			history: { messages: {}, currentId: null },
		});

		const second = await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project,
			projectedChat,
		});
		const chat = await repository.getChat("owner-1", first.chatId);

		expect(second).toEqual(first);
		expect(Object.keys(chat?.history.messages ?? {})).toHaveLength(2);
		expect(new Set(Object.keys(chat?.history.messages ?? {})).size).toBe(2);
		expect(chat).toMatchObject({
			title: "User title",
			rating: 4,
			metadata: {
				user_label: "important",
				[OPENWEBUI_METADATA_NAMESPACE]: { operation_id: "upsert-chat" },
			},
		});
	});

	test("preserves branched history tree metadata and removes stale mirror rows on reimport", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const branchedChat = {
			id: "session-tree",
			title: "Tree",
			metadata: {
				gjc_adapter: { lineageHash: "chat-lineage", projectionVersion: 7 },
				openwebui_label: "keep",
			},
			history: {
				currentId: "a2",
				messages: {
					root: {
						id: "root",
						role: "user",
						content: "Root",
						childrenIds: ["a1", "a2"],
						metadata: { gjc_adapter: { lineageHash: "root-lineage", gjcEntryId: "entry-root" } },
					},
					a1: {
						id: "a1",
						role: "assistant",
						content: "Branch one",
						parentId: "root",
						childrenIds: [],
						metadata: { gjc_adapter: { lineageHash: "a1-lineage", gjcEntryId: "entry-a1" } },
					},
					a2: {
						id: "a2",
						role: "assistant",
						content: "Branch two",
						parentId: "root",
						childrenIds: [],
						metadata: { gjc_adapter: { lineageHash: "a2-lineage", gjcEntryId: "entry-a2" } },
					},
				},
			},
		};

		const first = await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project,
			projectedChat: branchedChat,
		});
		await repository.upsertChat({
			id: first.chatId,
			owner_user_id: "owner-1",
			folder_id: first.folderId,
			title: "User title",
			rating: 5,
			metadata: { openwebui_label: "user label" },
			history: (await repository.getChat("owner-1", first.chatId))?.history ?? { messages: {}, currentId: null },
		});

		const second = await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project,
			projectedChat: {
				...branchedChat,
				title: "Adapter title",
				history: {
					currentId: "a2",
					messages: {
						root: { ...branchedChat.history.messages.root, childrenIds: ["a2"] },
						a2: { ...branchedChat.history.messages.a2, parentId: "root" },
					},
				},
			},
		});
		const chat = await repository.getChat("owner-1", first.chatId);

		expect(second.messageIds).toEqual([
			"gjc-session-session-tree-message-root",
			"gjc-session-session-tree-message-a2",
		]);
		expect(chat?.title).toBe("User title");
		expect(chat?.rating).toBe(5);
		expect(chat?.metadata).toMatchObject({
			openwebui_label: "user label",
			gjc_adapter: {
				owner_user_id: "owner-1",
				lineageHash: "chat-lineage",
				projectionVersion: 7,
				operation_id: "upsert-chat",
			},
		});
		expect(chat?.history.currentId).toBe("gjc-session-session-tree-message-a2");
		expect(chat?.history.messages["gjc-session-session-tree-message-root"]?.childrenIds).toEqual([
			"gjc-session-session-tree-message-a2",
		]);
		expect(chat?.history.messages["gjc-session-session-tree-message-a2"]?.parentId).toBe(
			"gjc-session-session-tree-message-root",
		);
		expect(chat?.history.messages["gjc-session-session-tree-message-a2"]?.metadata.gjc_adapter).toMatchObject({
			lineageHash: "a2-lineage",
			gjcEntryId: "a2",
			openwebuiMessageId: "gjc-session-session-tree-message-a2",
			ownerUserId: "owner-1",
			projectId: "project-1",
			operation_id: "upsert-chat-message-1",
		});
		expect(chat?.history.messages["gjc-session-session-tree-message-a1"]).toBeUndefined();
	});

	test("drops stale OpenWebUI status history fields during historical reimport", async () => {
		const repository = new InMemoryOpenWebUIProjectionRepository();
		const contaminatedMessage = {
			id: "m1",
			role: "assistant",
			content: "Clean content",
			statusHistory: [
				{
					gjc_adapter: {
						metadata: {
							text: "/home/snowy/coding/private prompt",
						},
					},
				},
			],
		};
		const historicalChat = {
			id: "session-cleanup",
			title: "Cleanup",
			history: {
				currentId: "m1",
				messages: {
					m1: contaminatedMessage,
				},
			},
		};

		await importProjectedSession({
			repository,
			ownerUserId: "owner-1",
			project,
			projectedChat: historicalChat,
		});
		const chat = await repository.getChat("owner-1", "gjc-session-session-cleanup");

		expect(JSON.stringify(chat?.history.messages)).not.toContain("statusHistory");
		expect(JSON.stringify(chat?.history.messages)).not.toContain("/home/snowy/coding/private prompt");
	});
});
