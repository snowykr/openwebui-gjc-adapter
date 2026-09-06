import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSessionAuthorityV3Document, parseSessionAuthorityV3Document } from "../src/gjc/session-authority-v3";
import {
	type ManagedTurnAuthorityBinding,
	migrateSessionAuthorityV2ToV3,
	type SessionAuthorityV2Document,
	stageSessionAuthorityV3Migration,
} from "../src/gjc/session-authority-v3-migration";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";

const binding = (sessionId: string, projectId = "project-a"): ManagedTurnAuthorityBinding => ({
	chatId: "chat-a",
	projectId,
	sessionId,
	managedAuthority: {
		principalId: "user-a",
		projectId,
		canonicalWorkspace: "/workspace/a",
		chatId: "chat-a",
		sessionId,
		generation: 1,
		leaseId: `lease-${sessionId}`,
		epoch: "epoch-1",
		requestKey: `request-${sessionId}`,
	},
});

function v2Graph(): SessionAuthorityV2Document {
	return {
		mappings: [
			{
				version: 2,
				chatId: "chat-a",
				projectId: "project-b",
				sessionId: "session-a",
				createdAt: "2026-01-01T00:00:00.000Z",
				header: { chatId: "chat-a", projectId: "project-b", sessionId: "session-a" },
				sessionFile: "/legacy/session.json",
				activeLeaf: "leaf-a",
				rawFrameCursor: 3,
				eventCursor: 2,
				operationId: "op-a",
				assistantText: "answer",
				observations: { preserved: true },
				attachment: { descriptor: "/legacy/session.json" },
				journal: [
					{
						id: "op-a",
						kind: "create",
						state: "pending",
						startedAt: "2026-01-01T00:00:00.000Z",
						acknowledgedSuccessor: { sessionId: "session-b", attachment: { descriptor: "discarded" } },
					},
				],
				reassignment: {
					state: "committed",
					sourceProjectId: "project-a",
					targetProjectId: "project-b",
					startedAt: "2026-01-01T00:00:00.000Z",
					sourceTombstone: tombstone(
						"session-a",
						"2026-01-02T00:00:00.000Z",
						tombstone("session-a", "2026-01-03T00:00:00.000Z"),
					),
				},
			} as unknown as SessionAuthorityV2Document["mappings"][number],
		],
		provisionalOperations: [
			{
				id: "op-p",
				kind: "prompt",
				state: "uncertain",
				startedAt: "2026-01-01T00:00:00.000Z",
				chatId: "chat-a",
				projectId: "project-b",
				sessionId: "session-a",
				sessionFile: "/legacy/session.json",
				attachment: { descriptor: "discarded" },
			} as unknown as NonNullable<SessionAuthorityV2Document["provisionalOperations"]>[number],
		],
	};
}

function tombstone(sessionId: string, retiredAt: string, prior?: unknown): unknown {
	return {
		version: 2,
		chatId: "chat-a",
		projectId: "project-a",
		sessionId,
		createdAt: "2026-01-01T00:00:00.000Z",
		header: { chatId: "chat-a", projectId: "project-a", sessionId },
		rawFrameCursor: 1,
		eventCursor: 1,
		operationId: "old-op",
		attachment: { tmuxPane: "legacy" },
		journal: [],
		retiredAt,
		prior,
	};
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fullBindings = () => [binding("session-a", "project-b"), binding("session-a"), binding("session-b", "project-b")];

function containsLegacyField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsLegacyField);
	if (value === null || typeof value !== "object") return false;
	return Object.entries(value as Record<string, unknown>).some(
		([key, item]) =>
			["attachment", "descriptor", "tmuxPane", "sessionFile", "activeLeaf"].includes(key) ||
			containsLegacyField(item),
	);
}

