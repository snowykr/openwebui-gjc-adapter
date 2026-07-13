import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBranchRegenerateAction } from "../src/branches/regenerate";
import { FileBackedSessionMappingStore } from "../src/gjc/session-router";
import { handleChatCompletions } from "../src/live/chat-completions";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { buildModelList } from "../src/live/models";
import { InMemoryOpenWebUIProjectionRepository } from "../src/openwebui/client";
import {
	buildOpenWebUICitationEvent,
	buildOpenWebUIFilesEvent,
	buildOpenWebUISourceEvent,
} from "../src/openwebui/events";
import { OPENWEBUI_METADATA_NAMESPACE } from "../src/openwebui/persistence-contract";
import { projectArtifactRef } from "../src/projection/artifacts";
import { projectGjcSessionToOpenWebUIChat } from "../src/projection/chat-tree";
import { projectAgentFrame } from "../src/projection/events";
import { importProjectedSession } from "../src/projection/importer";
import {
	projectPendingWorkflowGateMessage,
	resolveWorkflowGateAnswer,
	WorkflowGateStore,
} from "../src/projection/workflow-gates";
import { registerProjectDirectory } from "../src/projects/registry";
import { resolveAllowedRoots } from "../src/security/paths";
import { FileBackedOutboxStore } from "../src/state/outbox";
import { reconcilePendingOperations } from "../src/state/reconciler";
import {
	createdAt,
	deliveredEvents,
	failGate,
	GoldenTurnRunner,
	goldenEntries,
	goldenHeader,
	liveHeaders,
	ownerUserId,
	sseInput,
} from "./golden-fixture-fixtures";
import * as selectionFixture from "./model-selection-fixtures";

