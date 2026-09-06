import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { probeSessionAuthorityEpoch } from "../src/gjc/session-authority-epoch";
import type {
	SessionAttachmentProof,
	SessionAuthorityRecord,
	SessionAuthorityTombstone,
} from "../src/gjc/session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	parseSessionAuthorityV3Document,
} from "../src/gjc/session-authority-v3";
import {
	type ManagedTurnAuthorityBinding,
	migrateSessionAuthorityV2ToV3,
	type SessionAuthorityV2Document,
	stageSessionAuthorityV3Migration,
} from "../src/gjc/session-authority-v3-migration";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

const timestamp = "2026-01-01T00:00:00.000Z";
const chatId = JSON.stringify(["user-a", "chat-a"]);
function attachment(sessionId: string): SessionAttachmentProof {
	return {
		descriptorPath: "/legacy/endpoint.json",
		descriptorStat: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		payloadDigest: "a".repeat(64),
		generation: 4,
		expectedSessionId: sessionId,
		expectedCwd: "/legacy/workspace",
	};
}
function binding(nodeRef: string, sessionId = "session-a", projectId = "project-b"): ManagedTurnAuthorityBinding {
	return {
		nodeRef,
		chatId,
		projectId,
		sessionId,
		managedAuthority: {
			principalId: "user-a",
			projectId,
			canonicalWorkspace: "/workspace/a",
			chatId,
			sessionId,
			generation: 7,
			leaseId: "real-lease",
			epoch: "runtime/7",
			requestKey: "real-key",
		},
	};
}
function tombstone(projectId: string, sessionId: string, prior?: SessionAuthorityTombstone): SessionAuthorityTombstone {
	return {
		version: 2,
		chatId,
		projectId,
		sessionId,
		createdAt: timestamp,
		header: { chatId, projectId, sessionId },
		sessionFile: `/legacy/${sessionId}.jsonl`,
		activeLeaf: `leaf-${sessionId}`,
		rawFrameCursor: 1,
		eventCursor: 1,
		operationId: `old-${sessionId}`,
		attachment: attachment(sessionId),
		journal: [],
		retiredAt: "2026-01-02T00:00:00.000Z",
		...(prior === undefined ? {} : { prior }),
	};
}
function v2Graph(): SessionAuthorityV2Document {
	const prior = tombstone("project-older", "session-older");
	const source = tombstone("project-a", "session-old", prior);
	const mapping: SessionAuthorityRecord = {
		version: 2,
		chatId,
		projectId: "project-b",
		sessionId: "session-a",
		createdAt: timestamp,
		header: { chatId, projectId: "project-b", sessionId: "session-a" },
		sessionFile: "/legacy/session-a.jsonl",
		activeLeaf: "leaf-a",
		rawFrameCursor: 3,
		eventCursor: 2,
		operationId: "turn",
		assistantText: "answer",
		attachment: attachment("session-a"),
		events: [{ type: "message", text: "projection", payload: { opaque: { retained: [1, "two"] } } }],
		observations: { preserved: true, __gjcSessionMappingScope: { principalId: "user-a", chatId: "chat-a" } },
		journal: [
			{
				id: "turn",
				kind: "prompt",
				state: "complete",
				startedAt: timestamp,
				completedAt: timestamp,
				result: {
					kind: "turn",
					assistantText: "answer",
					events: [{ type: "assistant", text: "answer" }],
					mapping: {
						chatId,
						projectId: "project-b",
						sessionId: "session-a",
						operationId: "turn",
						rawFrameCursor: 3,
						eventCursor: 2,
						sessionFile: "/legacy/replay.jsonl",
						activeLeaf: "replay-leaf",
						attachment: attachment("session-a"),
					},
					correlation: { commandId: "command", turnId: "turn" },
					gate: { gateId: "gate", sessionId: "session-a" },
				},
			},
			{
				id: "next",
				kind: "branch",
				state: "uncertain",
				startedAt: timestamp,
				detail: "branch-hash",
				acknowledgedSuccessor: { sessionId: "session-b", attachment: attachment("session-b") },
			},
			{ id: "conflict", kind: "model", state: "conflict", startedAt: timestamp, detail: "conflict-hash" },
			{ id: "pending", kind: "thinking", state: "pending", startedAt: timestamp },
		],
		reassignment: {
			state: "committed",
			sourceProjectId: "project-a",
			targetProjectId: "project-b",
			startedAt: timestamp,
			completedAt: timestamp,
			sourceTombstone: source,
			priorTombstone: structuredClone(prior),
		},
	};
	return {
		mappings: [mapping],
		provisionalOperations: [
			{
				id: "provisional",
				kind: "prompt",
				state: "uncertain",
				startedAt: timestamp,
				chatId,
				projectId: "project-b",
				sessionId: "session-a",
				sessionFile: "/legacy/provisional.jsonl",
				attachment: attachment("session-a"),
			},
			{
				id: "reserved",
				kind: "create",
				state: "pending",
				startedAt: timestamp,
				chatId: "unowned-chat",
				projectId: "project-c",
			},
		],
	};
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function migrated(source = v2Graph(), bindings: readonly ManagedTurnAuthorityBinding[] = []) {
	const report = migrateSessionAuthorityV2ToV3(source, bindings);
	if (report.status !== "ready") throw new Error(report.reasons.join("\n"));
	return report.document;
}
function rawAuthorityPresent(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.entries(value).some(
			([key, child]) =>
				["attachment", "descriptorPath", "tmuxPane", "payloadDigest"].includes(key) || rawAuthorityPresent(child),
		)
	);
}

