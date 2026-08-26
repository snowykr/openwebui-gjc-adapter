import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionMappingKey } from "../src/gjc/session-authority";
import { parseSessionAuthorityV3Document, SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

const authority = (chatId = "chat-1", projectId = "project-1", sessionId = "session-1") => ({
	authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	principalId: "user-1",
	projectId,
	canonicalWorkspace: "/workspace/project-1",
	chatId,
	sessionId,
	generation: 1,
	leaseId: "lease-1",
	epoch: SESSION_AUTHORITY_V3_EPOCH,
	requestKey: "request-1",
});

const mapping = () => ({
	chatId: "chat-1",
	projectId: "project-1",
	sessionId: "session-1",
	rawFrameCursor: 1,
	eventCursor: 2,
	operationId: "initial",
	managedAuthority: authority(),
	attachment: {
		descriptorPath: "/private/session.json",
		descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		payloadDigest: "a".repeat(64),
		generation: 1,
		expectedSessionId: "session-1",
		expectedCwd: "/private",
	},
});

describe("SessionV3FileBackedMappingStore", () => {
	test("writes canonical V3 only and recovers operation state", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-authority-"));
		const filePath = join(directory, "authority.json");
		try {
			const store = new SessionV3FileBackedMappingStore(filePath);
			store.set(mapping());
			store.beginOperation("chat-1", { id: "prompt-1", kind: "prompt", detail: "request" });
			store.transitionOperation("chat-1", "prompt-1", "complete", "done", {
				kind: "turn",
				assistantText: "done",
				managedAuthority: authority(),
				mapping: {
					chatId: "chat-1",
					projectId: "project-1",
					sessionId: "session-1",
					rawFrameCursor: 1,
					eventCursor: 2,
					operationId: "prompt-1",
				},
			});
			const firstBytes = readFileSync(filePath, "utf8");
			expect(firstBytes).toContain('"authorityEpoch":"managed/1"');
			expect(firstBytes).not.toContain("descriptorPath");
			expect(firstBytes).not.toContain("sessionFile");
			store.close();
			const recovered = new SessionV3FileBackedMappingStore(filePath);
			expect(recovered.get("chat-1")).toMatchObject({ sessionId: "session-1" });
			expect(recovered.get("chat-1")?.attachment).toBeUndefined();
			expect(recovered.operation("chat-1", "prompt-1")).toMatchObject({
				state: "complete",
				result: { assistantText: "done" },
			});
			expect(readFileSync(filePath, "utf8")).toBe(firstBytes);
			recovered.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("round-trips scoped V3 authority identity across the durable boundary", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-scoped-authority-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		const durableChatId = canonicalSessionMappingKey(scope.principalId, scope.chatId);
		try {
			const store = new SessionV3FileBackedMappingStore(filePath);
			store.setScoped(scope, mapping());
			store.beginOperationScoped(scope, { id: "prompt-1", kind: "prompt", detail: "request" });
			store.transitionOperationScoped(scope, "prompt-1", "complete", "done", {
				kind: "turn",
				assistantText: "done",
				managedAuthority: authority(),
				mapping: {
					chatId: scope.chatId,
					projectId: "project-1",
					sessionId: "session-1",
					rawFrameCursor: 1,
					eventCursor: 2,
					operationId: "prompt-1",
				},
			});
			store.beginOperationScoped(scope, { id: "close-1", kind: "close", detail: "close" });
			store.transitionOperationScoped(scope, "close-1", "complete", "closed", {
				kind: "close",
				assistantText: "",
				managedAuthority: authority(),
				mapping: {
					chatId: scope.chatId,
					projectId: "project-1",
					sessionId: "session-1",
					rawFrameCursor: 1,
					eventCursor: 2,
					operationId: "close-1",
				},
				correlation: { closeStatus: "closed" },
			});
			store.reserveProvisionalOperationScoped(scope, {
				id: "provisional-1",
				ingressId: "provisional-1",
				kind: "prompt",
				detail: "reserved",
				chatId: scope.chatId,
				projectId: "project-1",
				sessionId: "session-1",
				managedAuthority: authority(),
			});

			const document = parseSessionAuthorityV3Document(readFileSync(filePath, "utf8"));
			expect(document).toBeDefined();
			expect(document?.mappings).toHaveLength(1);
			expect(document?.mappings[0]?.chatId).toBe(durableChatId);
			expect(document?.mappings[0]?.managedAuthority.chatId).toBe(durableChatId);
			for (const operation of document?.mappings[0]?.journal ?? []) {
				if (operation.result === undefined) continue;
				expect(operation.result.mapping.chatId).toBe(durableChatId);
				expect(operation.result.managedAuthority.chatId).toBe(durableChatId);
			}
			expect(document?.provisionalOperations[0]?.chatId).toBe(durableChatId);
			expect(document?.provisionalOperations[0]?.managedAuthority?.chatId).toBe(durableChatId);
			store.close();

			const reopened = new SessionV3FileBackedMappingStore(filePath);
			expect(reopened.getScoped(scope)).toMatchObject({
				chatId: scope.chatId,
				managedAuthority: { chatId: scope.chatId },
			});
			expect(reopened.operationScoped(scope, "prompt-1")).toMatchObject({
				result: {
					mapping: { chatId: scope.chatId },
					managedAuthority: { chatId: scope.chatId },
				},
			});
			expect(reopened.operationScoped(scope, "close-1")).toMatchObject({
				result: {
					mapping: { chatId: scope.chatId },
					managedAuthority: { chatId: scope.chatId },
				},
			});
			expect(reopened.operationAuthorityScoped(scope, "close-1")).toMatchObject({
				chatId: scope.chatId,
				managedAuthority: { chatId: scope.chatId },
			});
			expect(reopened.provisionalOperationScoped(scope, "provisional-1")).toMatchObject({
				chatId: scope.chatId,
				managedAuthority: { chatId: scope.chatId },
			});
			reopened.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("reloads a managed successor proof without fabricating attachment state", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-successor-proof-"));
		const filePath = join(directory, "authority.json");
		try {
			const store = new SessionV3FileBackedMappingStore(filePath);
			store.set(mapping());
			store.beginOperation("chat-1", { id: "create-1", kind: "create", detail: "create" });
			store.close();

			const document = JSON.parse(readFileSync(filePath, "utf8"));
			const operation = document.mappings[0].journal.find((value: { id: string }) => value.id === "create-1");
			if (operation === undefined) throw new Error("expected create journal operation");
			operation.acknowledgedSuccessor = {
				sessionId: "successor-1",
				managedAuthority: authority("chat-1", "project-1", "successor-1"),
			};
			writeFileSync(filePath, JSON.stringify(document));

			const recovered = new SessionV3FileBackedMappingStore(filePath);
			const successor = recovered.operation("chat-1", "create-1")?.acknowledgedSuccessor;
			expect(successor as unknown).toEqual({
				sessionId: "successor-1",
				managedAuthority: authority("chat-1", "project-1", "successor-1"),
			});
			expect(successor).not.toHaveProperty("attachment");
			expect(JSON.parse(readFileSync(filePath, "utf8"))).not.toHaveProperty(
				"mappings[0].journal[0].acknowledgedSuccessor.attachment",
			);
			recovered.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects obsolete attachment-shaped successor persistence", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-obsolete-successor-"));
		const filePath = join(directory, "authority.json");
		try {
			const store = new SessionV3FileBackedMappingStore(filePath);
			store.set(mapping());
			store.beginOperation("chat-1", { id: "create-1", kind: "create", detail: "create" });
			store.close();

			for (const acknowledgedSuccessor of [
				{
					sessionId: "successor-1",
					attachment: mapping().attachment,
				},
				{
					sessionId: "successor-1",
					attachment: mapping().attachment,
					managedAuthority: authority("chat-1", "project-1", "successor-1"),
				},
			]) {
				const document = JSON.parse(readFileSync(filePath, "utf8"));
				const operation = document.mappings[0].journal.find((value: { id: string }) => value.id === "create-1");
				if (operation === undefined) throw new Error("expected create journal operation");
				operation.acknowledgedSuccessor = acknowledgedSuccessor;
				writeFileSync(filePath, JSON.stringify(document));
				expect(() => new SessionV3FileBackedMappingStore(filePath)).toThrow("authority document is not strict V3");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
