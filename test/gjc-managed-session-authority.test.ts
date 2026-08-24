import { describe, expect, test } from "bun:test";
import { MANAGED_LIFECYCLE_STATES, MANAGED_LIFECYCLE_TRANSITIONS } from "../src/gjc/managed-lifecycle-state";
import {
	copyManagedSessionAuthorityMigrationCheckpoint,
	copyManagedSessionAuthorityRecord,
	decodeManagedSessionAuthorityRecord,
	encodeManagedSessionAuthorityRecord,
	isManagedSessionAuthorityRecord,
	type LegacyManagedSessionAuthorityEvidence,
	MANAGED_SESSION_AUTHORITY_EPOCH,
	type ManagedSessionAuthorityRecord,
	managedSessionAuthorityHash,
	managedSessionAuthorityIdentity,
	parseManagedSessionAuthorityRecord,
	planManagedSessionAuthorityMigration,
	transitionManagedSessionAuthorityRecord,
} from "../src/gjc/managed-session-authority";

const digest = (character: string) => character.repeat(64);
const evidence: LegacyManagedSessionAuthorityEvidence = {
	sourceDigest: digest("a"),
	backupDigest: digest("b"),
	walDigest: digest("c"),
	targetManifestDigest: digest("d"),
	records: [
		{
			principalId: "principal-1",
			projectId: "project-1",
			canonicalWorkspace: "/work/project-1",
			chatId: "chat-1",
			sessionId: "session-1",
			sessionFile: "/work/project-1/.gjc/sessions/session-1.jsonl",
			operationId: "operation-1",
			assistantText: "Completed.",
			events: [{ type: "assistant", id: "message-1", text: "Completed.", payload: { sequence: 1 } }],
			modelSelection: { provider: "openai", modelId: "gpt-5", thinkingLevel: "low" },
			rawFrameCursor: 1,
			eventCursor: 2,
			activeLeaf: "message-1",
		},
	],
};

function record(
	state: ManagedSessionAuthorityRecord["lifecycle"]["state"] = "intent_prepared",
): ManagedSessionAuthorityRecord {
	return {
		authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
		principalId: "principal-1",
		projectId: "project-1",
		canonicalWorkspace: "/work/project-1",
		chatId: "chat-1",
		sessionId: "session-1",
		generation: 1,
		operationHash: digest("1"),
		requestHash: digest("2"),
		payloadHash: digest("3"),
		sessionFile: "/work/project-1/.gjc/sessions/session-1.jsonl",
		operationId: "operation-1",
		assistantText: "Completed.",
		events: [{ type: "assistant", id: "message-1", text: "Completed.", payload: { sequence: 1 } }],
		modelSelection: { provider: "openai", modelId: "gpt-5", thinkingLevel: "low" },
		session: { sessionId: "session-1", observedAt: "2026-01-01T00:00:00.000Z" },
		projection: { rawFrameCursor: 1, eventCursor: 2, activeLeaf: "message-1" },
		lifecycle: { state, recordedAt: "2026-01-01T00:00:00.000Z" },
	};
}