describe("SessionAuthority V2 to V3 graph migration", () => {
	test("opens, mutates, and reopens migrated runtime epochs without rewriting authority", () => {
		const migrated = migrateSessionAuthorityV2ToV3(v2Graph(), fullBindings());
		if (migrated.status !== "ready") throw new Error(migrated.reasons.join("\n"));
		const root = mkdtempSync(join(tmpdir(), "gjc-v3-migrated-epoch-"));
		const file = join(root, "authority.json");
		writeFileSync(file, encodeSessionAuthorityV3Document(migrated.document));
		let store: SessionV3FileBackedMappingStore | undefined;
		try {
			store = new SessionV3FileBackedMappingStore(file);
			expect(store.get("chat-a")?.managedAuthority?.epoch).toBe("epoch-1");
			store.beginOperation("chat-a", { id: "new-op", kind: "prompt", detail: "new-hash" });
			store.close();
			store = new SessionV3FileBackedMappingStore(file);
			expect(store.operation("chat-a", "new-op")?.state).toBe("uncertain");
			const persisted = parseSessionAuthorityV3Document(readFileSync(file, "utf8"))!;
			expect(persisted.mappings[0].managedAuthority.epoch).toBe("epoch-1");
			expect(persisted.mappings[0].journal[0].acknowledgedSuccessor?.managedAuthority.epoch).toBe("epoch-1");
			expect(persisted.mappings[0].reassignment?.sourceTombstone?.prior?.managedAuthority.epoch).toBe("epoch-1");
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("retains an unbound reservation without inventing session authority", () => {
		const source = {
			mappings: [],
			provisionalOperations: [
				{
					id: "reserved",
					kind: "prompt" as const,
					state: "pending" as const,
					startedAt: "2026-01-01T00:00:00.000Z",
					chatId: "chat-a",
					projectId: "project-a",
					detail: "hash",
				},
			],
		};
		const migrated = migrateSessionAuthorityV2ToV3(source, []);
		if (migrated.status !== "ready") throw new Error(migrated.reasons.join("\n"));
		expect(migrated.document.provisionalOperations).toEqual(source.provisionalOperations);
	});

	test("blocks opaque replay fields the strict codec cannot represent instead of stripping them", () => {
		const source = structuredClone(v2Graph());
		const event = {
			type: "tool-result",
			payload: { descriptor: { name: "customer-schema" }, attachment: { filename: "report.csv" } },
		};
		const withPayload = { ...source, mappings: [{ ...source.mappings[0], events: [event] }] };
		const before = structuredClone(withPayload);
		expect(migrateSessionAuthorityV2ToV3(withPayload, fullBindings())).toMatchObject({ status: "blocked" });
		expect(withPayload).toEqual(before);
	});

	test("retains ordinary nested replay payload bytes", () => {
		const source = v2Graph();
		const events = [{ type: "tool-result", payload: { customer: { schema: ["id", "name"] }, content: "verbatim" } }];
		const migrated = migrateSessionAuthorityV2ToV3(
			{ ...source, mappings: [{ ...source.mappings[0], events }] },
			fullBindings(),
		);
		if (migrated.status !== "ready") throw new Error(migrated.reasons.join("\n"));
		expect(migrated.document.mappings[0].events).toEqual(events);
	});

	test("converts the complete graph, including recursive tombstones and successor authority", () => {
		const migrated = migrateSessionAuthorityV2ToV3(v2Graph(), fullBindings());
		expect(migrated.status).toBe("ready");
		if (migrated.status !== "ready") return;
		expect(migrated.document.mappings[0].managedAuthority.sessionId).toBe("session-a");
		expect(migrated.document.mappings[0].journal[0].acknowledgedSuccessor?.managedAuthority.sessionId).toBe(
			"session-b",
		);
		expect(migrated.document.mappings[0].reassignment?.sourceTombstone?.prior?.managedAuthority.sessionId).toBe(
			"session-a",
		);
		expect(migrated.document.provisionalOperations[0].managedAuthority!.sessionId).toBe("session-a");
	});

	test("preserves the original snapshot bytes and stages deterministic private V3 bytes", () => {
		const base = new TextEncoder().encode('{"v2":"base"}');
		const wal = new TextEncoder().encode('{"v2":"wal"}');
		const snapshot = {
			originalBaseBytes: base,
			originalBaseDigest: sha256(base),
			originalWalBytes: wal,
			originalWalDigest: sha256(wal),
		};
		const first = stageSessionAuthorityV3Migration({
			snapshot,
			decodedDocument: v2Graph(),
			bindings: fullBindings(),
		});
		const second = stageSessionAuthorityV3Migration({
			snapshot,
			decodedDocument: v2Graph(),
			bindings: fullBindings(),
		});
		expect(first.status).toBe("staged");
		expect(second.status).toBe("staged");
		if (first.status !== "staged" || second.status !== "staged") return;
		expect([...base]).toEqual([...first.originalBaseBytes]);
		expect([...wal]).toEqual([...first.originalWalBytes]);
		expect([...first.v3Bytes]).toEqual([...second.v3Bytes]);
		expect(first.v3Digest).toBe(second.v3Digest);
	});

	test("blocks absent, duplicate, and ambiguous successor bindings without an output document", () => {
		const absent = migrateSessionAuthorityV2ToV3(v2Graph(), [binding("session-a", "project-b")]);
		const duplicate = migrateSessionAuthorityV2ToV3(v2Graph(), [
			...fullBindings(),
			binding("session-a", "project-b"),
		]);
		expect(absent).toEqual(expect.objectContaining({ status: "blocked" }));
		expect(duplicate).toEqual(expect.objectContaining({ status: "blocked" }));
	});

	test("removes owned legacy authority fields while retaining observations", () => {
		const migrated = migrateSessionAuthorityV2ToV3(v2Graph(), fullBindings());
		if (migrated.status !== "ready") throw new Error(migrated.reasons.join("\n"));
		expect(containsLegacyField(migrated.document)).toBe(false);
		expect(migrated.document.mappings[0].observations).toEqual({ preserved: true });
	});

	test.each(["mapping", "tombstone"] as const)("blocks opaque legacy-named %s observations without loss", target => {
		const source = structuredClone(v2Graph());
		const owner = target === "mapping" ? source.mappings[0] : source.mappings[0].reassignment!.sourceTombstone!;
		Object.assign(owner, {
			observations: {
				descriptor: { name: "customer-schema" },
				attachment: { filename: "report.csv" },
				preserved: true,
			},
		});
		const before = structuredClone(source);
		expect(migrateSessionAuthorityV2ToV3(source, fullBindings())).toMatchObject({ status: "blocked" });
		expect(source).toEqual(before);
	});
});
