import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSessionMappingKey } from "../src/gjc/session-authority";
import { SessionAuthorityDurabilityError } from "../src/gjc/session-authority-persistence";
import type { AcknowledgedSuccessor, SessionOperationResult } from "../src/gjc/session-authority-types";
import { parseSessionAuthorityV3Document, SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import { replayCloseOperation } from "../src/gjc/session-operation-codec";
import { replayOperation } from "../src/gjc/session-turn-router";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";

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

const managedMapping = (principalId = "user-1", operationId = "initial") => ({
	chatId: "chat-1",
	projectId: "project-1",
	sessionId: "session-1",
	rawFrameCursor: 1,
	eventCursor: 2,
	operationId,
	managedAuthority: { ...authority(), principalId },
});

const completionResult = (
	operationId: string,
	kind: SessionOperationResult["kind"],
): SessionOperationResult & {
	readonly managedAuthority: ManagedTurnAuthority;
	readonly historicalBinding?: never;
} => ({
	kind,
	assistantText: kind === "close" ? "" : "original answer",
	events: [{ type: "message", id: "event-1", payload: { answer: "original" } }],
	managedAuthority: authority(),
	mapping: {
		chatId: "chat-1",
		projectId: "project-1",
		sessionId: "session-1",
		rawFrameCursor: 1,
		eventCursor: 2,
		operationId,
	},
	...(kind === "close" ? { correlation: { closeStatus: "closed", mappingOperationId: "initial" } } : {}),
	...(kind === "control" ? { gate: { gateId: "gate-1", commandId: "command-1", turnId: "turn-1" } } : {}),
});

const replayMapping = (projectId: string, operationId: string, sessionId = `session-${projectId}`, generation = 1) => ({
	...managedMapping("user-1", operationId),
	projectId,
	sessionId,
	assistantText: `answer-${operationId}`,
	events: [{ type: "message", id: `event-${operationId}`, payload: { data: { answer: operationId } } }],
	managedAuthority: {
		...authority("chat-1", projectId, sessionId),
		canonicalWorkspace: `/workspace/${projectId}`,
		generation,
		leaseId: `lease-${sessionId}`,
		requestKey: `request-${operationId}`,
	},
});

const publication = (value: ReturnType<typeof replayMapping>) => ({
	id: value.operationId,
	ingressId: `ingress-${value.operationId}`,
	kind: "prompt" as const,
	detail: `hash-${value.operationId}`,
	chatId: value.chatId,
	projectId: value.projectId,
	sessionId: value.sessionId,
	managedAuthority: value.managedAuthority,
});

describe("SessionV3FileBackedMappingStore", () => {
	test("retains exact publication receipts and replay events through two project reassignments", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-reassignment-history-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		const first = replayMapping("project-1", "turn-1");
		const second = replayMapping("project-2", "turn-2");
		const third = replayMapping("project-3", "turn-3");
		let store = new SessionV3FileBackedMappingStore(filePath);
		try {
			const originalEvents = structuredClone(first.events);
			store.reserveProvisionalOperationScoped(scope, publication(first));
			store.publishProvisionalOperationScoped(scope, publication(first), first);
			const firstOperation = store.operationScoped(scope, first.operationId);
			const firstReceipt = store.provisionalOperationScoped(scope, first.operationId);
			first.events[0]!.payload.data.answer = "mutated caller";
			expect(
				replayOperation(first.operationId, store.operationScoped(scope, first.operationId)?.result).events,
			).toEqual(originalEvents);
			let sourceProjectId = first.projectId;
			for (const target of [second, third]) {
				const operation = publication(target);
				store.beginProjectReassignmentScoped(scope, sourceProjectId, target.projectId, {
					id: operation.id,
					ingressId: operation.ingressId,
					kind: operation.kind,
					detail: operation.detail,
				});
				store.reserveProvisionalOperationScoped(scope, operation);
				const pendingBytes = readFileSync(filePath, "utf8");
				expect(() =>
					store.publishProvisionalOperationScoped(scope, operation, {
						...target,
						managedAuthority: { ...target.managedAuthority, leaseId: "forged-publication-lease" },
					}),
				).toThrow();
				expect(readFileSync(filePath, "utf8")).toBe(pendingBytes);
				expect(store.provisionalOperationScoped(scope, operation.id)?.state).toBe("pending");
				store.publishProvisionalOperationScoped(scope, operation, target);
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
				expect(store.getScoped(scope)?.projectId).toBe(target.projectId);
				expect(store.provisionalOperationScoped(scope, first.operationId)).toEqual(firstReceipt);
				expect(store.operationScoped(scope, first.operationId)).toEqual(firstOperation);
				sourceProjectId = target.projectId;
			}
			const document = parseSessionAuthorityV3Document(readFileSync(filePath, "utf8"));
			if (document === undefined) throw new Error("expected durable reassignment graph");
			expect(document.provisionalOperations).toHaveLength(3);
			expect(document.mappings[0]?.reassignment?.sourceTombstone?.events).toEqual(second.events);
			expect(document.mappings[0]?.reassignment?.sourceTombstone?.prior?.events).toEqual(originalEvents);
			for (const value of [first, second, third]) {
				const operation = store.operationScoped(scope, value.operationId);
				const replay = replayOperation(value.operationId, operation?.result);
				expect(replay.assistantText).toBe(value.assistantText);
				expect(replay.events).toEqual(value === first ? originalEvents : value.events);
				expect(replay.mapping).toMatchObject({ projectId: value.projectId, sessionId: value.sessionId });
				expect(store.provisionalOperationScoped(scope, value.operationId)).toMatchObject({
					state: "complete",
					detail: publication(value).detail,
				});
			}
			const copied = store.operationAuthorityScoped(scope, first.operationId)?.events?.[0]?.payload;
			if (copied === undefined) throw new Error("expected retained source events");
			(copied.data as { answer: string }).answer = "mutated read";
			expect(store.operationAuthorityScoped(scope, first.operationId)?.events).toEqual(originalEvents);
			const bytes = readFileSync(filePath, "utf8");
			for (const field of ["detail", "completedAt", "leaseId", "duplicate"] as const) {
				const corrupted = JSON.parse(bytes);
				const receipt = corrupted.provisionalOperations.find(
					(item: { id: string }) => item.id === first.operationId,
				);
				if (field === "leaseId") receipt.managedAuthority.leaseId = "forged-lease";
				else if (field === "completedAt")
					receipt.completedAt = new Date(Date.parse(receipt.completedAt) + 1).toISOString();
				else if (field === "duplicate") corrupted.provisionalOperations.push({ ...receipt });
				else receipt.detail = "forged-hash";
				expect(parseSessionAuthorityV3Document(JSON.stringify(corrupted))).toBeUndefined();
			}
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each([false, true])(
		"explicit rollback retains the target hash and attached=%s evidence across reopen",
		attached => {
			const directory = mkdtempSync(join(tmpdir(), "gjc-v3-explicit-rollback-"));
			const filePath = join(directory, "authority.json");
			const scope = { principalId: "user-1", chatId: "chat-1" };
			const source = replayMapping("project-1", "source-turn");
			const target = replayMapping("project-2", "target-turn");
			const operation = {
				id: target.operationId,
				ingressId: `ingress-${target.operationId}`,
				kind: "prompt" as const,
				detail: "target-request-hash",
				chatId: scope.chatId,
				projectId: target.projectId,
			};
			let store = new SessionV3FileBackedMappingStore(filePath);
			try {
				store.reserveProvisionalOperationScoped(scope, publication(source));
				store.publishProvisionalOperationScoped(scope, publication(source), source);
				store.beginProjectReassignmentScoped(scope, source.projectId, target.projectId, {
					id: operation.id,
					ingressId: operation.ingressId,
					kind: operation.kind,
					detail: operation.detail,
				});
				store.reserveProvisionalOperationScoped(scope, operation);
				if (attached)
					store.attachProvisionalOperationScoped(scope, operation.ingressId, {
						sessionId: target.sessionId,
						managedAuthority: target.managedAuthority,
					});
				const reserved = store.provisionalOperationScoped(scope, operation.id);
				if (reserved === undefined) throw new Error("expected pending target reservation");
				store.rollbackProjectReassignmentScoped(scope, source.projectId);
				const expected = { ...reserved, state: "uncertain" as const };
				expect(store.provisionalOperationScoped(scope, operation.id)).toEqual(expected);
				const bytes = readFileSync(filePath, "utf8");
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
				expect(store.provisionalOperationScoped(scope, operation.id)).toEqual(expected);
				expect(store.operationAuthorityScoped(scope, source.operationId)).toMatchObject({
					reassignment: { state: "rolled_back", target: { detail: operation.detail } },
				});
				expect(
					replayOperation(source.operationId, store.operationScoped(scope, source.operationId)?.result).events,
				).toEqual(source.events);
				expect(() => store.publishProvisionalOperationScoped(scope, operation, target)).toThrow();
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
			} finally {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test.each(["create", "branch"] as const)(
		"retains old-session replay after %s completion, reassignment, and reopen",
		kind => {
			const directory = mkdtempSync(join(tmpdir(), "gjc-v3-session-history-"));
			const filePath = join(directory, "authority.json");
			const scope = { principalId: "user-1", chatId: "chat-1" };
			const first = replayMapping("project-1", "old-turn", "session-old");
			const successor = replayMapping("project-1", `${kind}-next`, "session-next", 2);
			let store = new SessionV3FileBackedMappingStore(filePath);
			try {
				store.reserveProvisionalOperationScoped(scope, publication(first));
				store.publishProvisionalOperationScoped(scope, publication(first), first);
				const original = store.operationScoped(scope, first.operationId);
				store.beginOperationScoped(scope, { id: successor.operationId, kind, detail: "successor-hash" });
				store.recordAcknowledgedSuccessorScoped(scope, successor.operationId, "successor-hash", {
					sessionId: successor.sessionId,
					managedAuthority: successor.managedAuthority,
				} as unknown as AcknowledgedSuccessor);
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
				store.completeOperationWithMappingScoped(
					scope,
					successor.operationId,
					"successor-hash",
					successor,
					"control",
				);
				const control = store.operationScoped(scope, successor.operationId);
				expect(control?.result?.managedAuthority).toEqual(successor.managedAuthority);
				expect(control?.result?.events).toEqual(successor.events);
				const later = {
					...successor,
					operationId: "new-turn",
					assistantText: "new answer",
					events: [{ type: "message", id: "new-event" }],
				};
				store.beginOperationScoped(scope, { id: later.operationId, kind: "prompt", detail: "new-hash" });
				store.completeOperationWithMappingScoped(scope, later.operationId, "new-hash", later, "turn");
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
				expect(store.operationScoped(scope, first.operationId)).toEqual(original);
				expect(
					replayOperation(first.operationId, store.operationScoped(scope, first.operationId)?.result).events,
				).toEqual(first.events);
				expect(
					replayOperation(later.operationId, store.operationScoped(scope, later.operationId)?.result).events,
				).toEqual(later.events);
				store.beginOperationScoped(scope, { id: "invalid", kind: "prompt", detail: "invalid-hash" });
				const pendingBytes = readFileSync(filePath, "utf8");
				for (const managedAuthority of [
					{ ...successor.managedAuthority, principalId: "foreign" },
					{ ...successor.managedAuthority, canonicalWorkspace: "/workspace/foreign" },
					{ ...successor.managedAuthority, sessionId: "unbound-session" },
				]) {
					expect(() =>
						store.completeOperationWithMappingScoped(
							scope,
							"invalid",
							"invalid-hash",
							{
								...later,
								operationId: "invalid",
								managedAuthority,
							},
							"turn",
						),
					).toThrow();
					expect(readFileSync(filePath, "utf8")).toBe(pendingBytes);
					expect(store.operationScoped(scope, "invalid")?.state).toBe("pending");
				}
				store.discardPendingOperationScoped(scope, { id: "invalid", detail: "invalid-hash" });
				const target = replayMapping("project-2", "reassigned-turn");
				const targetOperation = publication(target);
				store.beginProjectReassignmentScoped(scope, first.projectId, target.projectId, {
					id: targetOperation.id,
					ingressId: targetOperation.ingressId,
					kind: targetOperation.kind,
					detail: targetOperation.detail,
				});
				store.reserveProvisionalOperationScoped(scope, publication(target));
				store.publishProvisionalOperationScoped(scope, publication(target), target);
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
				expect(store.operationScoped(scope, first.operationId)).toEqual(original);
				expect(store.operationScoped(scope, successor.operationId)).toEqual(control);
				expect(store.operationAuthorityScoped(scope, first.operationId)?.events).toEqual(later.events);
				expect(
					replayOperation(first.operationId, store.operationScoped(scope, first.operationId)?.result).events,
				).toEqual(first.events);
				expect(
					replayOperation(later.operationId, store.operationScoped(scope, later.operationId)?.result).events,
				).toEqual(later.events);
			} finally {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test.each([
		["identical", false],
		["crossed", false],
		["identical", true],
		["crossed", true],
	] as const)("isolates %s provisional aliases across principals with restart=%s", (aliases, restart) => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-tenant-reservations-"));
		const filePath = join(directory, "authority.json");
		const scopeA = { principalId: "user-a", chatId: "chat-1" };
		const scopeB = { principalId: "user-b", chatId: "chat-1" };
		let store = new SessionV3FileBackedMappingStore(filePath);
		const reservation = (prefix: string) => ({
			id: `${prefix}-id`,
			ingressId: `${prefix}-ingress`,
			kind: "prompt" as const,
			detail: `${prefix}-hash`,
			chatId: "chat-1",
			projectId: "project-1",
		});
		const forB = (operation: ReturnType<typeof reservation>) =>
			aliases === "crossed" ? { ...operation, id: operation.ingressId, ingressId: operation.id } : { ...operation };
		try {
			store.setScoped(scopeA, managedMapping(scopeA.principalId));
			store.setScoped(scopeB, managedMapping(scopeB.principalId));
			const beginA = reservation("begin");
			const publishA = reservation("publish");
			store.reserveProvisionalOperationScoped(scopeA, beginA);
			store.reserveProvisionalOperationScoped(scopeA, publishA);
			if (restart) {
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
			}
			const retainedA = store.provisionalOperationScoped(scopeA, beginA.id);
			const beforeConflict = readFileSync(filePath, "utf8");
			expect(() => store.beginOperationScoped(scopeA, beginA)).toThrow("requires reconciliation");
			expect(() =>
				store.beginOperationScoped(scopeA, {
					id: beginA.ingressId,
					ingressId: "other",
					kind: "prompt",
					detail: beginA.detail,
				}),
			).toThrow("conflicts with an existing operation");
			expect(() =>
				store.reserveProvisionalOperationScoped(scopeA, { ...beginA, id: beginA.ingressId, ingressId: "other" }),
			).toThrow("conflicts with an existing operation");
			expect(readFileSync(filePath, "utf8")).toBe(beforeConflict);

			const beginB = forB(beginA);
			store.beginOperationScoped(scopeB, {
				id: beginB.id,
				ingressId: beginB.ingressId,
				kind: beginB.kind,
				detail: beginB.detail,
			});
			store.completeOperationWithMappingScoped(
				scopeB,
				beginB.id,
				beginB.detail,
				managedMapping(scopeB.principalId, beginB.id),
				"turn",
			);
			const publishB = forB(publishA);
			store.reserveProvisionalOperationScoped(scopeB, publishB);
			store.publishProvisionalOperationScoped(scopeB, publishB, managedMapping(scopeB.principalId, publishB.id));
			expect(store.provisionalOperationScoped(scopeA, beginA.id)).toEqual(retainedA);
			expect(store.provisionalOperationScoped(scopeA, publishA.id)?.state).toBe(restart ? "uncertain" : "pending");
			expect(store.operationScoped(scopeA, beginA.id)).toBeUndefined();
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			for (const operation of [beginB, publishB]) {
				expect(store.operationScoped(scopeB, operation.id)).toMatchObject({
					state: "complete",
					result: { managedAuthority: { principalId: scopeB.principalId } },
				});
			}
			expect(store.provisionalOperationScoped(scopeA, beginA.ingressId)).toMatchObject({ state: "uncertain" });
			expect(() => store.beginOperationScoped(scopeA, beginA)).toThrow("requires reconciliation");
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each([
		["prompt", "turn"],
		["close", "close"],
		["gate", "control"],
	] as const)("keeps repeated %s completion immutable before and after reopen", (operationKind, resultKind) => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-immutable-completion-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		const operationId = `${operationKind}-1`;
		const result = completionResult(operationId, resultKind);
		let store = new SessionV3FileBackedMappingStore(filePath);
		try {
			store.setScoped(scope, managedMapping());
			store.beginOperationScoped(scope, { id: operationId, kind: operationKind, detail: "request-hash" });
			store.transitionOperationScoped(scope, operationId, "complete", "request-hash", result);
			const original = store.operationScoped(scope, operationId);
			if (original?.completedAt === undefined) throw new Error("expected durable completion");
			const bytes = readFileSync(filePath, "utf8");
			const later = new Date(Date.parse(original.completedAt) + 1_000).toISOString();
			for (const reopen of [false, true]) {
				if (reopen) {
					store.close();
					store = new SessionV3FileBackedMappingStore(filePath);
				}
				setSystemTime(new Date(later));
				try {
					// Different property order is still the identical persisted result.
					const { mapping: resultMapping, ...resultFields } = result;
					store.transitionOperationScoped(scope, operationId, "complete", "request-hash", {
						mapping: resultMapping,
						...resultFields,
					});
					store.transitionOperationScoped(scope, operationId, "complete");
				} finally {
					setSystemTime();
				}
				expect(store.operationScoped(scope, operationId)).toEqual(original);
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
				const conflicts: SessionOperationResult[] = [
					{ ...result, assistantText: "forged answer" },
					{ ...result, events: [{ type: "message", payload: { answer: "forged" } }] },
					{ ...result, mapping: { ...result.mapping, operationId: "other-operation" } },
					{ ...result, managedAuthority: { ...authority(), leaseId: "forged-lease" } },
					{ ...result, correlation: { ...result.correlation, mappingOperationId: "later" } },
					{ ...result, gate: { gateId: "forged-gate" } },
				];
				for (const conflict of conflicts) {
					expect(() =>
						store.transitionOperationScoped(scope, operationId, "complete", "request-hash", conflict),
					).toThrow("Completed session operations are immutable");
					expect(store.operationScoped(scope, operationId)).toEqual(original);
					expect(readFileSync(filePath, "utf8")).toBe(bytes);
				}
				expect(() =>
					store.transitionOperationScoped(scope, operationId, "complete", "request-hash", {
						...result,
						managedAuthority: { ...authority(), principalId: "other-principal" },
					}),
				).toThrow();
				expect(store.operationScoped(scope, operationId)).toEqual(original);
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
				expect(() =>
					store.transitionOperationScoped(scope, operationId, "complete", "forged-hash", result),
				).toThrow("Completed session operations are immutable");
				expect(() => store.transitionOperationScoped(scope, operationId, "uncertain")).toThrow(
					"Completed session operations are immutable",
				);
				if (resultKind === "close") {
					const replay = store.operationScoped(scope, operationId)?.result;
					expect(replayCloseOperation(operationId, replay, "initial")).toEqual({ status: "closed" });
					expect(() => replayCloseOperation(operationId, replay, "later")).toThrow("immutable result binding");
				}
			}
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			expect(store.operationScoped(scope, operationId)).toEqual(original);
			expect(readFileSync(filePath, "utf8")).toBe(bytes);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each([
		["prompt", "turn", "mapping"],
		["close", "close", "mapping"],
		["gate", "control", "mapping"],
		["prompt", "turn", "transition"],
		["close", "close", "transition"],
		["gate", "control", "transition"],
	] as const)("normalizes schema metadata for repeated %s %s completion via %s", (kind, resultKind, method) => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-completion-schema-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		const operationId = `${kind}-1`;
		const { authorityEpoch: _authorityEpoch, ...runtimeFields } = authority();
		const runtimeAuthority = { ...runtimeFields, epoch: "runtime-9", requestKey: "request-runtime" };
		const canonicalAuthority = { ...runtimeAuthority, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH };
		const result = { ...completionResult(operationId, resultKind), managedAuthority: runtimeAuthority };
		const inputMapping = {
			...managedMapping(),
			operationId: kind === "close" ? "initial" : operationId,
			assistantText: result.assistantText,
			events: result.events,
			managedAuthority: runtimeAuthority,
		};
		let store = new SessionV3FileBackedMappingStore(filePath);
		const complete = (managedAuthority: typeof runtimeAuthority) => {
			if (method === "mapping") {
				store.completeOperationWithMappingScoped(
					scope,
					operationId,
					"request-hash",
					{ ...inputMapping, managedAuthority },
					resultKind,
					result.gate,
				);
			} else {
				store.transitionOperationScoped(scope, operationId, "complete", "request-hash", {
					...result,
					managedAuthority,
				});
			}
		};
		try {
			store.setScoped(scope, { ...managedMapping(), managedAuthority: runtimeAuthority });
			store.beginOperationScoped(scope, { id: operationId, kind, detail: "request-hash" });
			const pending = store.operationScoped(scope, operationId);
			const pendingBytes = readFileSync(filePath, "utf8");
			for (const authorityEpoch of ["managed/invalid", null, 3]) {
				const invalid = { ...runtimeAuthority, authorityEpoch };
				expect(() => complete(invalid)).toThrow("Invalid V3 authority schema epoch");
				expect(store.operationScoped(scope, operationId)).toEqual(pending);
				expect(readFileSync(filePath, "utf8")).toBe(pendingBytes);
			}
			complete(runtimeAuthority);
			const original = store.operationScoped(scope, operationId);
			if (original?.completedAt === undefined) throw new Error("expected immutable completion");
			expect(original.result?.managedAuthority).toEqual(canonicalAuthority);
			expect(original.result?.events).toEqual(result.events);
			expect(original.result?.gate).toEqual(result.gate);
			const originalMapping = store.getScoped(scope);
			const bytes = readFileSync(filePath, "utf8");
			for (const reopen of [false, true]) {
				if (reopen) {
					store.close();
					store = new SessionV3FileBackedMappingStore(filePath);
				}
				setSystemTime(new Date(Date.parse(original.completedAt) + 1_000));
				try {
					for (const proof of [runtimeAuthority, canonicalAuthority, runtimeAuthority]) complete(proof);
				} finally {
					setSystemTime();
				}
				expect(store.operationScoped(scope, operationId)).toEqual(original);
				expect(store.getScoped(scope)).toEqual(originalMapping);
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
				for (const changed of [
					{ principalId: "foreign" },
					{ projectId: "other-project" },
					{ chatId: "other-chat" },
					{ sessionId: "other-session" },
					{ canonicalWorkspace: "/workspace/other" },
					{ generation: 2 },
					{ leaseId: "other-lease" },
					{ epoch: "runtime-10" },
					{ requestKey: "other-request" },
					{ authorityEpoch: "managed/invalid" },
				]) {
					expect(() => complete({ ...runtimeAuthority, ...changed })).toThrow();
					expect(store.operationScoped(scope, operationId)).toEqual(original);
					expect(store.getScoped(scope)).toEqual(originalMapping);
					expect(readFileSync(filePath, "utf8")).toBe(bytes);
				}
				if (kind === "close") {
					expect(replayCloseOperation(operationId, original.result, "initial")).toEqual({ status: "closed" });
					expect(() =>
						store.completeOperationWithMappingScoped(
							scope,
							operationId,
							"request-hash",
							{ ...inputMapping, operationId, managedAuthority: canonicalAuthority },
							"close",
						),
					).toThrow("Completed session operations are immutable");
					expect(store.operationScoped(scope, operationId)).toEqual(original);
					expect(readFileSync(filePath, "utf8")).toBe(bytes);
				}
			}
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			expect(store.operationScoped(scope, operationId)).toEqual(original);
			expect(readFileSync(filePath, "utf8")).toBe(bytes);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rejects close generation rebinding through atomic mapping completion after reopen", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-close-generation-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		let store = new SessionV3FileBackedMappingStore(filePath);
		try {
			store.setScoped(scope, managedMapping());
			store.beginOperationScoped(scope, { id: "close-1", kind: "close", detail: "close-hash" });
			store.completeOperationWithMappingScoped(scope, "close-1", "close-hash", managedMapping(), "close");
			const original = store.operationScoped(scope, "close-1");
			const bytes = readFileSync(filePath, "utf8");
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			store.completeOperationWithMappingScoped(scope, "close-1", "close-hash", managedMapping(), "close");
			expect(store.operationScoped(scope, "close-1")).toEqual(original);
			expect(readFileSync(filePath, "utf8")).toBe(bytes);
			expect(() =>
				store.completeOperationWithMappingScoped(
					scope,
					"close-1",
					"close-hash",
					managedMapping(scope.principalId, "later"),
					"close",
				),
			).toThrow("Completed session operations are immutable");
			expect(store.getScoped(scope)?.operationId).toBe("initial");
			expect(store.operationScoped(scope, "close-1")).toEqual(original);
			expect(readFileSync(filePath, "utf8")).toBe(bytes);
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			expect(replayCloseOperation("close-1", store.operationScoped(scope, "close-1")?.result, "initial")).toEqual({
				status: "closed",
			});
			expect(() =>
				replayCloseOperation("close-1", store.operationScoped(scope, "close-1")?.result, "later"),
			).toThrow("immutable result binding");
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("preserves completed provisional receipt timestamps on repeated completion", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-immutable-receipt-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		const operation = {
			id: "publish-1",
			kind: "prompt" as const,
			detail: "hash",
			chatId: scope.chatId,
			projectId: "project-1",
		};
		let store = new SessionV3FileBackedMappingStore(filePath);
		try {
			store.setScoped(scope, managedMapping());
			store.reserveProvisionalOperationScoped(scope, operation);
			store.publishProvisionalOperationScoped(scope, operation, managedMapping(scope.principalId, operation.id));
			const receipt = store.provisionalOperationScoped(scope, operation.id);
			if (receipt?.completedAt === undefined) throw new Error("expected completed publication receipt");
			const later = new Date(Date.parse(receipt.completedAt) + 1_000).toISOString();
			const bytes = readFileSync(filePath, "utf8");
			for (const reopen of [false, true]) {
				if (reopen) {
					store.close();
					store = new SessionV3FileBackedMappingStore(filePath);
				}
				setSystemTime(new Date(later));
				try {
					store.transitionProvisionalOperationScoped(scope, operation.id, "complete", operation.detail);
					store.transitionProvisionalOperationScoped(scope, operation.id, "complete");
				} finally {
					setSystemTime();
				}
				expect(() =>
					store.transitionProvisionalOperationScoped(scope, operation.id, "complete", "other-hash"),
				).toThrow("Completed session operations are immutable");
				expect(store.provisionalOperationScoped(scope, operation.id)).toEqual(receipt);
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
			}
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each(["invalid result binding", "rejected mapping publication"] as const)(
		"restores the pending operation after %s and reopens only durable evidence",
		failure => {
			const directory = mkdtempSync(join(tmpdir(), "gjc-v3-rejected-completion-"));
			const filePath = join(directory, "authority.json");
			const scope = { principalId: "user-1", chatId: "chat-1" };
			let store = new SessionV3FileBackedMappingStore(filePath);
			try {
				store.setScoped(scope, managedMapping());
				store.beginOperationScoped(scope, { id: "prompt-1", kind: "prompt", detail: "request-hash" });
				const before = store.operationScoped(scope, "prompt-1");
				if (before === undefined) throw new Error("expected pending operation");
				const beforeMapping = store.getScoped(scope);
				const bytes = readFileSync(filePath, "utf8");
				if (failure === "invalid result binding") {
					expect(() =>
						store.transitionOperationScoped(scope, "prompt-1", "complete", "request-hash", {
							...completionResult("prompt-1", "turn"),
							mapping: { ...completionResult("prompt-1", "turn").mapping, operationId: "other" },
						}),
					).toThrow();
				} else {
					// The journal completion is staged before the mapping's project fence rejects.
					expect(() =>
						store.completeOperationWithMappingScoped(
							scope,
							"prompt-1",
							"request-hash",
							{
								...managedMapping(),
								projectId: "other-project",
								managedAuthority: { ...authority(), projectId: "other-project" },
							},
							"turn",
						),
					).toThrow("assigned to another project");
				}
				expect(store.operationScoped(scope, "prompt-1")).toEqual(before);
				expect(store.getScoped(scope)).toEqual(beforeMapping);
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
				store.close();
				store = new SessionV3FileBackedMappingStore(filePath);
				expect(store.operationScoped(scope, "prompt-1")).toEqual({ ...before, state: "uncertain" });
				expect(store.getScoped(scope)).toEqual(beforeMapping);
				const durable = parseSessionAuthorityV3Document(readFileSync(filePath, "utf8"));
				expect(durable?.mappings[0]?.journal.find(operation => operation.id === "prompt-1")).toMatchObject({
					state: "uncertain",
					detail: "request-hash",
				});
				expect(store.operationScoped(scope, "prompt-1")?.result).toBeUndefined();
			} finally {
				store.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	test("rolls back a staged reassignment target when its reservation identity is rejected", () => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-rejected-target-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		let store = new SessionV3FileBackedMappingStore(filePath);
		try {
			store.setScoped(scope, managedMapping());
			store.beginProjectReassignmentScoped(scope, "project-1", "project-2");
			const before = store.operationAuthorityScoped(scope, "initial");
			const bytes = readFileSync(filePath, "utf8");
			expect(() =>
				store.reserveProvisionalOperationScoped(scope, {
					id: "initial",
					kind: "prompt",
					detail: "hash",
					chatId: scope.chatId,
					projectId: "project-2",
				}),
			).toThrow("requires reconciliation");
			expect(store.operationAuthorityScoped(scope, "initial")).toEqual(before);
			expect(store.provisionalOperationScoped(scope, "initial")).toBeUndefined();
			expect(readFileSync(filePath, "utf8")).toBe(bytes);
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			const reassignment = store.operationAuthorityScoped(scope, "initial");
			expect(reassignment).toMatchObject({ projectId: "project-1", reassignment: { state: "rolled_back" } });
			const durable = parseSessionAuthorityV3Document(readFileSync(filePath, "utf8"));
			expect(durable?.mappings[0]?.reassignment?.target).toBeUndefined();
			expect(durable?.provisionalOperations).toEqual([]);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test.each([
		["open", false],
		["write", false],
		["file fsync", false],
		["rename before replacement", false],
		["rename after replacement", true],
		["directory fsync", true],
		["lock release fsync", true],
	] as const)("preserves the disk-visible mutation and classifies %s failure", (boundary, committed) => {
		const directory = mkdtempSync(join(tmpdir(), "gjc-v3-persistence-failure-"));
		const filePath = join(directory, "authority.json");
		const scope = { principalId: "user-1", chatId: "chat-1" };
		let store = new SessionV3FileBackedMappingStore(filePath);
		try {
			store.setScoped(scope, managedMapping());
			const before = store.getScoped(scope);
			const bytes = readFileSync(filePath, "utf8");
			const next = { ...managedMapping(), operationId: "next", assistantText: "durable answer", eventCursor: 3 };
			const injected = new Error(`injected ${boundary} failure`);
			let failed = false;
			let directorySyncs = 0;
			const temporaryDescriptors = new Set<number>();
			const original = {
				open: fs.openSync,
				write: fs.writeFileSync,
				fsync: fs.fsyncSync,
				rename: fs.renameSync,
			};
			const open = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
				const temporary = String(path).startsWith(`${filePath}.tmp-`);
				if (!failed && temporary && boundary === "open") {
					failed = true;
					throw injected;
				}
				const descriptor = original.open(path, flags, mode);
				if (temporary) temporaryDescriptors.add(descriptor);
				return descriptor;
			});
			const write = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
				if (!failed && typeof file === "number" && temporaryDescriptors.has(file) && boundary === "write") {
					failed = true;
					throw injected;
				}
				original.write(file, data, options);
			});
			const sync = spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
				const isDirectory = fs.fstatSync(descriptor).isDirectory();
				if (isDirectory) directorySyncs += 1;
				if (
					!failed &&
					((boundary === "file fsync" && !isDirectory && temporaryDescriptors.has(descriptor)) ||
						(boundary === "directory fsync" && isDirectory && directorySyncs === 1) ||
						(boundary === "lock release fsync" && isDirectory && directorySyncs === 2))
				) {
					failed = true;
					throw injected;
				}
				original.fsync(descriptor);
			});
			const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
				if (!failed && String(to) === filePath && boundary === "rename before replacement") {
					failed = true;
					throw injected;
				}
				original.rename(from, to);
				if (!failed && String(to) === filePath && boundary === "rename after replacement") {
					failed = true;
					throw injected;
				}
			});
			let caught: unknown;
			try {
				store.upsertScoped(scope, next);
			} catch (error) {
				caught = error;
			} finally {
				rename.mockRestore();
				sync.mockRestore();
				write.mockRestore();
				open.mockRestore();
			}
			expect(failed).toBe(true);
			if (committed) {
				expect(caught).toBeInstanceOf(SessionAuthorityDurabilityError);
				expect((caught as Error).cause).toBe(injected);
				expect(store.getScoped(scope)).toMatchObject(next);
				expect(readFileSync(filePath, "utf8")).not.toBe(bytes);
			} else {
				expect(caught).toBe(injected);
				expect(store.getScoped(scope)).toEqual(before);
				expect(readFileSync(filePath, "utf8")).toBe(bytes);
			}
			const visible = store.getScoped(scope);
			const operation = store.operationScoped(scope, "next");
			expect(fs.readdirSync(directory)).toEqual(["authority.json"]);
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			expect(store.getScoped(scope)).toEqual(visible);
			expect(store.operationScoped(scope, "next")).toEqual(operation);
			store.upsertScoped(scope, next);
			expect(store.getScoped(scope)).toMatchObject(next);
			store.close();
			store = new SessionV3FileBackedMappingStore(filePath);
			expect(store.getScoped(scope)).toMatchObject(next);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

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
			const durableMapping = document?.mappings[0];
			if (durableMapping?.managedAuthority === undefined)
				throw new Error("expected managed authority for the durable mapping");
			expect(durableMapping.managedAuthority.chatId).toBe(durableChatId);
			for (const operation of durableMapping.journal) {
				if (operation.result === undefined) continue;
				expect(operation.result.mapping.chatId).toBe(durableChatId);
				if (operation.result.managedAuthority === undefined)
					throw new Error("expected managed authority for the durable result");
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