describe("managed session authority", () => {
	test("round-trips a canonical credential-free v3 authority record", () => {
		const original = record();
		const encoded = encodeManagedSessionAuthorityRecord(original);
		expect(encoded).toBe(
			JSON.stringify({
				authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
				principalId: "principal-1",
				projectId: "project-1",
				canonicalWorkspace: "/work/project-1",
				chatId: "chat-1",
				sessionId: "session-1",
				generation: 1,
				operationHash: digest("1"),
				requestHash: digest("2"),
				payloadHash: digest("3"),
				sessionFile: "/work/project-1/.gjc/sessions/session-1.jsonl",
				operationId: "operation-1",
				assistantText: "Completed.",
				events: original.events,
				modelSelection: original.modelSelection,
				session: original.session,
				projection: original.projection,
				lifecycle: original.lifecycle,
			}),
		);
		expect(decodeManagedSessionAuthorityRecord(encoded)).toEqual(original);
		expect(encoded).not.toMatch(/attachment|endpoint|token|descriptor|tmux|pid/i);
	});

	test("rejects credentials, private attachments, undeclared fields, invalid generation, and tenant fences", () => {
		for (const invalid of [
			{ ...record(), token: "secret" },
			{ ...record(), attachment: { descriptorPath: "/private" } },
			{ ...record(), generation: 0 },
			{ ...record(), generation: 1.5 },
			{ ...record(), operationHash: "ABC" },
			{ ...record(), operationId: "" },
			{ ...record(), sessionFile: "relative.jsonl" },
			{ ...record(), sessionFile: "/work/project-1/.gjc/sessions/../outside.jsonl" },
			{ ...record(), sessionFile: "/work/project-1/private/session.jsonl" },
			{ ...record(), events: [{ type: "assistant", token: "secret" }] },
			{ ...record(), modelSelection: { provider: "openai", modelId: "gpt-5", thinkingLevel: "invalid" } },
			{ ...record(), session: { ...record().session, sessionId: "other-session" } },
			{ ...record(), lifecycle: { ...record().lifecycle, state: "active" } },
		]) {
			expect(isManagedSessionAuthorityRecord(invalid)).toBeFalse();
			expect(() => parseManagedSessionAuthorityRecord(invalid)).toThrow();
		}
	});

	test("accepts only canonical session paths under default or recorded registered roots", () => {
		const registeredRoot = "/durable/project-1-sessions";
		const alternateRootRecord = {
			...record(),
			projectSessionRoot: registeredRoot,
			sessionFile: `${registeredRoot}/session-1.jsonl`,
		};
		expect(isManagedSessionAuthorityRecord(alternateRootRecord)).toBeTrue();
		expect(
			isManagedSessionAuthorityRecord({ ...alternateRootRecord, projectSessionRoot: `${registeredRoot}/..` }),
		).toBeFalse();
		expect(
			isManagedSessionAuthorityRecord({ ...alternateRootRecord, sessionFile: "/durable/other/session-1.jsonl" }),
		).toBeFalse();
	});

	test("uses the existing lifecycle transition fence for every state and illegal edge", () => {
		for (const from of MANAGED_LIFECYCLE_STATES) {
			for (const to of MANAGED_LIFECYCLE_STATES) {
				const legal = MANAGED_LIFECYCLE_TRANSITIONS[from].includes(to);
				const call = () => transitionManagedSessionAuthorityRecord(record(from), to, "2026-01-02T00:00:00.000Z");
				if (legal) expect(call()).toMatchObject({ lifecycle: { state: to } });
				else expect(call).toThrow();
			}
		}
	});

	test("copies without aliasing and produces deterministic identity and full-record hashes", () => {
		const original = record();
		const copied = copyManagedSessionAuthorityRecord(original);
		expect(copied).toEqual(original);
		expect(copied.session).not.toBe(original.session);
		expect(copied.projection).not.toBe(original.projection);
		expect(copied.events).not.toBe(original.events);
		expect(copied.events?.[0]).not.toBe(original.events?.[0]);
		expect(copied.modelSelection).not.toBe(original.modelSelection);
		expect(managedSessionAuthorityIdentity(copied)).toBe(managedSessionAuthorityIdentity(original));
		expect(managedSessionAuthorityHash(copied)).toBe(managedSessionAuthorityHash(original));
		expect(
			managedSessionAuthorityIdentity({
				...original,
				lifecycle: { ...original.lifecycle, recordedAt: "2026-01-02T00:00:00.000Z" },
			}),
		).toBe(managedSessionAuthorityIdentity(original));
	});

	test("plans inactive staged checkpoints idempotently and blocks missing or ambiguous identities", () => {
		const checkpoint = planManagedSessionAuthorityMigration(evidence);
		expect(checkpoint).toEqual({
			authorityEpoch: MANAGED_SESSION_AUTHORITY_EPOCH,
			digests: {
				sourceDigest: digest("a"),
				backupDigest: digest("b"),
				walDigest: digest("c"),
				targetManifestDigest: digest("d"),
			},
			records: [
				{
					identity: JSON.stringify(["principal-1", "project-1", "/work/project-1", "chat-1", "session-1"]),
					status: "intent_prepared",
					intent: {
						principalId: "principal-1",
						projectId: "project-1",
						canonicalWorkspace: "/work/project-1",
						chatId: "chat-1",
						sessionId: "session-1",
						sessionFile: "/work/project-1/.gjc/sessions/session-1.jsonl",
						operationId: "operation-1",
						assistantText: "Completed.",
						events: [{ type: "assistant", id: "message-1", text: "Completed.", payload: { sequence: 1 } }],
						modelSelection: { provider: "openai", modelId: "gpt-5", thinkingLevel: "low" },
						rawFrameCursor: 1,
						eventCursor: 2,
						activeLeaf: "message-1",
					},
				},
			],
			canonicalReplaced: false,
			activeMarkerReady: false,
		});
		expect(planManagedSessionAuthorityMigration(evidence, checkpoint)).toEqual(checkpoint);
		expect(planManagedSessionAuthorityMigration(evidence, checkpoint)).not.toBe(checkpoint);
		expect(copyManagedSessionAuthorityMigrationCheckpoint(checkpoint)).toEqual(checkpoint);
		const copiedIntent = copyManagedSessionAuthorityMigrationCheckpoint(checkpoint).records[0]?.intent;
		expect(copiedIntent).not.toBe(checkpoint.records[0]?.intent);
		expect(copiedIntent?.events).not.toBe(checkpoint.records[0]?.intent?.events);
		expect(
			planManagedSessionAuthorityMigration({
				...evidence,
				records: [
					{ ...evidence.records[0], principalId: undefined },
					{ ...evidence.records[0], sessionId: "" },
				],
			}).records,
		).toEqual([
			{ identity: "legacy:0", status: "migration_blocked", reason: "missing or ambiguous tenant identity" },
			{ identity: "legacy:1", status: "migration_blocked", reason: "missing or ambiguous tenant identity" },
		]);
		expect(
			planManagedSessionAuthorityMigration({ ...evidence, records: [evidence.records[0]!, evidence.records[0]!] })
				.records,
		).toEqual([
			{ identity: "legacy:0", status: "migration_blocked", reason: "missing or ambiguous tenant identity" },
			{ identity: "legacy:1", status: "migration_blocked", reason: "missing or ambiguous tenant identity" },
		]);
	});

	test("does not mutate legacy evidence or user path-like data", () => {
		const pathLikeEvidence = {
			...evidence,
			records: [{ ...evidence.records[0], canonicalWorkspace: "/users/alice/project" }],
		};
		const before = JSON.stringify(pathLikeEvidence);
		const checkpoint = planManagedSessionAuthorityMigration(pathLikeEvidence);
		expect(JSON.stringify(pathLikeEvidence)).toBe(before);
		expect(checkpoint.records[0]?.status).toBe("intent_prepared");
	});
});