describe("GJC-primary OpenWebUI golden MVP fixture", () => {
	test("projects historical sessions, live events, gates, artifacts, routing, crash repair, and safe lineage", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "openwebui-gjc-golden-")));
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const artifactPath = join(cwd, "artifacts", "report.txt");
		mkdirSync(join(cwd, "artifacts"), { recursive: true });
		writeFileSync(artifactPath, "audit report");
		const escapeDir = realpathSync(mkdtempSync(join(tmpdir(), "openwebui-gjc-escape-")));
		const escapeFile = join(escapeDir, "secret.txt");
		writeFileSync(escapeFile, "secret");
		const escapeLink = join(cwd, "artifacts", "escape-link.txt");
		symlinkSync(escapeFile, escapeLink);
		const sessionFile = join(cwd, ".gjc", "sessions", "session-golden.jsonl");
		mkdirSync(join(cwd, ".gjc", "sessions"), { recursive: true });
		const originalJsonl = '{"type":"session","id":"session-golden"}\n';
		writeFileSync(sessionFile, originalJsonl);

		const allowedRoots = await resolveAllowedRoots([root]);
		const project = await registerProjectDirectory({ cwd, name: "Golden" }, allowedRoots, createdAt);
		expect(
			buildModelList([
				selectionFixture.LOW_SELECTION,
				selectionFixture.MEDIUM_SELECTION,
				selectionFixture.OFF_SELECTION,
			]).data.map(model => model.id),
		).toEqual([...selectionFixture.CANONICAL_MODEL_IDS]);

		const header = goldenHeader(cwd);
		const entries = goldenEntries();
		const projected = projectGjcSessionToOpenWebUIChat({ sessionFile, header, entries });
		expect(projected.history.currentId).toBe("u-leaf");
		expect(projected.history.messages["u-root"]?.childrenIds).toEqual(["a-left", "a-right"]);
		expect(projected.history.messages["u-leaf"]?.parentId).toBe("a-right");
		expect(projected.metadata.gjc_adapter.nonMessageEntryCount).toBe(3);

		const repository = new InMemoryOpenWebUIProjectionRepository();
		const firstImport = await importProjectedSession({ repository, ownerUserId, project, projectedChat: projected });
		expect(firstImport.folderId).toBe("gjc-project-golden");
		expect(firstImport.messageIds).toContain("gjc-session-session-golden-message-u-leaf");
		const chatId = firstImport.chatId;
		const existingChat = await repository.getChat(ownerUserId, chatId);
		if (existingChat === undefined) throw new Error("expected imported chat");
		await repository.upsertChat({ ...existingChat, title: "Operator title", rating: 5, metadata: {} });
		await repository.replaceChatMessages(ownerUserId, chatId, [
			...firstImport.messageIds.map(id => ({
				id,
				chat_id: chatId,
				owner_user_id: ownerUserId,
				role: "assistant",
				content: id,
				metadata: {},
			})),
			{
				id: "stale-message",
				chat_id: chatId,
				owner_user_id: ownerUserId,
				role: "assistant",
				content: "stale",
				metadata: {},
			},
		]);
		const secondImport = await importProjectedSession({ repository, ownerUserId, project, projectedChat: projected });
		const reimportedChat = await repository.getChat(ownerUserId, chatId);
		if (reimportedChat === undefined) throw new Error("expected reimported chat");
		expect(secondImport.messageIds).not.toContain("stale-message");
		expect(reimportedChat.title).toBe("Operator title");
		expect(reimportedChat.rating).toBe(5);
		expect((reimportedChat.metadata[OPENWEBUI_METADATA_NAMESPACE] as Record<string, unknown>).session_id).toBe(
			"session-golden",
		);
		const importedLeafMessageId = "gjc-session-session-golden-message-u-leaf";
		const importedLeafMetadata = reimportedChat.history.messages[importedLeafMessageId]?.metadata;
		expect(importedLeafMetadata?.gjc_adapter).toMatchObject({
			ownerUserId,
			projectId: project.id,
			gjcSessionId: "session-golden",
			gjcEntryId: "u-leaf",
			openwebuiMessageId: importedLeafMessageId,
		});

		const toolEvent = projectAgentFrame({ kind: "tool_progress", label: "Reading fixture", phase: "end" }, sseInput);
		const source = buildOpenWebUISourceEvent({ document: ["source"], metadata: { sessionId: "session-golden" } });
		const citation = buildOpenWebUICitationEvent({ source: { name: "fixture" }, metadata: { line: 1 } });
		const artifactRef = await projectArtifactRef({ path: artifactPath, allowedRoots, label: "report.txt" });
		const files = buildOpenWebUIFilesEvent([artifactRef]);
		expect(toolEvent.events[0]).toMatchObject({ type: "status", data: { done: true } });
		expect(source.type).toBe("source");
		expect(citation.type).toBe("citation");
		expect(files.data.files[0]?.metadata?.gjc_adapter).toMatchObject({ artifactName: "report.txt" });
		await expect(projectArtifactRef({ path: escapeLink, allowedRoots, label: "escape" })).rejects.toThrow(
			"outside allowed artifact roots",
		);

		const gateStore = new WorkflowGateStore();
		gateStore.add({
			gateId: "gate-1",
			idempotencyKey: "gate-1",
			schemaHash: "sha256:gate",
			boundUserMessageId: null,
			status: "pending",
			schema: { type: "string", enum: ["approve", "reject"] },
		});
		expect(projectPendingWorkflowGateMessage(gateStore.pending()[0] ?? failGate())).toContain(
			"GJC workflow gate pending",
		);
		expect(resolveWorkflowGateAnswer({ store: gateStore, answer: "approve", userMessageId: "u-gate" })).toMatchObject(
			{ status: "accepted" },
		);

		const outboxPath = join(root, "outbox.json");
		const outbox = new FileBackedOutboxStore(outboxPath);
		outbox.enqueue({
			operationId: "op-crash",
			ownerUserId,
			projectId: project.id,
			chatId,
			kind: "chat",
			payloadHash: "hash",
			now: createdAt,
		});
		outbox.markApplying("op-crash");
		const crashRepair = await reconcilePendingOperations(outbox, () => undefined);
		expect(crashRepair.applied.map(operation => operation.operationId)).toEqual(["op-crash"]);
		expect(outbox.get("op-crash")?.attempts).toBe(2);

		const turnRunner = new GoldenTurnRunner(sessionFile);
		const mappings = new FileBackedSessionMappingStore(join(root, "mappings.json"));
		const liveRunner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			outbox,
			ownerUserId,
			modelReaderFactory: selectionFixture.staticModelReaderFactory(),
		});
		await repository.upsertChat({
			id: "chat-live",
			owner_user_id: ownerUserId,
			folder_id: firstImport.folderId,
			title: "Live Golden",
			metadata: {},
			history: { currentId: null, messages: {} },
		});
		const firstLive = await handleChatCompletions({
			request: { model: "gjc", messages: [{ role: "user", content: "start" }] },
			headers: liveHeaders("chat-live", "assistant-1", "user-1", null),
			projects: [project],
			projectContextRepository: repository,
			owner: { ownerUserId, singleOwnerLocalMode: false },
			runner: liveRunner,
			eventSink(event) {
				deliveredEvents.push(event);
			},
		});
		expect(firstLive.ok).toBe(true);
		const continued = await handleChatCompletions({
			request: { model: "gjc", messages: [{ role: "user", content: "continue" }] },
			headers: liveHeaders("chat-live", "assistant-2", "user-2", "user-1"),
			projects: [project],
			projectContextRepository: repository,
			owner: { ownerUserId, singleOwnerLocalMode: false },
			runner: liveRunner,
			eventSink(event) {
				deliveredEvents.push(event);
			},
		});
		expect(continued.ok).toBe(true);
		expect(turnRunner.switches).toHaveLength(1);
		expect(turnRunner.states).toHaveLength(1);
		expect(turnRunner.continues[0]).toMatchObject({
			activeLeaf: "assistant-1",
			rawFrameCursor: 1,
			eventCursor: 1,
		});
		expect(deliveredEvents.some(event => event.events.some(item => item.type === "status"))).toBe(true);

		const background = await handleChatCompletions({
			request: { model: "gjc", messages: [{ role: "user", content: "title" }] },
			headers: {
				...liveHeaders("chat-live", "assistant-bg", "user-bg", null),
				"X-OpenWebUI-Task": "title_generation",
			},
			projects: [project],
			owner: { ownerUserId, singleOwnerLocalMode: false },
			runner: liveRunner,
			modelReaderFactory: selectionFixture.staticModelReaderFactory(),
		});
		expect(background.ok).toBe(true);
		expect(turnRunner.starts).toHaveLength(1);

		mappings.set({
			chatId: "chat-live",
			projectId: project.id,
			sessionId: "session-golden",
			sessionFile,
			activeLeaf: "u-leaf",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "user-2",
		});
		expect(
			resolveBranchRegenerateAction({
				ownerUserId,
				project,
				chatId: "chat-live",
				messageId: importedLeafMessageId,
				mappings,
				messageMetadata: importedLeafMetadata,
			}),
		).toMatchObject({ action: "branch", gjcEntryId: "u-leaf" });
		expect(
			resolveBranchRegenerateAction({
				ownerUserId,
				project,
				chatId: "chat-live",
				messageId: "wrong-message",
				mappings,
				messageMetadata: importedLeafMetadata,
			}),
		).toMatchObject({ action: "fork" });

		expect(await Bun.file(sessionFile).text()).toBe(originalJsonl);
	});
});
