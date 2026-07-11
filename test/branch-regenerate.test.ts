import { describe, expect, test } from "bun:test";
import { resolveBranchRegenerateAction } from "../src/branches/regenerate";
import { SessionMappingStore } from "../src/gjc/session-router";
import type { RegisteredProject } from "../src/projects/registry";

describe("branch regenerate projection", () => {
	test("returns branch when stored mapping and message lineage match", () => {
		const mappings = storeWithMapping();

		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "entry-1",
			mappings,
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "session-1",
					gjcEntryId: "entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "branch", gjcEntryId: "entry-1", sessionId: "session-1" });
	});

	test("branches imported messages whose OpenWebUI id differs from GJC entry id", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "gjc-session-session-1-message-entry-1",
			mappings: storeWithMapping(),
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "session-1",
					gjcEntryId: "entry-1",
					openwebuiMessageId: "gjc-session-session-1-message-entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "branch", gjcEntryId: "entry-1", sessionId: "session-1" });
	});

	test("forks when explicit OpenWebUI message id metadata mismatches", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "other-message",
			mappings: storeWithMapping(),
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "session-1",
					gjcEntryId: "entry-1",
					openwebuiMessageId: "gjc-session-session-1-message-entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "fork", reason: "message-entry-mismatch", sourceSessionId: "session-1" });
	});

	test("forks on owner mismatch", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "entry-1",
			mappings: storeWithMapping(),
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-2",
					projectId: project.id,
					gjcSessionId: "session-1",
					gjcEntryId: "entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "fork", reason: "owner-mismatch", sourceSessionId: "session-1" });
	});

	test("forks on project mismatch", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project: { ...project, id: "other-project" },
			chatId: "chat-1",
			messageId: "entry-1",
			mappings: storeWithMapping(),
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "session-1",
					gjcEntryId: "entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "fork", reason: "project-mismatch", sourceSessionId: "session-1" });
	});

	test("forks on session mismatch", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "entry-1",
			mappings: storeWithMapping(),
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "session-2",
					gjcEntryId: "entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "fork", reason: "session-mismatch", sourceSessionId: "session-1" });
	});

	test("forks when message entry metadata is missing", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "entry-1",
			mappings: storeWithMapping(),
			messageMetadata: { gjc_adapter: { ownerUserId: "owner-1", projectId: project.id, gjcSessionId: "session-1" } },
		});

		expect(decision).toEqual({ action: "fork", reason: "missing-message-entry", sourceSessionId: "session-1" });
	});

	test("forks when owner, project, or session lineage metadata is missing", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "entry-1",
			mappings: storeWithMapping(),
			messageMetadata: {
				gjc_adapter: {
					gjcEntryId: "entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "fork", reason: "missing-lineage-metadata", sourceSessionId: "session-1" });
	});

	test("forks when no stored mapping exists", () => {
		const decision = resolveBranchRegenerateAction({
			ownerUserId: "owner-1",
			project,
			chatId: "chat-1",
			messageId: "entry-1",
			mappings: new SessionMappingStore(),
			messageMetadata: {
				gjc_adapter: {
					ownerUserId: "owner-1",
					projectId: project.id,
					gjcSessionId: "session-1",
					gjcEntryId: "entry-1",
				},
			},
		});

		expect(decision).toEqual({ action: "fork", reason: "missing-session-mapping" });
	});
});

function storeWithMapping(): SessionMappingStore {
	const mappings = new SessionMappingStore();
	mappings.set({
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "entry-1",
		rawFrameCursor: 2,
		eventCursor: 1,
		operationId: "operation-1",
	});
	return mappings;
}

const project: RegisteredProject = {
	id: "project",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};
