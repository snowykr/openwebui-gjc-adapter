import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertManagedLifecycleEvidenceUpdate,
	copyManagedLifecycleEvidence,
	createManagedLifecycleEvidence,
	createManagedRetirementEvidence,
	isManagedLifecycleEvidence,
	type ManagedHistoricalLifecycleSource,
	type ManagedHistoricalSavedSession,
	type ManagedLifecycleEvidence,
	managedLifecycleEvidenceHash,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import {
	assertManagedLifecycleTransition,
	canTransitionManagedLifecycleState,
	decodeManagedLifecycleState,
	encodeManagedLifecycleState,
	MANAGED_LIFECYCLE_STATES,
	MANAGED_LIFECYCLE_TRANSITIONS,
	ManagedLifecycleStateError,
	parseManagedLifecycleState,
} from "../src/gjc/managed-lifecycle-state";
import { copyOperation, copyProvisionalOperation } from "../src/gjc/session-authority-copy";
import type { HistoricalSessionBinding } from "../src/gjc/session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	type ManagedTurnAuthorityV3,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Mapping,
	type SessionAuthorityV3Operation,
	type SessionAuthorityV3Result,
} from "../src/gjc/session-authority-v3";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import type {
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "../src/gjc/turn-runner";

const EXPECTED_TRANSITIONS = {
	intent_prepared: ["invoking", "terminal_failure"],
	invoking: ["acknowledged_unproven", "terminal_failure", "uncertain", "cleanup_pending"],
	acknowledged_unproven: ["active_generation_proven", "cleanup_pending", "uncertain", "retired", "cleanup_uncertain"],
	active_generation_proven: ["closing"],
	closing: ["active_generation_proven", "retired", "uncertain"],
	retired: [],
	terminal_failure: [],
	uncertain: [
		"acknowledged_unproven",
		"active_generation_proven",
		"retired",
		"terminal_failure",
		"cleanup_pending",
		"cleanup_uncertain",
	],
	cleanup_pending: ["invoking", "cleanup_uncertain"],
	cleanup_uncertain: ["cleanup_pending", "retired", "uncertain"],
} as const;

describe("managed lifecycle state", () => {
	test("retains ambiguous temporary cleanup after acknowledgement without restoring routing", () => {
		expect(() => assertManagedLifecycleTransition("acknowledged_unproven", "cleanup_uncertain")).not.toThrow();
		expect(decodeManagedLifecycleState(encodeManagedLifecycleState("cleanup_uncertain"))).toBe("cleanup_uncertain");
		expect(() => assertManagedLifecycleTransition("cleanup_uncertain", "active_generation_proven")).toThrow(
			ManagedLifecycleStateError,
		);
		expect(() => assertManagedLifecycleTransition("retired", "cleanup_uncertain")).toThrow(
			ManagedLifecycleStateError,
		);
	});
	test("accepts every and only normative lifecycle edge", () => {
		expect(MANAGED_LIFECYCLE_TRANSITIONS).toEqual(EXPECTED_TRANSITIONS);
		for (const from of MANAGED_LIFECYCLE_STATES) {
			for (const to of MANAGED_LIFECYCLE_STATES) {
				const legal = (EXPECTED_TRANSITIONS[from] as readonly string[]).includes(to);
				expect(canTransitionManagedLifecycleState(from, to)).toBe(legal);
				if (legal) expect(() => assertManagedLifecycleTransition(from, to)).not.toThrow();
				else expect(() => assertManagedLifecycleTransition(from, to)).toThrow(ManagedLifecycleStateError);
			}
		}
	});

	test("round-trips only the credential-free state codec", () => {
		for (const state of MANAGED_LIFECYCLE_STATES) {
			const encoded = encodeManagedLifecycleState(state);
			expect(encoded).toBe(JSON.stringify({ state }));
			expect(decodeManagedLifecycleState(encoded)).toBe(state);
			expect(encoded).not.toContain("token");
			expect(encoded).not.toContain("url");
		}
	});

	test("rejects malformed and unknown codec values", () => {
		for (const malformed of [
			undefined,
			null,
			"",
			"{}",
			"[]",
			'{"state":"unknown"}',
			'{"state":"retired","extra":true}',
		]) {
			expect(() => decodeManagedLifecycleState(malformed)).toThrow(ManagedLifecycleStateError);
		}
		expect(() => parseManagedLifecycleState("active")).toThrow(ManagedLifecycleStateError);
	});
});

const time = "2026-09-06T14:00:00.000Z";
const later = "2026-09-06T14:00:01.000Z";
const payloadHash = "a".repeat(64);
const prepared: ManagedPreparedTurnAuthority = {
	principalId: "owner",
	projectId: "project",
	canonicalWorkspace: "/workspace/project",
	chatId: "logical-chat",
	leaseId: "lease",
	epoch: "runtime-epoch",
	requestKey: "lifecycle-key",
};
const source: ManagedTurnAuthority = { ...prepared, requestKey: "prior-key", sessionId: "source", generation: 1 };
const acknowledged: ManagedTurnAuthority = { ...prepared, sessionId: "created", generation: 2 };
const proven: ManagedGenerationProof = {
	kind: "managed-generation",
	sessionId: "created",
	generation: 2,
	leaseId: prepared.leaseId,
	epoch: prepared.epoch,
};
function createEvidence() {
	return createManagedLifecycleEvidence(
		{
			operation: "session.create",
			preparedAuthority: prepared,
			target: { path: prepared.canonicalWorkspace, kind: "existing_path" },
			payloadHash,
		},
		time,
	);
}
function acknowledgedEvidence() {
	return transitionManagedLifecycleEvidence(
		transitionManagedLifecycleEvidence(createEvidence(), "invoking", {}, time),
		"acknowledged_unproven",
		{ acknowledged },
		later,
	);
}

function bootstrapSource(): ManagedHistoricalLifecycleSource {
	return {
		kind: "bootstrap-history",
		manifestDigest: "c".repeat(64),
		historicalBinding: {
			kind: "unbound-history",
			chatId: JSON.stringify([prepared.principalId, prepared.chatId]),
			projectId: prepared.projectId,
			sessionId: "original-full-session-id",
			principalId: prepared.principalId,
			reason: "ownership-unresolved",
			provenance: { source: "v2", documentHash: "d".repeat(64), nodeRef: "/mappings/0", nodeHash: "e".repeat(64) },
		},
		savedSession: {
			id: "original-full-session-id",
			path: "/workspace/project/.gjc/sessions/original.jsonl",
			identity: {
				dev: "66306",
				ino: "1481656",
				size: 3671,
				mtimeMs: 1788717200450.25,
				mtimeNs: "1788717200450003321",
				sha256: "b".repeat(64),
				nlink: "1",
				ctimeNs: "1788717200450003321",
			},
		},
	};
}
function bootstrapTarget(savedSession: ManagedHistoricalSavedSession): Readonly<Record<string, unknown>> {
	const { nlink: _nlink, ctimeNs: _ctimeNs, ...sessionIdentity } = savedSession.identity;
	return {
		sessionId: savedSession.id,
		cwd: prepared.canonicalWorkspace,
		sessionPath: savedSession.path,
		sessionIdentity,
	};
}
function bootstrapEvidence(
	historicalSource = bootstrapSource(),
	target = bootstrapTarget(historicalSource.savedSession),
) {
	return createManagedLifecycleEvidence(
		{ operation: "session.resume", historicalSource, preparedAuthority: prepared, target, payloadHash },
		time,
	);
}
function documentWith(evidence?: ManagedLifecycleEvidence): SessionAuthorityV3Document {
	const chatId = JSON.stringify([prepared.principalId, prepared.chatId]);
	return {
		kind: SESSION_AUTHORITY_V3_KIND,
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		mappings: [],
		provisionalOperations: [
			{
				id: "ingress",
				kind: "create",
				state: "pending",
				startedAt: time,
				chatId,
				projectId: prepared.projectId,
				detail: payloadHash,
				...(evidence === undefined ? {} : { lifecycle: evidence }),
			},
		],
	};
}

function journalDocument(operation: SessionAuthorityV3Operation): SessionAuthorityV3Document & {
	readonly mappings: readonly [
		Extract<SessionAuthorityV3Mapping, { readonly managedAuthority: ManagedTurnAuthorityV3 }>,
	];
} {
	const chatId = JSON.stringify([prepared.principalId, prepared.chatId]);
	return {
		...documentWith(),
		provisionalOperations: [],
		mappings: [
			{
				version: 3,
				authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
				chatId,
				projectId: prepared.projectId,
				sessionId: source.sessionId,
				createdAt: time,
				header: { chatId, projectId: prepared.projectId, sessionId: source.sessionId },
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "prior",
				managedAuthority: { ...source, chatId, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH },
				journal: [structuredClone(operation)],
			},
		],
	};
}

function lifecycleResult(
	authority: ManagedTurnAuthority,
	kind: SessionAuthorityV3Result["kind"] = "turn",
): Extract<SessionAuthorityV3Result, { readonly managedAuthority: ManagedTurnAuthorityV3 }> {
	const chatId = JSON.stringify([authority.principalId, authority.chatId]);
	return {
		kind,
		assistantText: "recorded result",
		managedAuthority: { ...authority, chatId, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH },
		mapping: {
			chatId,
			projectId: authority.projectId,
			sessionId: authority.sessionId,
			rawFrameCursor: 1,
			eventCursor: 1,
			operationId: "ingress",
		},
		...(kind === "close" ? { correlation: { closeStatus: "closed" } } : {}),
	};
}

function completeLifecycleOperation(
	lifecycle: ManagedLifecycleEvidence,
	kind: SessionAuthorityV3Operation["kind"] = "create",
	result = lifecycleResult(acknowledged),
): SessionAuthorityV3Operation {
	return {
		id: "ingress",
		kind,
		state: "complete",
		startedAt: time,
		completedAt: later,
		detail: payloadHash,
		lifecycle: structuredClone(lifecycle),
		result: structuredClone(result),
	};
}

function referencedCloseDocument(): SessionAuthorityV3Document {
	const active = transitionManagedLifecycleEvidence(
		acknowledgedEvidence(),
		"active_generation_proven",
		{ proven },
		later,
	);
	const prior = completeLifecycleOperation(active);
	const closeSource = { ...acknowledged, requestKey: "latest-prompt-key" };
	const startedAt = "2026-09-06T14:00:02.000Z";
	const lifecycle = createManagedRetirementEvidence(
		{
			operation: "session.close",
			preparedAuthority: { ...prepared, requestKey: "close-key" },
			source: closeSource,
			sourceOperationId: prior.id,
			sourceEvidence: active,
			target: { sessionId: closeSource.sessionId, endpointGeneration: closeSource.generation },
			payloadHash,
		},
		startedAt,
	);
	const close: SessionAuthorityV3Operation = {
		id: "close",
		kind: "close",
		state: "pending",
		startedAt,
		detail: payloadHash,
		lifecycle,
	};
	const document = journalDocument(prior);
	const mapping = document.mappings[0]!;
	return {
		...document,
		mappings: [
			{
				...mapping,
				sessionId: closeSource.sessionId,
				header: { ...mapping.header, sessionId: closeSource.sessionId },
				managedAuthority: { ...closeSource, chatId: mapping.chatId, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH },
				journal: [prior, close],
			},
		],
	};
}

describe("canonical managed lifecycle evidence", () => {
	test("bootstraps exact historical session identity without inventing a source generation", () => {
		for (const size of [0, 3671, Number.MAX_SAFE_INTEGER]) {
			const historicalSource = bootstrapSource();
			const selected = {
				...historicalSource,
				savedSession: {
					...historicalSource.savedSession,
					identity: { ...historicalSource.savedSession.identity, size },
				},
			};
			const intent = bootstrapEvidence(selected);
			const original = structuredClone(selected);
			const ack: ManagedTurnAuthority = {
				...prepared,
				sessionId: historicalSource.historicalBinding.sessionId!,
				generation: 27,
			};
			const proof: ManagedGenerationProof = {
				kind: "managed-generation",
				sessionId: ack.sessionId,
				generation: ack.generation,
				leaseId: ack.leaseId,
				epoch: ack.epoch,
			};
			const invoking = transitionManagedLifecycleEvidence(intent, "invoking", {}, time);
			const acknowledged = transitionManagedLifecycleEvidence(
				invoking,
				"acknowledged_unproven",
				{ acknowledged: ack },
				later,
			);
			const active = transitionManagedLifecycleEvidence(
				acknowledged,
				"active_generation_proven",
				{ proven: proof },
				later,
			);
			expect(isManagedLifecycleEvidence(active)).toBe(true);
			expect(active.source).toBeUndefined();
			expect(active.historicalSource).toEqual(original);
			expect(active.historicalSource!.historicalBinding).not.toHaveProperty("generation");
			expect(active.historicalSource!.historicalBinding.canonicalWorkspace).toBeUndefined();
			expect(active.acknowledged!.generation).toBe(27);
			expect(selected).toEqual(original);
		}
	});

	test("keeps the full bootstrap source immutable and includes it in evidence hashing but not public request hashing", () => {
		const intent = bootstrapEvidence();
		expect(transitionManagedLifecycleEvidence(intent, intent.state)).toEqual(intent);
		expect(() => assertManagedLifecycleEvidenceUpdate(intent, structuredClone(intent))).not.toThrow();
		const differentManifest = bootstrapEvidence({ ...bootstrapSource(), manifestDigest: "f".repeat(64) });
		const changedOccurrence = bootstrapEvidence({
			...bootstrapSource(),
			historicalBinding: {
				...bootstrapSource().historicalBinding,
				provenance: { ...bootstrapSource().historicalBinding.provenance, nodeRef: "/mappings/1" },
			},
		});
		for (const changed of [differentManifest, changedOccurrence]) {
			expect(isManagedLifecycleEvidence(changed)).toBe(true);
			expect(changed.requestHash).toBe(intent.requestHash);
			expect(managedLifecycleEvidenceHash(changed)).not.toBe(managedLifecycleEvidenceHash(intent));
			expect(() => assertManagedLifecycleEvidenceUpdate(intent, changed)).toThrow(
				"Immutable managed lifecycle identity changed: historicalSource",
			);
		}
		const copied = copyManagedLifecycleEvidence(intent);
		const operation = copyOperation({
			id: "bootstrap",
			kind: "resume",
			state: "pending",
			startedAt: time,
			lifecycle: intent,
		});
		expect(copied.historicalSource).not.toBe(intent.historicalSource);
		expect(copied.historicalSource!.historicalBinding.provenance).not.toBe(
			intent.historicalSource!.historicalBinding.provenance,
		);
		expect(operation.lifecycle!.historicalSource!.historicalBinding.provenance).not.toBe(
			intent.historicalSource!.historicalBinding.provenance,
		);
		expect(copied.historicalSource!.savedSession.identity).not.toBe(intent.historicalSource!.savedSession.identity);
		expect(operation.lifecycle!.historicalSource!.savedSession.identity).not.toBe(
			intent.historicalSource!.savedSession.identity,
		);
		expect(copied).toEqual(intent);
	});

	test("rejects mixed sources, non-resume historical branches and malformed manifest or provenance", () => {
		const intent = bootstrapEvidence();
		for (const operation of ["session.create", "session.fork", "session.close", "session.delete"] as const)
			expect(() =>
				createManagedLifecycleEvidence(
					{
						operation,
						preparedAuthority: prepared,
						historicalSource: bootstrapSource(),
						target: intent.target,
						payloadHash,
					},
					time,
				),
			).toThrow();
		for (const changed of [
			{ ...intent, source },
			{ ...intent, sourceProofRef: { operationId: "prior", evidenceHash: "b".repeat(64) } },
			...["", "A".repeat(64), "0".repeat(63), `sha256:${"a".repeat(64)}`].map(manifestDigest => ({
				...intent,
				historicalSource: { ...bootstrapSource(), manifestDigest },
			})),
			{ ...intent, historicalSource: { ...bootstrapSource(), extra: true } },
			{
				...intent,
				historicalSource: {
					...bootstrapSource(),
					historicalBinding: { ...bootstrapSource().historicalBinding, generation: 1 },
				},
			},
			{
				...intent,
				historicalSource: {
					...bootstrapSource(),
					historicalBinding: {
						...bootstrapSource().historicalBinding,
						provenance: { ...bootstrapSource().historicalBinding.provenance, nodeRef: "not-a-pointer" },
					},
				},
			},
		])
			expect(isManagedLifecycleEvidence(changed)).toBe(false);
	});

	test("binds optional original ownership and full session identity to the current prepared scope", () => {
		const original = bootstrapSource();
		const { sessionId: _sessionId, ...missingSession } = original.historicalBinding;
		expect(() => bootstrapEvidence({ ...original, historicalBinding: missingSession })).toThrow();
		for (const patch of [
			{ principalId: "foreign" },
			{ projectId: "foreign" },
			{ chatId: "foreign" },
			{ canonicalWorkspace: "/foreign", reason: "generation-unproven" },
			{ sessionId: "" },
		])
			expect(
				isManagedLifecycleEvidence({
					...bootstrapEvidence(),
					historicalSource: { ...original, historicalBinding: { ...original.historicalBinding, ...patch } },
				}),
			).toBe(false);
		const { principalId: _principal, ...unowned } = original.historicalBinding;
		const logical: HistoricalSessionBinding = { ...unowned, chatId: prepared.chatId };
		expect(isManagedLifecycleEvidence(bootstrapEvidence({ ...original, historicalBinding: logical }))).toBe(true);
		const known: HistoricalSessionBinding = {
			...original.historicalBinding,
			canonicalWorkspace: prepared.canonicalWorkspace,
			reason: "generation-unproven",
		};
		expect(isManagedLifecycleEvidence(bootstrapEvidence({ ...original, historicalBinding: known }))).toBe(true);
	});

	test("limits bootstrap public resume target to exact saved selection without prefix or readiness fallback", () => {
		const original = bootstrapSource();
		const target = bootstrapTarget(original.savedSession);
		const { nlink: _nlink, ctimeNs: _ctimeNs, ...sessionIdentity } = original.savedSession.identity;
		for (const changed of [
			{ ...target, sessionId: "original" },
			{ ...target, cwd: "/foreign" },
			{ ...target, sessionPath: "/workspace/project/.gjc/sessions/other.jsonl" },
			{ sessionIdOrPrefix: original.savedSession.id, path: prepared.canonicalWorkspace },
			{ sessionId: original.savedSession.id, cwd: prepared.canonicalWorkspace },
			...[
				"sessionIdOrPrefix",
				"path",
				"readinessTimeoutMs",
				"body",
				"modelPreset",
				"source",
				"endpointGeneration",
				"descriptor",
				"token",
			].map(key => ({ ...target, [key]: "forbidden" })),
			{ ...target, sessionIdentity: original.savedSession.identity },
			{ ...target, sessionIdentity: { ...sessionIdentity, nlink: original.savedSession.identity.nlink } },
			{ ...target, sessionIdentity: { ...sessionIdentity, ctimeNs: original.savedSession.identity.ctimeNs } },
			{ ...target, sessionIdentity: { ...original.savedSession.identity, nlink: undefined, ctimeNs: undefined } },
		])
			expect(() => bootstrapEvidence(original, changed)).toThrow();
	});

	test("rejects unsafe saved paths and malformed public saved-session identity without filesystem access", () => {
		const original = bootstrapSource();
		const evidence = bootstrapEvidence(original);
		const { savedSession: _saved, ...missingSaved } = original;
		expect(isManagedLifecycleEvidence({ ...evidence, historicalSource: missingSaved })).toBe(false);
		for (const field of Object.keys(original.savedSession.identity)) {
			const identity = Object.fromEntries(
				Object.entries(original.savedSession.identity).filter(([key]) => key !== field),
			);
			expect(
				isManagedLifecycleEvidence({
					...evidence,
					historicalSource: { ...original, savedSession: { ...original.savedSession, identity } },
				}),
			).toBe(false);
		}
		for (const patch of [
			{ id: "foreign-session" },
			{ path: "/foreign/original.jsonl" },
			{ path: "/workspace/project-sibling/original.jsonl" },
			{ path: "/workspace/project/../project/original.jsonl" },
			{ path: "/workspace/project/./original.jsonl" },
			{ path: "/workspace/project//original.jsonl" },
			{ path: "/workspace/project/original.jsonl/" },
			{ path: "relative.jsonl" },
			{ path: "/workspace/project" },
			{ path: "/workspace/project/unsafe\u0000.jsonl" },
			{ extra: "not-public" },
		])
			expect(
				isManagedLifecycleEvidence({
					...evidence,
					historicalSource: { ...original, savedSession: { ...original.savedSession, ...patch } },
				}),
			).toBe(false);
		for (const field of ["dev", "ino", "mtimeNs", "nlink", "ctimeNs"] as const)
			for (const invalid of ["", "-1", "+1", "1.0", "1e3", " 1", "0x10", 1])
				expect(
					isManagedLifecycleEvidence({
						...evidence,
						historicalSource: {
							...original,
							savedSession: {
								...original.savedSession,
								identity: { ...original.savedSession.identity, [field]: invalid },
							},
						},
					}),
				).toBe(false);
		for (const patch of [
			{ size: -1 },
			{ size: 1.5 },
			{ size: Number.MAX_SAFE_INTEGER + 1 },
			{ size: "1" },
			{ mtimeMs: -1 },
			{ mtimeMs: Number.POSITIVE_INFINITY },
			{ mtimeMs: NaN },
			{ mtimeMs: "1" },
			{ sha256: "A".repeat(64) },
			{ sha256: "b".repeat(63) },
			{ extra: 1 },
		])
			expect(
				isManagedLifecycleEvidence({
					...evidence,
					historicalSource: {
						...original,
						savedSession: { ...original.savedSession, identity: { ...original.savedSession.identity, ...patch } },
					},
				}),
			).toBe(false);
	});

	test("requires the exact six-field identity projection and binds saved receipt changes under the same key", () => {
		const original = bootstrapSource();
		const intent = bootstrapEvidence(original);
		const { nlink: _nlink, ctimeNs: _ctimeNs, ...projection } = original.savedSession.identity;
		expect(intent.target.sessionIdentity).toEqual(projection);
		for (const field of Object.keys(projection)) {
			const sessionIdentity = Object.fromEntries(Object.entries(projection).filter(([key]) => key !== field));
			expect(() => bootstrapEvidence(original, { ...intent.target, sessionIdentity })).toThrow();
		}
		for (const patch of [
			{ dev: "7" },
			{ ino: "8" },
			{ size: 9 },
			{ mtimeMs: 10 },
			{ mtimeNs: "11" },
			{ sha256: "a".repeat(64) },
		]) {
			expect(() =>
				bootstrapEvidence(original, { ...intent.target, sessionIdentity: { ...projection, ...patch } }),
			).toThrow();
			const changed = bootstrapEvidence({
				...original,
				savedSession: { ...original.savedSession, identity: { ...original.savedSession.identity, ...patch } },
			});
			expect(isManagedLifecycleEvidence(changed)).toBe(true);
			expect(changed.requestKey).toBe(intent.requestKey);
			expect(changed.requestHash).not.toBe(intent.requestHash);
			expect(() => assertManagedLifecycleEvidenceUpdate(intent, changed)).toThrow("Immutable");
		}
		for (const patch of [{ nlink: "2" }, { ctimeNs: "42" }]) {
			const changed = bootstrapEvidence({
				...original,
				savedSession: { ...original.savedSession, identity: { ...original.savedSession.identity, ...patch } },
			});
			expect(changed.requestHash).toBe(intent.requestHash);
			expect(managedLifecycleEvidenceHash(changed)).not.toBe(managedLifecycleEvidenceHash(intent));
			expect(() => assertManagedLifecycleEvidenceUpdate(intent, changed)).toThrow("historicalSource");
		}
		const renamed = bootstrapEvidence({
			...original,
			savedSession: { ...original.savedSession, path: "/workspace/project/.gjc/sessions/renamed.jsonl" },
		});
		expect(() => assertManagedLifecycleEvidenceUpdate(intent, renamed)).toThrow("Immutable");
	});

	test("does not allow public saved-path fields on ordinary serving lifecycle targets", () => {
		const historical = bootstrapEvidence();
		expect(() =>
			createManagedLifecycleEvidence(
				{
					operation: "session.resume",
					preparedAuthority: prepared,
					source: { ...source, sessionId: bootstrapSource().savedSession.id },
					target: historical.target,
					payloadHash,
				},
				time,
			),
		).toThrow();
		expect(() =>
			createManagedLifecycleEvidence(
				{
					operation: "session.create",
					preparedAuthority: prepared,
					target: { cwd: prepared.canonicalWorkspace, body: { sessionPath: bootstrapSource().savedSession.path } },
					payloadHash,
				},
				time,
			),
		).toThrow();
	});

	test("rejects changed bootstrap acknowledgement identity or fence and never treats history as proof", () => {
		const invoking = transitionManagedLifecycleEvidence(bootstrapEvidence(), "invoking", {}, time);
		const ack = { ...prepared, sessionId: bootstrapSource().historicalBinding.sessionId!, generation: 3 };
		for (const patch of [
			{ sessionId: "other" },
			{ generation: 0 },
			{ generation: -1 },
			{ generation: 1.5 },
			{ generation: Number.MAX_SAFE_INTEGER + 1 },
			{ principalId: "other" },
			{ projectId: "other" },
			{ chatId: "other" },
			{ canonicalWorkspace: "/other" },
			{ leaseId: "other" },
			{ epoch: "other" },
			{ requestKey: "other" },
		])
			expect(() =>
				transitionManagedLifecycleEvidence(
					invoking,
					"acknowledged_unproven",
					{ acknowledged: { ...ack, ...patch } },
					later,
				),
			).toThrow();
		expect(() => transitionManagedLifecycleEvidence(invoking, "active_generation_proven", {}, later)).toThrow();
		const uncertain = transitionManagedLifecycleEvidence(invoking, "uncertain", {}, later);
		expect(() => transitionManagedLifecycleEvidence(uncertain, "invoking", {}, later)).toThrow();
	});

	test("hashes canonical public request identity and preserves logical chat identity through the V3 codec", () => {
		const intent = createEvidence();
		const reordered = createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: { ...prepared },
				target: { kind: "existing_path", path: prepared.canonicalWorkspace },
				payloadHash,
			},
			time,
		);
		expect(intent.requestHash).toBe(reordered.requestHash);
		const canonical = JSON.stringify({
			actor: { id: prepared.principalId, namespace: "openwebui-gjc-adapter" },
			operation: "session.create",
			requestKey: prepared.requestKey,
			target: { kind: "existing_path", path: prepared.canonicalWorkspace },
		});
		expect(intent.requestHash).toBe(createHash("sha256").update(canonical).digest("hex"));
		const parsed = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(documentWith(intent)))!;
		expect(parsed.provisionalOperations[0]?.lifecycle).toEqual(intent);
		expect(parsed.provisionalOperations[0]?.lifecycle?.preparedAuthority.chatId).toBe("logical-chat");
		expect(parsed.provisionalOperations[0]?.chatId).toBe('["owner","logical-chat"]');
	});

	test("retains active lifecycle proof independently of an interrupted routing operation", () => {
		const active = transitionManagedLifecycleEvidence(
			acknowledgedEvidence(),
			"active_generation_proven",
			{ proven },
			later,
		);
		const document = documentWith(active);
		const uncertain = {
			...document,
			provisionalOperations: document.provisionalOperations.map(operation => ({
				...operation,
				state: "uncertain" as const,
			})),
		};
		expect(isSessionAuthorityV3Document(uncertain)).toBe(true);
		expect(() => transitionManagedLifecycleEvidence(active, "uncertain", {}, later)).toThrow();
	});

	test("accepts only exact duplicate updates and legal forward transitions", () => {
		const intent = createEvidence();
		expect(transitionManagedLifecycleEvidence(intent, "intent_prepared")).toEqual(intent);
		expect(() => transitionManagedLifecycleEvidence(intent, "intent_prepared", {}, later)).toThrow("exact duplicate");
		expect(() => transitionManagedLifecycleEvidence(intent, "retired", {}, later)).toThrow();
		const ack = acknowledgedEvidence();
		expect(() => transitionManagedLifecycleEvidence(ack, "active_generation_proven", { proven }, time)).toThrow(
			"backwards",
		);
		expect(() =>
			transitionManagedLifecycleEvidence(
				ack,
				"active_generation_proven",
				{ proven: { ...proven, generation: 3 } },
				later,
			),
		).toThrow();
	});

	test("rejects identity mutations and proof removal even when replacement records are otherwise valid", () => {
		const intent = createEvidence();
		for (const patch of [
			{ payloadHash: "b".repeat(64) },
			{ preparedAuthority: { ...prepared, requestKey: "new-key" } },
			{ target: { kind: "existing_path", path: prepared.canonicalWorkspace, body: "changed" } },
		]) {
			const changed = createManagedLifecycleEvidence(
				{
					operation: intent.operation,
					preparedAuthority: intent.preparedAuthority,
					target: intent.target,
					payloadHash,
					...patch,
				},
				time,
			);
			expect(() => assertManagedLifecycleEvidenceUpdate(intent, changed)).toThrow("Immutable");
		}
		const ack = acknowledgedEvidence();
		const { acknowledged: _removed, ...withoutProof } = ack;
		expect(() => assertManagedLifecycleEvidenceUpdate(ack, { ...withoutProof, state: "uncertain" })).toThrow(
			"removed or replaced",
		);
	});

	test("rejects malformed or foreign generation evidence and raw authority recursively", () => {
		const ack = acknowledgedEvidence();
		for (const authority of [
			{ ...acknowledged, principalId: "foreign" },
			{ ...acknowledged, projectId: "foreign" },
			{ ...acknowledged, chatId: "foreign" },
			{ ...acknowledged, canonicalWorkspace: "/foreign" },
			{ ...acknowledged, leaseId: "foreign" },
			{ ...acknowledged, epoch: "foreign" },
			{ ...acknowledged, requestKey: "foreign" },
			{ ...acknowledged, generation: 0 },
		])
			expect(isManagedLifecycleEvidence({ ...ack, acknowledged: authority })).toBe(false);
		for (const field of ["token", "descriptorPath", "attachment", "tmuxPane", "pid"])
			expect(() =>
				createManagedLifecycleEvidence(
					{
						operation: "session.create",
						preparedAuthority: prepared,
						target: { ...createEvidence().target, body: { nested: { [field]: "secret" } } },
						payloadHash,
					},
					time,
				),
			).toThrow();
		expect(isManagedLifecycleEvidence({ ...ack, requestHash: "wrong" })).toBe(false);
		expect(isManagedLifecycleEvidence({ ...ack, proven: { ...proven, epoch: "foreign" } })).toBe(false);
	});

	test("requires distinct successor identity and exact-generation resume acknowledgement", () => {
		for (const operation of ["session.create", "session.fork"] as const) {
			const evidence = createManagedLifecycleEvidence(
				{
					operation,
					preparedAuthority: prepared,
					source,
					target:
						operation === "session.fork"
							? { sourceSessionId: source.sessionId, cwd: prepared.canonicalWorkspace }
							: { cwd: prepared.canonicalWorkspace },
					payloadHash,
				},
				time,
			);
			const invoking = transitionManagedLifecycleEvidence(evidence, "invoking", {}, time);
			expect(() =>
				transitionManagedLifecycleEvidence(
					invoking,
					"acknowledged_unproven",
					{ acknowledged: { ...source, requestKey: prepared.requestKey } },
					later,
				),
			).toThrow("source identity");
		}
		const resume = createManagedLifecycleEvidence(
			{
				operation: "session.resume",
				preparedAuthority: prepared,
				source,
				target: { sessionIdOrPrefix: source.sessionId, path: prepared.canonicalWorkspace },
				payloadHash,
			},
			time,
		);
		const invoking = transitionManagedLifecycleEvidence(resume, "invoking", {}, time);
		expect(() =>
			transitionManagedLifecycleEvidence(
				invoking,
				"acknowledged_unproven",
				{ acknowledged: { ...source, requestKey: prepared.requestKey, generation: 2 } },
				later,
			),
		).toThrow("source generation");
	});

	test("requires matching successful retirement of the exact old generation", () => {
		const close = createManagedLifecycleEvidence(
			{
				operation: "session.close",
				preparedAuthority: prepared,
				source,
				target: { sessionId: source.sessionId, endpointGeneration: source.generation },
				payloadHash,
			},
			time,
		);
		const invoking = transitionManagedLifecycleEvidence(close, "invoking", {}, time);
		const uncertain = transitionManagedLifecycleEvidence(invoking, "uncertain", {}, time);
		const retirement = {
			sessionId: source.sessionId,
			generation: source.generation,
			acknowledgedSessionId: source.sessionId,
			observedAt: later,
			evidence: { source: "session_index", observedIndexSeq: 3, evidenceIndexSeq: 2, event: "session_closed" },
		};
		const retired = transitionManagedLifecycleEvidence(uncertain, "retired", { retirement }, later);
		expect(isManagedLifecycleEvidence(retired)).toBe(true);
		for (const patch of [
			{ generation: 2 },
			{ acknowledgedSessionId: "foreign" },
			{ sessionId: "foreign" },
			{ evidence: { source: "session_index", observedIndexSeq: 3, evidenceIndexSeq: 2, event: "replaced" } },
			{ evidence: { ...retirement.evidence, token: "secret" } },
		])
			expect(() =>
				transitionManagedLifecycleEvidence(
					uncertain,
					"retired",
					{ retirement: { ...retirement, ...patch } },
					later,
				),
			).toThrow();
		expect(() => transitionManagedLifecycleEvidence(retired, "uncertain", {}, later)).toThrow();
	});

	test("does not restore closing authority from proof that predates close", () => {
		const active = transitionManagedLifecycleEvidence(
			acknowledgedEvidence(),
			"active_generation_proven",
			{ proven },
			later,
		);
		const closing = transitionManagedLifecycleEvidence(active, "closing", {}, later);
		expect(() => transitionManagedLifecycleEvidence(closing, "active_generation_proven", {}, later)).toThrow(
			"not-applied",
		);
		const cleanup = transitionManagedLifecycleEvidence(acknowledgedEvidence(), "cleanup_uncertain", {}, later);
		expect(() => transitionManagedLifecycleEvidence(cleanup, "cleanup_pending", {}, later)).toThrow("not-applied");
	});

	test("post-invocation failure cannot become terminal without public nonapplication proof", () => {
		const intent = createEvidence();
		expect(transitionManagedLifecycleEvidence(intent, "terminal_failure", {}, later).state).toBe("terminal_failure");
		const invoking = transitionManagedLifecycleEvidence(intent, "invoking", {}, later);
		const uncertain = transitionManagedLifecycleEvidence(invoking, "uncertain", {}, later);
		for (const evidence of [invoking, uncertain]) {
			expect(() => transitionManagedLifecycleEvidence(evidence, "terminal_failure", {}, later)).toThrow(
				"not-applied",
			);
			expect(() =>
				assertManagedLifecycleEvidenceUpdate(evidence, { ...evidence, state: "terminal_failure" }),
			).toThrow("not-applied");
		}
	});

	test("cleanup uncertainty cannot regain retry eligibility through an acknowledged detour", () => {
		const initial = transitionManagedLifecycleEvidence(acknowledgedEvidence(), "cleanup_pending", {}, later);
		expect(initial.state).toBe("cleanup_pending");
		const invoking = transitionManagedLifecycleEvidence(initial, "invoking", {}, later);
		expect(() => transitionManagedLifecycleEvidence(invoking, "cleanup_pending", {}, later)).toThrow("not-applied");
		expect(() => transitionManagedLifecycleEvidence(invoking, "acknowledged_unproven", {}, later)).toThrow(
			"earlier acknowledgement",
		);
		const cleanup = transitionManagedLifecycleEvidence(initial, "cleanup_uncertain", {}, later);
		const uncertain = transitionManagedLifecycleEvidence(cleanup, "uncertain", {}, later);
		for (const state of ["cleanup_pending", "acknowledged_unproven"] as const)
			expect(() => transitionManagedLifecycleEvidence(uncertain, state, {}, later)).toThrow("request-bound");
		expect(uncertain.acknowledged).toEqual(initial.acknowledged);
		expect(uncertain.requestKey).toBe(initial.requestKey);
		expect(uncertain.requestHash).toBe(initial.requestHash);
	});

	test("normal V3 reopen cannot restore pre-close proof through uncertainty", () => {
		const active = transitionManagedLifecycleEvidence(
			acknowledgedEvidence(),
			"active_generation_proven",
			{ proven },
			later,
		);
		const uncertain = transitionManagedLifecycleEvidence(
			transitionManagedLifecycleEvidence(active, "closing", {}, later),
			"uncertain",
			{},
			later,
		);
		const root = mkdtempSync(join(tmpdir(), "gjc-uncertain-no-restore-"));
		const path = join(root, "authority.json");
		try {
			writeFileSync(path, encodeSessionAuthorityV3Document(documentWith(uncertain)));
			const store = new SessionV3FileBackedMappingStore(path);
			store.close();
			const retained = parseSessionAuthorityV3Document(readFileSync(path))!.provisionalOperations[0]!.lifecycle!;
			expect(retained).toEqual(uncertain);
			expect(retained.proven).toEqual(active.proven);
			for (const state of ["active_generation_proven", "acknowledged_unproven", "cleanup_pending"] as const) {
				expect(() => transitionManagedLifecycleEvidence(retained, state, {}, later)).toThrow("request-bound");
				expect(() => assertManagedLifecycleEvidenceUpdate(retained, { ...retained, state })).toThrow(
					"request-bound",
				);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects scoped chat, project and payload mismatch while allowing historical absence", () => {
		expect(isSessionAuthorityV3Document(documentWith())).toBe(true);
		const historical = documentWith();
		expect(
			isSessionAuthorityV3Document({
				...historical,
				provisionalOperations: historical.provisionalOperations.map(operation => ({
					...operation,
					state: "complete",
					completedAt: later,
				})),
			}),
		).toBe(true);
		const evidence = createEvidence();
		for (const patch of [
			{ chatId: '["foreign","logical-chat"]' },
			{ chatId: '["owner","other-chat"]' },
			{ projectId: "foreign" },
			{ detail: "b".repeat(64) },
		]) {
			const document = documentWith(evidence);
			expect(
				isSessionAuthorityV3Document({
					...document,
					provisionalOperations: [{ ...document.provisionalOperations[0], ...patch }],
				}),
			).toBe(false);
		}
	});

	test("checks lifecycle ownership inside a canonical mapping journal without rewriting evidence", () => {
		const evidence = createEvidence();
		const chatId = JSON.stringify([prepared.principalId, prepared.chatId]);
		const mapping = {
			version: 3 as const,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			chatId,
			projectId: prepared.projectId,
			sessionId: source.sessionId,
			createdAt: time,
			header: { chatId, projectId: prepared.projectId, sessionId: source.sessionId },
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "prior",
			managedAuthority: { ...source, chatId, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH },
			journal: [
				{
					id: "ingress",
					kind: "create" as const,
					state: "pending" as const,
					startedAt: time,
					detail: payloadHash,
					lifecycle: evidence,
				},
			],
		};
		const document: SessionAuthorityV3Document = {
			...documentWith(),
			provisionalOperations: [],
			mappings: [mapping],
		};
		expect(isSessionAuthorityV3Document(document)).toBe(true);
		const foreignWorkspace = createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: { ...prepared, canonicalWorkspace: "/foreign" },
				target: { cwd: "/foreign" },
				payloadHash,
			},
			time,
		);
		expect(
			isSessionAuthorityV3Document({
				...document,
				mappings: [{ ...mapping, journal: [{ ...mapping.journal[0], lifecycle: foreignWorkspace }] }],
			}),
		).toBe(false);
		const foreignPrincipal = createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: { ...prepared, principalId: "foreign" },
				target: evidence.target,
				payloadHash,
			},
			time,
		);
		expect(
			isSessionAuthorityV3Document({
				...document,
				mappings: [{ ...mapping, journal: [{ ...mapping.journal[0], lifecycle: foreignPrincipal }] }],
			}),
		).toBe(false);
	});

	test("deepcopies lifecycle JSON in canonical operations and provisional operations", () => {
		const evidence = createEvidence();
		const operation = {
			id: "op",
			kind: "create" as const,
			state: "pending" as const,
			startedAt: time,
			lifecycle: evidence,
		};
		const copied = copyOperation(operation);
		const provisional = copyProvisionalOperation({
			...operation,
			chatId: prepared.chatId,
			projectId: prepared.projectId,
		});
		const direct = copyManagedLifecycleEvidence(evidence);
		Reflect.set(copied.lifecycle!.target, "path", "/changed");
		Reflect.set(provisional.lifecycle!.preparedAuthority, "chatId", "changed");
		expect(evidence.target.path).toBe(prepared.canonicalWorkspace);
		expect(evidence.preparedAuthority.chatId).toBe(prepared.chatId);
		expect(direct).toEqual(evidence);
		expect(direct.target).not.toBe(evidence.target);
	});

	test("binds lifecycle operation to the journal kind and rejects unsupported delete records", () => {
		for (const [operation, kind, target] of [
			["session.create", "create", { cwd: prepared.canonicalWorkspace }],
			["session.fork", "branch", { sourceSessionId: source.sessionId, cwd: prepared.canonicalWorkspace }],
			["session.resume", "resume", { sessionId: source.sessionId, cwd: prepared.canonicalWorkspace }],
			["session.close", "close", { sessionId: source.sessionId, endpointGeneration: source.generation }],
		] as const) {
			const lifecycle = createManagedLifecycleEvidence(
				{ operation, preparedAuthority: prepared, source, target, payloadHash },
				time,
			);
			const record: SessionAuthorityV3Operation = {
				id: "ingress",
				kind,
				state: "pending",
				startedAt: time,
				detail: payloadHash,
				lifecycle,
			};
			expect(isManagedLifecycleEvidence(lifecycle)).toBe(true);
			expect(isSessionAuthorityV3Document(journalDocument(record))).toBe(true);
			expect(isSessionAuthorityV3Document(journalDocument({ ...record, kind: "model" }))).toBe(false);
		}
		const lifecycle = createManagedLifecycleEvidence(
			{
				operation: "session.delete",
				preparedAuthority: prepared,
				source,
				target: { sessionId: source.sessionId },
				payloadHash,
			},
			time,
		);
		expect(isManagedLifecycleEvidence(lifecycle)).toBe(true);
		expect(
			isSessionAuthorityV3Document(
				journalDocument({
					id: "ingress",
					kind: "close",
					state: "pending",
					startedAt: time,
					detail: payloadHash,
					lifecycle,
				}),
			),
		).toBe(false);
	});

	test("rejects completed success coupled to valid but unrelated acknowledgement or result authority", () => {
		const active = transitionManagedLifecycleEvidence(
			acknowledgedEvidence(),
			"active_generation_proven",
			{ proven },
			later,
		);
		const record = completeLifecycleOperation(active);
		expect(isSessionAuthorityV3Document(journalDocument(record))).toBe(true);
		for (const patch of [
			{ sessionId: "other" },
			{ generation: 3 },
			{ requestKey: "other-key" },
			{ leaseId: "other-lease" },
			{ epoch: "other-epoch" },
		]) {
			const result = lifecycleResult({ ...acknowledged, ...patch });
			const { lifecycle: _lifecycle, ...historical } = structuredClone(record);
			expect(isSessionAuthorityV3Document(journalDocument({ ...historical, result }))).toBe(true);
			expect(isSessionAuthorityV3Document(journalDocument({ ...record, result }))).toBe(false);
		}
		const changedEvidence = {
			...structuredClone(active),
			acknowledged: { ...acknowledged, sessionId: "other", generation: 3 },
			proven: { ...proven, sessionId: "other", generation: 3 },
		};
		expect(isManagedLifecycleEvidence(changedEvidence)).toBe(true);
		expect(isSessionAuthorityV3Document(journalDocument({ ...record, lifecycle: changedEvidence }))).toBe(false);
	});

	test("binds acknowledgedSuccessor to lifecycle acknowledgement through logical scoped identity", () => {
		const lifecycle = acknowledgedEvidence();
		const managedAuthority = lifecycleResult(acknowledged).managedAuthority;
		const record: SessionAuthorityV3Operation = {
			id: "ingress",
			kind: "create",
			state: "uncertain",
			startedAt: time,
			detail: payloadHash,
			lifecycle,
			acknowledgedSuccessor: { sessionId: acknowledged.sessionId, managedAuthority },
		};
		expect(isSessionAuthorityV3Document(journalDocument(record))).toBe(true);
		for (const patch of [
			{ sessionId: "other" },
			{ generation: 3 },
			{ requestKey: "other-key" },
			{ leaseId: "other-lease" },
			{ epoch: "other-epoch" },
		]) {
			const changed = { ...managedAuthority, ...patch };
			const successor = { sessionId: changed.sessionId, managedAuthority: changed };
			const { lifecycle: _lifecycle, ...historical } = structuredClone(record);
			expect(
				isSessionAuthorityV3Document(journalDocument({ ...historical, acknowledgedSuccessor: successor })),
			).toBe(true);
			expect(isSessionAuthorityV3Document(journalDocument({ ...record, acknowledgedSuccessor: successor }))).toBe(
				false,
			);
		}
		expect(isSessionAuthorityV3Document(journalDocument({ ...record, lifecycle: createEvidence() }))).toBe(false);
	});

	test("rejects incomplete lifecycle evidence attached to completed success and bounds evidence time", () => {
		const invoking = transitionManagedLifecycleEvidence(createEvidence(), "invoking", {}, time);
		const uncertain = transitionManagedLifecycleEvidence(invoking, "uncertain", {}, later);
		for (const lifecycle of [createEvidence(), invoking, uncertain, acknowledgedEvidence()]) {
			expect(isManagedLifecycleEvidence(lifecycle)).toBe(true);
			expect(isSessionAuthorityV3Document(journalDocument(completeLifecycleOperation(lifecycle)))).toBe(false);
		}
		const terminal = transitionManagedLifecycleEvidence(createEvidence(), "terminal_failure", {}, later);
		const completed = completeLifecycleOperation(terminal);
		expect(isSessionAuthorityV3Document(journalDocument(completed))).toBe(false);
		const { result: _result, ...withoutResult } = completed;
		expect(isSessionAuthorityV3Document(journalDocument(withoutResult))).toBe(true);
		const active = transitionManagedLifecycleEvidence(
			acknowledgedEvidence(),
			"active_generation_proven",
			{ proven },
			later,
		);
		expect(
			isSessionAuthorityV3Document(journalDocument({ ...completeLifecycleOperation(active), completedAt: time })),
		).toBe(false);
		const { result: _activeResult, ...receipt } = completeLifecycleOperation(active);
		expect(isSessionAuthorityV3Document(journalDocument(receipt))).toBe(true);
	});

	test("checks historical fork and resume results without substituting the current mapping generation", () => {
		for (const operation of ["session.fork", "session.resume"] as const) {
			const priorSource = { ...source, sessionId: "historical-source", generation: 6 };
			const assigned =
				operation === "session.fork" ? acknowledged : { ...priorSource, requestKey: prepared.requestKey };
			const intent = createManagedLifecycleEvidence(
				{
					operation,
					preparedAuthority: prepared,
					source: priorSource,
					target:
						operation === "session.fork"
							? { sourceSessionId: priorSource.sessionId, cwd: prepared.canonicalWorkspace }
							: { sessionId: priorSource.sessionId, cwd: prepared.canonicalWorkspace },
					payloadHash,
				},
				time,
			);
			const ack = transitionManagedLifecycleEvidence(
				transitionManagedLifecycleEvidence(intent, "invoking", {}, time),
				"acknowledged_unproven",
				{ acknowledged: assigned },
				later,
			);
			const proof = { ...proven, sessionId: assigned.sessionId, generation: assigned.generation };
			const active = transitionManagedLifecycleEvidence(ack, "active_generation_proven", { proven: proof }, later);
			const record = completeLifecycleOperation(
				active,
				operation === "session.fork" ? "branch" : "resume",
				lifecycleResult(assigned, "control"),
			);
			const document = journalDocument(record);
			expect(isSessionAuthorityV3Document(document)).toBe(true);
			expect(parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document))).toEqual(document);
			expect(
				isSessionAuthorityV3Document(
					journalDocument({
						...record,
						result: lifecycleResult({ ...assigned, generation: assigned.generation + 1 }, "control"),
					}),
				),
			).toBe(false);
		}
	});

	test("requires completed close results to match the retired exact source authority", () => {
		const intent = createManagedLifecycleEvidence(
			{
				operation: "session.close",
				preparedAuthority: prepared,
				source,
				target: { sessionId: source.sessionId, endpointGeneration: source.generation },
				payloadHash,
			},
			time,
		);
		const uncertain = transitionManagedLifecycleEvidence(
			transitionManagedLifecycleEvidence(intent, "invoking", {}, time),
			"uncertain",
			{},
			time,
		);
		const retirement = {
			sessionId: source.sessionId,
			generation: source.generation,
			acknowledgedSessionId: source.sessionId,
			observedAt: later,
			evidence: { source: "session_index", event: "session_closed", observedIndexSeq: 3, evidenceIndexSeq: 2 },
		};
		const retired = transitionManagedLifecycleEvidence(uncertain, "retired", { retirement }, later);
		const record = completeLifecycleOperation(retired, "close", lifecycleResult(source, "close"));
		expect(isSessionAuthorityV3Document(journalDocument(record))).toBe(true);
		expect(isSessionAuthorityV3Document(journalDocument({ ...record, lifecycle: uncertain }))).toBe(false);
		for (const patch of [
			{ generation: 2 },
			{ sessionId: "replacement" },
			{ requestKey: "other" },
			{ leaseId: "other" },
		])
			expect(
				isSessionAuthorityV3Document(
					journalDocument({ ...record, result: lifecycleResult({ ...source, ...patch }, "close") }),
				),
			).toBe(false);
		expect(
			isSessionAuthorityV3Document(journalDocument({ ...record, result: lifecycleResult(source, "turn") })),
		).toBe(false);
	});

	test("resolves closing source proof by exact completed lifecycle digest without requiring the old prompt key", () => {
		const document = referencedCloseDocument();
		const prior = document.mappings[0]!.journal[0]!.lifecycle!;
		const closing = document.mappings[0]!.journal[1]!.lifecycle!;
		expect(closing.source!.requestKey).not.toBe(prior.acknowledged!.requestKey);
		expect(closing.sourceProofRef!.evidenceHash).toBe(managedLifecycleEvidenceHash(prior));
		expect(closing.state).toBe("closing");
		expect(isSessionAuthorityV3Document(document)).toBe(true);
		const parsed = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document));
		expect(structuredClone(parsed)).toEqual(structuredClone(document));
	});

	test("rejects missing, self, wrong-hash, uncompleted and future source proof references", () => {
		for (const mode of ["missing", "self", "hash", "unfinished", "future", "no-evidence"] as const) {
			const document = structuredClone(referencedCloseDocument());
			const mapping = document.mappings[0]!;
			const prior = mapping.journal[0]!;
			const closing = mapping.journal[1]!;
			let changedPrior: SessionAuthorityV3Operation = prior;
			let changedClose: SessionAuthorityV3Operation = closing;
			if (mode === "missing" || mode === "self" || mode === "hash") {
				changedClose = {
					...closing,
					lifecycle: {
						...closing.lifecycle!,
						sourceProofRef: {
							operationId: mode === "missing" ? "missing" : mode === "self" ? closing.id : prior.id,
							evidenceHash: mode === "hash" ? "f".repeat(64) : closing.lifecycle!.sourceProofRef!.evidenceHash,
						},
					},
				};
			} else if (mode === "unfinished") {
				const { completedAt: _completedAt, result: _result, ...pending } = prior;
				changedPrior = { ...pending, state: "uncertain" };
			} else if (mode === "future") changedPrior = { ...prior, completedAt: "2026-09-06T14:00:03.000Z" };
			else {
				const { lifecycle: _lifecycle, ...historical } = prior;
				changedPrior = historical;
			}
			expect(
				isSessionAuthorityV3Document({
					...document,
					mappings: [{ ...mapping, journal: [changedPrior, changedClose] }],
				}),
			).toBe(false);
		}
	});

	test("rejects reference rebinding to a different valid source fence even when its digest is recomputed", () => {
		for (const patch of [
			{ generation: 9 },
			{ sessionId: "other" },
			{ leaseId: "other" },
			{ epoch: "other" },
			{ principalId: "other" },
			{ projectId: "other" },
			{ canonicalWorkspace: "/other" },
			{ chatId: "other" },
		]) {
			const document = structuredClone(referencedCloseDocument());
			const mapping = document.mappings[0]!;
			const prior = mapping.journal[0]!;
			const closing = mapping.journal[1]!;
			const assigned = { ...acknowledged, ...patch };
			const priorPrepared = {
				...prepared,
				principalId: assigned.principalId,
				projectId: assigned.projectId,
				canonicalWorkspace: assigned.canonicalWorkspace,
				chatId: assigned.chatId,
				leaseId: assigned.leaseId,
				epoch: assigned.epoch,
			};
			const intent = createManagedLifecycleEvidence(
				{
					operation: "session.create",
					preparedAuthority: priorPrepared,
					target: { cwd: priorPrepared.canonicalWorkspace },
					payloadHash,
				},
				time,
			);
			const ack = transitionManagedLifecycleEvidence(
				transitionManagedLifecycleEvidence(intent, "invoking", {}, time),
				"acknowledged_unproven",
				{ acknowledged: assigned },
				later,
			);
			const proof = {
				...proven,
				sessionId: assigned.sessionId,
				generation: assigned.generation,
				leaseId: assigned.leaseId,
				epoch: assigned.epoch,
			};
			const evidence = transitionManagedLifecycleEvidence(ack, "active_generation_proven", { proven: proof }, later);
			expect(isManagedLifecycleEvidence(evidence)).toBe(true);
			const changedClose = {
				...closing,
				lifecycle: {
					...closing.lifecycle!,
					sourceProofRef: {
						operationId: prior.id,
						evidenceHash: managedLifecycleEvidenceHash(evidence),
					},
				},
			};
			expect(
				isSessionAuthorityV3Document({
					...document,
					mappings: [
						{
							...mapping,
							journal: [{ ...prior, lifecycle: evidence, result: lifecycleResult(assigned) }, changedClose],
						},
					],
				}),
			).toBe(false);
		}
	});

	test("binds the full referenced evidence rather than only its acknowledged identity", () => {
		const document = structuredClone(referencedCloseDocument());
		const mapping = document.mappings[0]!;
		const prior = mapping.journal[0]!;
		const closing = mapping.journal[1]!;
		const changedEvidence = { ...prior.lifecycle!, payloadHash: "b".repeat(64) };
		expect(isManagedLifecycleEvidence(changedEvidence)).toBe(true);
		const changedPrior = { ...prior, detail: changedEvidence.payloadHash, lifecycle: changedEvidence };
		expect(isSessionAuthorityV3Document(journalDocument(changedPrior))).toBe(true);
		expect(
			isSessionAuthorityV3Document({ ...document, mappings: [{ ...mapping, journal: [changedPrior, closing] }] }),
		).toBe(false);
	});

	test("does not resolve a provisional reference from another tenant journal or incomplete evidence", () => {
		const document = referencedCloseDocument();
		const mapping = document.mappings[0]!;
		const prior = mapping.journal[0]!;
		const close = mapping.journal[1]!;
		const provisional = { ...close, chatId: mapping.chatId, projectId: mapping.projectId };
		expect(
			isSessionAuthorityV3Document({
				...document,
				mappings: [{ ...mapping, journal: [prior] }],
				provisionalOperations: [provisional],
			}),
		).toBe(true);
		expect(isSessionAuthorityV3Document({ ...document, mappings: [], provisionalOperations: [provisional] })).toBe(
			false,
		);
		const noProof = { ...prior.lifecycle!, state: "uncertain" as const };
		expect(isManagedLifecycleEvidence(noProof)).toBe(true);
		const { result: _result, completedAt: _completedAt, ...unfinished } = prior;
		expect(
			isSessionAuthorityV3Document({
				...document,
				mappings: [{ ...mapping, journal: [{ ...unfinished, state: "uncertain", lifecycle: noProof }] }],
				provisionalOperations: [provisional],
			}),
		).toBe(false);
	});
});