describe("generation-free ordinary V3 historical migration", () => {
	test("canonical historical ownership remains scoped without projection metadata", () => {
		const source = v2Graph();
		const withoutScope: SessionAuthorityV2Document = {
			...source,
			mappings: source.mappings.map(({ observations: _observations, ...record }) => record),
		};
		const root = mkdtempSync(join(tmpdir(), "gjc-history-owner-"));
		try {
			const file = join(root, "authority.json");
			writeFileSync(file, encodeSessionAuthorityV3Document(migrated(withoutScope)));
			const store = new V3FileBackedSessionMappingStore(file);
			expect(store.operationScoped({ principalId: "user-a", chatId: "chat-a" }, "turn")?.result?.assistantText).toBe(
				"answer",
			);
			expect(store.operationScoped({ principalId: "user-b", chatId: "chat-a" }, "turn")).toBeUndefined();
			expect(store.getScoped({ principalId: "user-a", chatId: "chat-a" })).toBeUndefined();
			store.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("normal V3 reopen preserves scoped historical replay while refusing live admission", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-unbound-v3-store-"));
		const file = join(root, "authority.json");
		try {
			const document = migrated();
			writeFileSync(file, encodeSessionAuthorityV3Document(document));
			const scope = { principalId: "user-a", chatId: "chat-a" };
			const foreign = { principalId: "user-b", chatId: "chat-a" };
			const store = new V3FileBackedSessionMappingStore(file);
			expect(store.get(chatId)).toBeUndefined();
			expect(() => store.assertServingReady()).toThrow("unbound history");
			expect(store.getScoped(scope)).toBeUndefined();
			expect(store.entriesForPrincipal(scope.principalId)).toEqual([]);
			expect(store.mappingRecords()).toEqual([]);
			const replay = store.operationScoped(scope, "turn");
			expect(replay?.result?.assistantText).toBe("answer");
			expect(replay?.result?.mapping.sessionFile).toBe("/legacy/replay.jsonl");
			expect(replay?.result?.historicalBinding?.chatId).toBe("chat-a");
			expect(store.operationScoped(foreign, "turn")).toBeUndefined();
			expect(store.operationsScoped(scope).map(operation => operation.state)).toEqual([
				"complete",
				"uncertain",
				"conflict",
				"uncertain",
			]);
			expect(store.provisionalOperationScoped(scope, "provisional")?.historicalBinding?.chatId).toBe("chat-a");
			expect(() => store.beginOperationScoped(scope, { id: "new", kind: "prompt" })).toThrow(
				"explicit bootstrap proof",
			);
			expect(() =>
				store.setScoped(scope, {
					...binding("/mappings/0").managedAuthority,
					chatId: "chat-a",
					principalId: "user-a",
					projectId: "project-b",
					sessionId: "session-a",
					operationId: "new",
					rawFrameCursor: 0,
					eventCursor: 0,
					managedAuthority: { ...binding("/mappings/0").managedAuthority, chatId: "chat-a" },
				}),
			).toThrow("explicit bootstrap proof");
			store.close();
			const persisted = parseSessionAuthorityV3Document(readFileSync(file));
			expect(persisted).toBeDefined();
			expect(persisted?.mappings[0]?.journal[0]?.result).toEqual(document.mappings[0]?.journal[0]?.result);
			expect(persisted?.mappings[0]?.reassignment).toEqual(document.mappings[0]?.reassignment);
			expect(persisted?.mappings[0]?.sessionFile).toBe("/legacy/session-a.jsonl");
			expect(probeSessionAuthorityEpoch(file).status).toBe("blocked");
			const reopened = new V3FileBackedSessionMappingStore(file);
			expect(reopened.operationScoped(scope, "turn")).toEqual(replay);
			reopened.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("later managed writes never bind historical results to the current generation", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-history-current-"));
		const file = join(root, "authority.json");
		try {
			const source = v2Graph();
			const document = migrated({ ...source, provisionalOperations: [] }, [binding("/mappings/0")]);
			writeFileSync(file, encodeSessionAuthorityV3Document(document));
			const scope = { principalId: "user-a", chatId: "chat-a" };
			const store = new V3FileBackedSessionMappingStore(file);
			store.assertServingReady();
			const current = store.getScoped(scope);
			if (current?.managedAuthority === undefined) throw new Error("Missing proven current mapping.");
			const original = store.operationScoped(scope, "turn");
			store.beginOperationScoped(scope, { id: "later", kind: "prompt", detail: "later-hash" });
			store.completeOperationWithMappingScoped(
				scope,
				"later",
				"later-hash",
				{ ...current, operationId: "later", assistantText: "new text" },
				"turn",
			);
			expect(store.operationScoped(scope, "turn")).toEqual(original);
			expect(store.operationScoped(scope, "turn")?.result?.managedAuthority).toBeUndefined();
			expect(store.operationScoped(scope, "turn")?.result?.historicalBinding).toBeDefined();
			expect(store.operationScoped(scope, "later")?.result?.managedAuthority?.generation).toBe(7);
			store.close();
			const reopened = new V3FileBackedSessionMappingStore(file);
			expect(reopened.operationScoped(scope, "turn")).toEqual(original);
			expect(reopened.getScoped(scope)?.sessionFile).toBe("/legacy/session-a.jsonl");
			reopened.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("converts the entire historical graph without any generation bindings or projection loss", () => {
		const source = v2Graph();
		const before = structuredClone(source);
		const document = migrated(source);
		expect(isSessionAuthorityV3Document(document)).toBe(true);
		const mapping = document.mappings[0]!;
		expect(mapping.managedAuthority).toBeUndefined();
		expect(mapping.historicalBinding?.principalId).toBe("user-a");
		expect(mapping.historicalBinding?.canonicalWorkspace).toBeUndefined();
		expect(mapping.historicalBinding?.reason).toBe("ownership-unresolved");
		expect(mapping.sessionFile).toBe(source.mappings[0]!.sessionFile);
		expect(mapping.activeLeaf).toBe("leaf-a");
		expect(mapping.events).toEqual(source.mappings[0]!.events);
		expect(mapping.observations).toEqual(source.mappings[0]!.observations);
		expect(mapping.journal.map(operation => operation.state)).toEqual([
			"complete",
			"uncertain",
			"conflict",
			"pending",
		]);
		const result = mapping.journal[0]!.result!;
		expect(result.mapping.sessionFile).toBe("/legacy/replay.jsonl");
		expect(result.mapping.activeLeaf).toBe("replay-leaf");
		expect(result.correlation).toEqual(source.mappings[0]!.journal[0]!.result!.correlation);
		expect(result.gate).toEqual(source.mappings[0]!.journal[0]!.result!.gate);
		expect(result.historicalBinding?.provenance.nodeRef).toBe("/mappings/0/journal/0/result");
		expect(mapping.journal[1]!.acknowledgedSuccessor?.historicalBinding?.sessionId).toBe("session-b");
		expect(mapping.reassignment?.sourceTombstone?.prior?.activeLeaf).toBe("leaf-session-older");
		expect(mapping.reassignment?.priorTombstone).toEqual(mapping.reassignment?.sourceTombstone?.prior);
		expect(document.provisionalOperations[0]?.sessionFile).toBe("/legacy/provisional.jsonl");
		expect(isDeepStrictEqual(document.provisionalOperations[1], source.provisionalOperations![1])).toBe(true);
		expect(rawAuthorityPresent(document)).toBe(false);
		expect(source).toEqual(before);
		expect(parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document))).toEqual(document);
	});

	test("binds only the named occurrence and leaves same-session replay and provisional history unbound", () => {
		const document = migrated(v2Graph(), [binding("/mappings/0")]);
		expect(document.mappings[0]!.managedAuthority?.generation).toBe(7);
		expect(document.mappings[0]!.historicalBinding).toBeUndefined();
		expect(document.mappings[0]!.journal[0]!.result!.managedAuthority).toBeUndefined();
		expect(document.provisionalOperations[0]!.managedAuthority).toBeUndefined();
		const separate = migrated(v2Graph(), [binding("/mappings/0/journal/1/acknowledgedSuccessor", "session-b")]);
		expect(separate.mappings[0]!.managedAuthority).toBeUndefined();
		expect(separate.mappings[0]!.journal[1]!.acknowledgedSuccessor!.managedAuthority?.generation).toBe(7);
	});

	test("retains existing occurrence authority and blocks a binding that rewrites its generation", () => {
		const source = v2Graph();
		const old = binding("/mappings/0/journal/0/result").managedAuthority;
		const original = source.mappings[0]!;
		const changed: SessionAuthorityV2Document = {
			...source,
			mappings: [
				{
					...original,
					journal: original.journal.map((operation, index) => {
						if (index !== 0) return operation;
						const { historicalBinding: _history, ...result } = operation.result!;
						return { ...operation, result: { ...result, managedAuthority: old } };
					}),
				},
			],
		};
		const document = migrated(changed, [binding("/mappings/0")]);
		expect(document.mappings[0]!.journal[0]!.result!.managedAuthority?.generation).toBe(7);
		expect(
			migrateSessionAuthorityV2ToV3(changed, [
				{ ...binding("/mappings/0/journal/0/result"), managedAuthority: { ...old, generation: 8 } },
			]).status,
		).toBe("blocked");
	});

	test("retains completed publication and provisional replay duplicates as history rather than rewriting generations", () => {
		const source = v2Graph();
		const completed = source.mappings[0]!.journal[0]!;
		const graph: SessionAuthorityV2Document = {
			...source,
			provisionalOperations: [
				{
					id: completed.id,
					kind: "create",
					state: "complete",
					startedAt: completed.startedAt,
					completedAt: completed.completedAt,
					chatId,
					projectId: "project-b",
					sessionId: "session-a",
					sessionFile: "/legacy/reserved.jsonl",
					attachment: attachment("session-a"),
				},
			],
		};
		const document = migrated(graph);
		expect(document.provisionalOperations[0]!.state).toBe("complete");
		expect(document.provisionalOperations[0]!.historicalBinding?.provenance.nodeRef).toBe("/provisionalOperations/0");
		expect(document.mappings[0]!.journal[0]!.result!.historicalBinding?.provenance.nodeRef).toBe(
			"/mappings/0/journal/0/result",
		);
	});

	test("rejects absent pointers, duplicate occurrence binding, identity-only and foreign owner bindings", () => {
		for (const bindings of [
			[binding("/mappings/9")],
			[binding("/mappings/0"), binding("/mappings/0")],
			[{ ...binding("/mappings/0"), nodeRef: "" }],
			[{ ...binding("/mappings/0"), sessionId: "foreign" }],
			[
				{
					...binding("/mappings/0"),
					managedAuthority: { ...binding("/mappings/0").managedAuthority, principalId: "foreign" },
				},
			],
		])
			expect(migrateSessionAuthorityV2ToV3(v2Graph(), bindings).status).toBe("blocked");
	});

	test("requires equal explicit proof for both duplicated prior occurrences without propagating authority", () => {
		const canonical = binding("/mappings/0/reassignment/sourceTombstone/prior", "session-older", "project-older");
		const alias = binding("/mappings/0/reassignment/priorTombstone", "session-older", "project-older");
		expect(migrateSessionAuthorityV2ToV3(v2Graph(), [canonical]).status).toBe("blocked");
		expect(migrateSessionAuthorityV2ToV3(v2Graph(), [alias]).status).toBe("blocked");
		expect(
			migrateSessionAuthorityV2ToV3(v2Graph(), [
				canonical,
				{ ...alias, managedAuthority: { ...alias.managedAuthority, generation: 8 } },
			]).status,
		).toBe("blocked");
		const document = migrated(v2Graph(), [canonical, alias]);
		expect(document.mappings[0]!.reassignment!.sourceTombstone!.prior!.managedAuthority?.generation).toBe(7);
		expect(document.mappings[0]!.reassignment!.priorTombstone).toEqual(
			document.mappings[0]!.reassignment!.sourceTombstone!.prior,
		);
	});

	test("derives immutable provenance from actual decoded document and occurrence bytes", () => {
		const source = v2Graph();
		const document = migrated(source);
		const provenance = document.mappings[0]!.historicalBinding!.provenance;
		expect(provenance.documentHash).toBe(sha256(new TextEncoder().encode(canonical(source))));
		expect(provenance.nodeHash).toBe(sha256(new TextEncoder().encode(canonical(source.mappings[0]))));
		expect(provenance.nodeRef).toBe("/mappings/0");
		const changed = { ...source, mappings: [{ ...source.mappings[0]!, assistantText: "changed" }] };
		expect(migrated(changed).mappings[0]!.historicalBinding!.provenance.nodeHash).not.toBe(provenance.nodeHash);
	});

	test("stages no-binding history while preserving detached original snapshot bytes and hashes", () => {
		const base = new TextEncoder().encode('{"actual":"base bytes"}');
		const wal = new TextEncoder().encode('{"actual":"wal bytes"}\n');
		const snapshot = {
			originalBaseBytes: base,
			originalBaseDigest: sha256(base),
			originalWalBytes: wal,
			originalWalDigest: sha256(wal),
		};
		const first = stageSessionAuthorityV3Migration({ snapshot, decodedDocument: v2Graph() });
		const second = stageSessionAuthorityV3Migration({ snapshot, decodedDocument: v2Graph() });
		if (first.status !== "staged" || second.status !== "staged") throw new Error("Expected pure historical stage.");
		expect(first.originalBaseBytes).toEqual(base);
		expect(first.originalWalBytes).toEqual(wal);
		expect(first.originalBaseBytes).not.toBe(base);
		expect(first.originalWalBytes).not.toBe(wal);
		expect(first.v3Bytes).toEqual(second.v3Bytes);
		expect(first.v3Digest).toBe(sha256(first.v3Bytes));
		first.originalBaseBytes[0] = 0;
		expect(sha256(base)).toBe(snapshot.originalBaseDigest);
		expect(
			stageSessionAuthorityV3Migration({
				snapshot: { ...snapshot, originalWalDigest: "0".repeat(64) },
				decodedDocument: v2Graph(),
			}).status,
		).toBe("blocked");
	});

	test("keeps truly unscoped history unowned and does not infer workspace from attachment paths", () => {
		const source = v2Graph().mappings[0]!;
		const unscoped: SessionAuthorityRecord = {
			...source,
			chatId: "unscoped",
			header: { ...source.header, chatId: "unscoped" },
			observations: { preserved: true },
			journal: [],
			reassignment: undefined,
		};
		const { reassignment: _removed, ...node } = unscoped;
		const document = migrated({ mappings: [node] });
		expect(document.mappings[0]!.historicalBinding?.principalId).toBeUndefined();
		expect(document.mappings[0]!.historicalBinding?.canonicalWorkspace).toBeUndefined();
		expect(document.mappings[0]!.sessionFile).toBe(source.sessionFile);
	});

	test("blocks malformed/lossy attachment, scope, unknown fields and opaque forbidden payloads without source mutation", () => {
		for (const change of [
			{ attachment: { descriptorPath: "/malformed" } },
			{ observations: { __gjcSessionMappingScope: { principalId: "foreign", chatId: "chat-a" } } },
			{ unknownData: "must not drop" },
			{ events: [{ type: "tool", payload: { descriptor: { customer: "schema" } } }] },
		]) {
			const document = v2Graph();
			const changed = { ...document, mappings: [{ ...document.mappings[0]!, ...change }] };
			const before = structuredClone(changed);
			expect(migrateSessionAuthorityV2ToV3(Object.assign(v2Graph(), changed)).status).toBe("blocked");
			expect(changed).toEqual(before);
		}
	});

	test("canonicalizes absent and undefined object properties identically without accepting invalid arrays or objects", () => {
		const source = v2Graph();
		const optional = {
			...source,
			mappings: source.mappings.map(mapping => ({ ...mapping, unusedOptional: undefined })),
		};
		expect(encodeSessionAuthorityV3Document(migrated(optional))).toBe(
			encodeSessionAuthorityV3Document(migrated(source)),
		);
		for (const bad of [[undefined], [Number.POSITIVE_INFINITY], new Date(timestamp)]) {
			const invalid = Object.assign(v2Graph(), { mappings: [{ ...source.mappings[0], observations: { bad } }] });
			expect(migrateSessionAuthorityV2ToV3(invalid).status).toBe("blocked");
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(
			migrateSessionAuthorityV2ToV3(
				Object.assign(v2Graph(), { mappings: [{ ...source.mappings[0], observations: cyclic }] }),
			).status,
		).toBe("blocked");
		const nullable = {
			...source,
			mappings: source.mappings.map(mapping => ({ ...mapping, observations: { retained: null } })),
		};
		expect(migrated(nullable).mappings[0]!.observations).toEqual({ retained: null });
	});
});
