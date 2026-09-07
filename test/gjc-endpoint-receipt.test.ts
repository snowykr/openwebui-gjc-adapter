import { describe, expect, test } from "bun:test";
import {
	assertManagedLifecycleEvidenceUpdate,
	copyManagedEndpointReceipt,
	copyManagedLateCreateAcknowledgement,
	copyManagedLateLifecycleAcknowledgement,
	copyManagedLifecycleEvidence,
	createManagedLateCreateAcknowledgement,
	createManagedLateLifecycleAcknowledgement,
	createManagedLifecycleEvidence,
	createManagedRetirementEvidence,
	isManagedCatalogProvisional,
	isManagedEndpointReceipt,
	isManagedLateCreateAcknowledgement,
	isManagedLateLifecycleAcknowledgement,
	isManagedLifecycleEvidence,
	type ManagedHistoricalLifecycleSource,
	type ManagedLifecycleEvidence,
	managedEndpointReceiptFromResult,
	managedLifecycleAdmissionHash,
	managedLifecycleEvidenceHash,
	managedProvisionalCreateAdmissionHash,
	requireManagedEndpointReceipt,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import { copyOperation, copyProvisionalOperation } from "../src/gjc/session-authority-copy";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	isSessionAuthorityV3Mapping,
	isSessionAuthorityV3ProvisionalOperation,
	type ManagedTurnAuthorityV3,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Mapping,
	type SessionAuthorityV3Operation,
	type SessionAuthorityV3ProvisionalOperation,
	type SessionAuthorityV3Tombstone,
} from "../src/gjc/session-authority-v3";
import type {
	ManagedEndpointReceipt,
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "../src/gjc/turn-runner";

const time = "2026-09-07T12:00:00.000Z";
const later = "2026-09-07T12:00:01.000Z";
const closeTime = "2026-09-07T12:00:02.000Z";
const payloadHash = "a".repeat(64);
const prepared: ManagedPreparedTurnAuthority = {
	principalId: "owner",
	projectId: "project",
	canonicalWorkspace: "/workspace/project",
	chatId: "chat",
	leaseId: "lease",
	epoch: "runtime-epoch",
	requestKey: "create-request",
};
const chatId = JSON.stringify([prepared.principalId, prepared.chatId]);
const source: ManagedTurnAuthority = { ...prepared, requestKey: "prior-request", sessionId: "prior", generation: 1 };
const acknowledged: ManagedTurnAuthority = { ...prepared, sessionId: "created", generation: 2 };
const receipt: ManagedEndpointReceipt = {
	sessionId: acknowledged.sessionId,
	endpointGeneration: acknowledged.generation,
	endpointIncarnation: "b".repeat(64),
};
const proof: ManagedGenerationProof = {
	kind: "managed-generation",
	sessionId: acknowledged.sessionId,
	generation: acknowledged.generation,
	leaseId: acknowledged.leaseId,
	epoch: acknowledged.epoch,
};

function invoking(control = false): ManagedLifecycleEvidence {
	return transitionManagedLifecycleEvidence(
		createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: prepared,
				...(control ? { source } : {}),
				target: { cwd: prepared.canonicalWorkspace },
				payloadHash,
			},
			time,
		),
		"invoking",
		{},
		time,
	);
}

function observed(withReceipt = true, control = false): ManagedLifecycleEvidence {
	return transitionManagedLifecycleEvidence(
		invoking(control),
		"acknowledged_unproven",
		{ acknowledged, ...(withReceipt ? { endpointReceipt: receipt } : {}) },
		later,
	);
}

function active(withReceipt = true): ManagedLifecycleEvidence {
	return transitionManagedLifecycleEvidence(
		observed(withReceipt),
		"active_generation_proven",
		{ proven: proof },
		later,
	);
}

function operation(lifecycle = invoking(true)): SessionAuthorityV3Operation {
	return { id: "create", kind: "create", state: "pending", startedAt: time, detail: payloadHash, lifecycle };
}

function provisional(lifecycle = invoking()): SessionAuthorityV3ProvisionalOperation {
	return { ...operation(lifecycle), chatId, projectId: prepared.projectId };
}

function mapping(
	journal: readonly SessionAuthorityV3Operation[],
): Extract<SessionAuthorityV3Mapping, { readonly managedAuthority: ManagedTurnAuthorityV3 }> {
	return {
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		chatId,
		projectId: prepared.projectId,
		sessionId: acknowledged.sessionId,
		createdAt: time,
		header: { chatId, projectId: prepared.projectId, sessionId: acknowledged.sessionId },
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "create",
		managedAuthority: { ...acknowledged, chatId, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH },
		journal,
	};
}

function document(
	mappings: readonly SessionAuthorityV3Mapping[] = [],
	provisionalOperations: readonly SessionAuthorityV3ProvisionalOperation[] = [],
): SessionAuthorityV3Document {
	return {
		kind: SESSION_AUTHORITY_V3_KIND,
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		mappings,
		provisionalOperations,
	};
}

function closeEvidence(target: Readonly<Record<string, unknown>>): ManagedLifecycleEvidence {
	return {
		...createManagedLifecycleEvidence(
			{
				operation: "session.close",
				preparedAuthority: { ...prepared, requestKey: "close-request" },
				source: acknowledged,
				target,
				payloadHash,
			},
			closeTime,
		),
		state: "closing",
	};
}

function referencedMapping(prior: ManagedLifecycleEvidence, target: Readonly<Record<string, unknown>>) {
	return mapping([
		{ ...operation(prior), state: "complete", completedAt: later },
		{
			id: "close",
			kind: "close",
			state: "pending",
			startedAt: closeTime,
			detail: payloadHash,
			lifecycle: {
				...closeEvidence(target),
				sourceProofRef: { operationId: "create", evidenceHash: managedLifecycleEvidenceHash(prior) },
			},
		},
	]);
}

function catalog(withReceipt = true, target: Readonly<Record<string, unknown>> = { ...receipt }) {
	return {
		...provisional(observed(withReceipt)),
		purpose: "model-catalog" as const,
		cleanup: {
			id: "catalog-close",
			ingressId: "catalog-close-ingress",
			kind: "close" as const,
			state: "pending" as const,
			startedAt: closeTime,
			detail: payloadHash,
			lifecycle: closeEvidence(target),
		},
	};
}

describe("original endpoint receipt schema", () => {
	test("requires exact own JSON fields without normalizing identity", () => {
		expect(isManagedEndpointReceipt(receipt, acknowledged)).toBe(true);
		expect(
			isManagedEndpointReceipt(
				{ ...receipt, sessionId: " identity " },
				{ ...acknowledged, sessionId: " identity " },
			),
		).toBe(true);
		expect(isManagedEndpointReceipt({ ...receipt, endpointGeneration: Number.MAX_SAFE_INTEGER })).toBe(true);
		for (const value of [
			null,
			[],
			{},
			{ sessionId: receipt.sessionId, endpointGeneration: receipt.endpointGeneration },
			{ sessionId: receipt.sessionId, endpointIncarnation: receipt.endpointIncarnation },
			{ ...receipt, sessionId: "" },
			...[-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2"].map(endpointGeneration => ({
				...receipt,
				endpointGeneration,
			})),
			...[
				undefined,
				null,
				"",
				"B".repeat(64),
				"b".repeat(63),
				"b".repeat(65),
				` ${receipt.endpointIncarnation}`,
				`${receipt.endpointIncarnation}\n`,
			].map(endpointIncarnation => ({ ...receipt, endpointIncarnation })),
			{ ...receipt, generation: 2 },
			{ ...receipt, token: "forbidden" },
			{ ...receipt, [Symbol("extra")]: true },
			Object.assign(Object.create({ inherited: true }), receipt),
			Object.defineProperty({ ...receipt }, "extra", { value: true }),
			Object.defineProperty({ ...receipt }, "endpointIncarnation", { get: () => receipt.endpointIncarnation }),
		])
			expect(isManagedEndpointReceipt(value)).toBe(false);
		expect(isManagedEndpointReceipt(receipt, { ...acknowledged, sessionId: "other" })).toBe(false);
		expect(isManagedEndpointReceipt(receipt, { ...acknowledged, generation: 3 })).toBe(false);
	});

	test("raw result projection drops all unrelated public fields and never manufactures a pair", () => {
		const raw = {
			...receipt,
			status: "ready",
			token: "not-persisted",
			metadata: { endpointIncarnation: "not-authority" },
		};
		const decoded = managedEndpointReceiptFromResult(raw, acknowledged);
		expect(decoded).toEqual(receipt);
		expect(decoded).not.toBe(raw);
		raw.endpointIncarnation = "c".repeat(64);
		expect(decoded?.endpointIncarnation).toBe(receipt.endpointIncarnation);
		for (const invalid of [
			undefined,
			{ sessionId: receipt.sessionId, endpointGeneration: 2 },
			{ sessionId: receipt.sessionId, generation: 2, endpointIncarnation: receipt.endpointIncarnation },
			{ ...receipt, endpointIncarnation: "B".repeat(64) },
			{ ...receipt, endpointGeneration: 3 },
			{ ...receipt, sessionId: "other" },
			Object.create(receipt),
		])
			expect(managedEndpointReceiptFromResult(invalid, acknowledged)).toBeUndefined();
	});

	test.each(["session.create", "session.resume", "session.fork"] as const)(
		"pairs the first %s acknowledgement atomically",
		kind => {
			const ack = kind === "session.resume" ? { ...source, requestKey: prepared.requestKey } : acknowledged;
			const endpointReceipt = { ...receipt, sessionId: ack.sessionId, endpointGeneration: ack.generation };
			const target =
				kind === "session.create"
					? { cwd: prepared.canonicalWorkspace }
					: kind === "session.resume"
						? { sessionId: source.sessionId }
						: { sourceSessionId: source.sessionId, cwd: prepared.canonicalWorkspace };
			const intent = createManagedLifecycleEvidence(
				{ operation: kind, preparedAuthority: prepared, source, target, payloadHash },
				time,
			);
			const admitted = transitionManagedLifecycleEvidence(intent, "invoking", {}, time);
			const observed = transitionManagedLifecycleEvidence(
				admitted,
				"acknowledged_unproven",
				{ acknowledged: ack, endpointReceipt },
				later,
			);
			expect(requireManagedEndpointReceipt(observed)).toEqual(endpointReceipt);
			expect(() =>
				transitionManagedLifecycleEvidence(admitted, "acknowledged_unproven", { endpointReceipt }, later),
			).toThrow();
			expect(() =>
				transitionManagedLifecycleEvidence(
					admitted,
					"acknowledged_unproven",
					{ acknowledged: ack, endpointReceipt: { ...endpointReceipt, endpointGeneration: 9 } },
					later,
				),
			).toThrow();
			expect(() =>
				transitionManagedLifecycleEvidence(admitted, "uncertain", { acknowledged: ack, endpointReceipt }, later),
			).toThrow();
			expect(() =>
				transitionManagedLifecycleEvidence(intent, "invoking", { acknowledged: ack, endpointReceipt }, later),
			).toThrow();
			expect(isManagedLifecycleEvidence({ ...observed, endpointReceipt: { ...endpointReceipt, extra: true } })).toBe(
				false,
			);
		},
	);

	test("absence is sealed through proof, uncertainty and close transitions", () => {
		const absent = observed(false);
		const proven = active(false);
		const uncertain = transitionManagedLifecycleEvidence(absent, "uncertain", {}, later);
		const closing = transitionManagedLifecycleEvidence(proven, "closing", {}, closeTime);
		for (const evidence of [absent, proven, uncertain, closing]) {
			expect(isManagedLifecycleEvidence(evidence)).toBe(true);
			expect(() => requireManagedEndpointReceipt(evidence)).toThrow();
			expect(() =>
				assertManagedLifecycleEvidenceUpdate(evidence, { ...evidence, endpointReceipt: receipt }),
			).toThrow();
		}
		expect(() =>
			transitionManagedLifecycleEvidence(
				absent,
				"active_generation_proven",
				{ proven: proof, endpointReceipt: receipt },
				later,
			),
		).toThrow();
		expect(() =>
			transitionManagedLifecycleEvidence(absent, "uncertain", { endpointReceipt: receipt }, later),
		).toThrow();
		expect(() =>
			transitionManagedLifecycleEvidence(proven, "closing", { endpointReceipt: receipt }, closeTime),
		).toThrow();
		expect(proven.acknowledged).toEqual(acknowledged);
		expect(proven.proven).toEqual(proof);
	});

	test("present receipts remain immutable and only exact duplicate updates are idempotent", () => {
		const evidence = observed();
		const duplicate = transitionManagedLifecycleEvidence(evidence, evidence.state, {
			endpointReceipt: { ...receipt },
		});
		expect(duplicate).toEqual(evidence);
		expect(duplicate.endpointReceipt).not.toBe(evidence.endpointReceipt);
		for (const state of ["acknowledged_unproven", "uncertain"] as const) {
			expect(() =>
				transitionManagedLifecycleEvidence(
					evidence,
					state,
					{ endpointReceipt: { ...receipt, endpointIncarnation: "c".repeat(64) } },
					later,
				),
			).toThrow();
			const { endpointReceipt: _receipt, ...removed } = evidence;
			expect(() => assertManagedLifecycleEvidenceUpdate(evidence, { ...removed, state })).toThrow();
		}
		const closing = transitionManagedLifecycleEvidence(active(), "closing", {}, closeTime);
		expect(transitionManagedLifecycleEvidence(closing, "uncertain", {}, closeTime).endpointReceipt).toEqual(receipt);
	});

	test("full evidence hash binds incarnation while request and both admission hashes do not", () => {
		const withReceipt = observed(true, true);
		const withoutReceipt = observed(false, true);
		const changed = { ...withReceipt, endpointReceipt: { ...receipt, endpointIncarnation: "c".repeat(64) } };
		expect(managedLifecycleEvidenceHash(withReceipt)).not.toBe(managedLifecycleEvidenceHash(withoutReceipt));
		expect(managedLifecycleEvidenceHash(withReceipt)).not.toBe(managedLifecycleEvidenceHash(changed));
		expect(withReceipt.requestHash).toBe(withoutReceipt.requestHash);
		expect(managedLifecycleAdmissionHash(operation(withReceipt))).toBe(
			managedLifecycleAdmissionHash(operation(withoutReceipt)),
		);
		expect(managedLifecycleAdmissionHash(operation(changed))).toBe(managedLifecycleAdmissionHash(operation()));
		expect(managedProvisionalCreateAdmissionHash(provisional(observed()))).toBe(
			managedProvisionalCreateAdmissionHash(provisional(observed(false))),
		);
	});

	test("copy and transition boundaries detach original ordinary receipts", () => {
		const input = { ...receipt };
		const evidence = transitionManagedLifecycleEvidence(
			invoking(),
			"acknowledged_unproven",
			{ acknowledged, endpointReceipt: input },
			later,
		);
		input.endpointIncarnation = "c".repeat(64);
		for (const copy of [
			copyManagedEndpointReceipt(receipt),
			requireManagedEndpointReceipt(evidence),
			copyManagedLifecycleEvidence(evidence).endpointReceipt!,
			copyOperation(operation(evidence)).lifecycle!.endpointReceipt!,
			copyProvisionalOperation(provisional(evidence)).lifecycle!.endpointReceipt!,
		])
			Reflect.set(copy, "endpointIncarnation", "d".repeat(64));
		expect(evidence.endpointReceipt).toEqual(receipt);
		expect(isManagedLifecycleEvidence(evidence)).toBe(true);
	});
});

describe("late endpoint receipts", () => {
	test("builders preserve third-position timestamps, admission identity and detached optional fourth receipt", () => {
		const admitted = operation();
		const initial = provisional();
		const input = { ...receipt };
		const late = createManagedLateLifecycleAcknowledgement(admitted, acknowledged, later, input);
		const lateCreate = createManagedLateCreateAcknowledgement(initial, acknowledged, later, input);
		expect(late.observedAt).toBe(later);
		expect(lateCreate.observedAt).toBe(later);
		expect(late.admissionHash).toBe(
			createManagedLateLifecycleAcknowledgement(admitted, acknowledged, later).admissionHash,
		);
		expect(lateCreate.admissionHash).toBe(
			createManagedLateCreateAcknowledgement(initial, acknowledged, later).admissionHash,
		);
		expect(createManagedLateLifecycleAcknowledgement(admitted, acknowledged, later).endpointReceipt).toBeUndefined();
		expect(createManagedLateCreateAcknowledgement(initial, acknowledged, later).endpointReceipt).toBeUndefined();
		expect(
			createManagedLateLifecycleAcknowledgement(admitted, acknowledged, undefined, receipt).endpointReceipt,
		).toEqual(receipt);
		expect(createManagedLateCreateAcknowledgement(initial, acknowledged, undefined, receipt).endpointReceipt).toEqual(
			receipt,
		);
		input.endpointIncarnation = "c".repeat(64);
		const uncertain = {
			...admitted,
			state: "uncertain" as const,
			lifecycle: transitionManagedLifecycleEvidence(admitted.lifecycle!, "uncertain", {}, later),
			lateLifecycleAcknowledgement: late,
		};
		const uncertainCreate = {
			...initial,
			state: "uncertain" as const,
			lifecycle: transitionManagedLifecycleEvidence(initial.lifecycle!, "uncertain", {}, later),
			lateCreateAcknowledgement: lateCreate,
		};
		expect(isManagedLateLifecycleAcknowledgement(late, uncertain)).toBe(true);
		expect(isManagedLateCreateAcknowledgement(lateCreate, uncertainCreate)).toBe(true);
		for (const copy of [
			copyManagedLateLifecycleAcknowledgement(late),
			copyOperation(uncertain).lateLifecycleAcknowledgement!,
			copyManagedLateCreateAcknowledgement(lateCreate),
			copyProvisionalOperation(uncertainCreate).lateCreateAcknowledgement!,
		]) {
			Reflect.set(copy.endpointReceipt!, "endpointIncarnation", "d".repeat(64));
			Reflect.set(copy.acknowledged, "sessionId", "mutated");
		}
		expect(late.endpointReceipt).toEqual(receipt);
		expect(lateCreate.endpointReceipt).toEqual(receipt);
		expect(late.acknowledged.sessionId).toBe(acknowledged.sessionId);
		expect(lateCreate.acknowledged.sessionId).toBe(acknowledged.sessionId);
		expect(isSessionAuthorityV3Mapping(mapping([uncertain]))).toBe(true);
		expect(isSessionAuthorityV3ProvisionalOperation(uncertainCreate)).toBe(true);
		expect(
			parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document([mapping([uncertain])]))),
		).toEqual(document([mapping([uncertain])]));
		expect(
			parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document([], [uncertainCreate]))),
		).toEqual(document([], [uncertainCreate]));
		for (const invalid of [
			undefined,
			null,
			{ ...receipt, sessionId: "other" },
			{ ...receipt, endpointGeneration: 9 },
			{ ...receipt, endpointIncarnation: "invalid" },
			{ ...receipt, token: "forbidden" },
		]) {
			expect(isManagedLateLifecycleAcknowledgement({ ...late, endpointReceipt: invalid }, uncertain)).toBe(false);
			expect(isManagedLateCreateAcknowledgement({ ...lateCreate, endpointReceipt: invalid }, uncertainCreate)).toBe(
				false,
			);
			if (invalid !== undefined) {
				expect(() =>
					createManagedLateLifecycleAcknowledgement(
						admitted,
						acknowledged,
						later,
						invalid as ManagedEndpointReceipt,
					),
				).toThrow();
				expect(() =>
					createManagedLateCreateAcknowledgement(initial, acknowledged, later, invalid as ManagedEndpointReceipt),
				).toThrow();
			}
		}
	});
});

describe("V3 endpoint receipt positions and close source relations", () => {
	test("ordinary receipts round-trip in provisional and journal entrypoints", () => {
		const root = provisional(observed());
		const journal = mapping([operation(observed(true, true))]);
		expect(isSessionAuthorityV3ProvisionalOperation(root)).toBe(true);
		expect(isSessionAuthorityV3Mapping(journal)).toBe(true);
		for (const value of [document([], [root]), document([journal])]) {
			expect(isSessionAuthorityV3Document(value)).toBe(true);
			expect(parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(value))).toEqual(value);
		}
	});

	test("retained source and prior tombstone journals keep narrowly scoped receipts", () => {
		const prior: SessionAuthorityV3Tombstone = {
			...mapping([{ ...operation(observed()), id: "old-create" }]),
			retiredAt: closeTime,
		};
		const tombstone: SessionAuthorityV3Tombstone = {
			...mapping([{ ...operation(observed()), id: "retired-create" }]),
			retiredAt: closeTime,
			prior,
		};
		const current = {
			...mapping([]),
			projectId: "new-project",
			header: { chatId, projectId: "new-project", sessionId: acknowledged.sessionId },
			managedAuthority: {
				...acknowledged,
				chatId,
				projectId: "new-project",
				authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			},
			reassignment: {
				state: "committed" as const,
				sourceProjectId: prepared.projectId,
				targetProjectId: "new-project",
				startedAt: closeTime,
				completedAt: closeTime,
				sourceTombstone: tombstone,
				priorTombstone: prior,
			},
		};
		expect(isSessionAuthorityV3Mapping(current)).toBe(true);
		expect(isSessionAuthorityV3Document(document([current]))).toBe(true);
	});

	test("exact saved-resume target exceptions coexist with original endpoint receipts without broadening history", () => {
		const historicalSource: ManagedHistoricalLifecycleSource = {
			kind: "bootstrap-history",
			manifestDigest: "c".repeat(64),
			historicalBinding: {
				kind: "unbound-history",
				chatId,
				projectId: prepared.projectId,
				sessionId: acknowledged.sessionId,
				principalId: prepared.principalId,
				reason: "ownership-unresolved",
				provenance: {
					source: "v2",
					documentHash: "d".repeat(64),
					nodeRef: "/mappings/0",
					nodeHash: "e".repeat(64),
				},
			},
			savedSession: {
				id: acknowledged.sessionId,
				path: "/workspace/project/.gjc/sessions/original.jsonl",
				identity: {
					dev: "1",
					ino: "2",
					size: 30,
					mtimeMs: 100,
					mtimeNs: "100000000",
					sha256: "f".repeat(64),
					nlink: "1",
					ctimeNs: "100000000",
				},
			},
		};
		const { nlink: _nlink, ctimeNs: _ctimeNs, ...sessionIdentity } = historicalSource.savedSession.identity;
		const intent = createManagedLifecycleEvidence(
			{
				operation: "session.resume",
				preparedAuthority: prepared,
				historicalSource,
				target: {
					sessionId: acknowledged.sessionId,
					cwd: prepared.canonicalWorkspace,
					sessionPath: historicalSource.savedSession.path,
					sessionIdentity,
				},
				payloadHash,
			},
			time,
		);
		const evidence = transitionManagedLifecycleEvidence(
			transitionManagedLifecycleEvidence(intent, "invoking", {}, time),
			"acknowledged_unproven",
			{ acknowledged, endpointReceipt: receipt },
			later,
		);
		const root: SessionAuthorityV3Mapping = {
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			chatId,
			projectId: prepared.projectId,
			sessionId: acknowledged.sessionId,
			createdAt: time,
			header: { chatId, projectId: prepared.projectId, sessionId: acknowledged.sessionId },
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "resume",
			historicalBinding: historicalSource.historicalBinding,
			journal: [{ ...operation(evidence), id: "resume", kind: "resume" }],
		};
		expect(isSessionAuthorityV3Mapping(root)).toBe(true);
		expect(parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document([root])))).toEqual(
			document([root]),
		);
		for (const changed of [
			{ ...evidence, historicalSource: { ...historicalSource, endpointReceipt: receipt } },
			{
				...evidence,
				historicalSource: {
					...historicalSource,
					savedSession: { ...historicalSource.savedSession, endpointIncarnation: receipt.endpointIncarnation },
				},
			},
		]) {
			expect(isManagedLifecycleEvidence(changed)).toBe(false);
			expect(
				isSessionAuthorityV3Mapping({
					...root,
					journal: [{ ...operation(changed), id: "resume", kind: "resume" }],
				}),
			).toBe(false);
		}
	});

	test("close references demand exact source receipt equality whenever either side has incarnation", () => {
		const exact = referencedMapping(active(), { ...receipt });
		expect(isSessionAuthorityV3Mapping(exact)).toBe(true);
		expect(isSessionAuthorityV3Document(document([exact]))).toBe(true);
		expect(
			isSessionAuthorityV3Document(
				document([
					referencedMapping(active(false), {
						sessionId: receipt.sessionId,
						endpointGeneration: receipt.endpointGeneration,
					}),
				]),
			),
		).toBe(true);
		for (const invalid of [
			referencedMapping(active(), { ...receipt, endpointIncarnation: "c".repeat(64) }),
			referencedMapping(active(), { sessionId: receipt.sessionId, endpointGeneration: receipt.endpointGeneration }),
			referencedMapping(active(false), { ...receipt }),
		]) {
			expect(isSessionAuthorityV3Mapping(invalid)).toBe(false);
			expect(isSessionAuthorityV3Document(document([invalid]))).toBe(false);
		}
		const fresh = createManagedRetirementEvidence(
			{
				operation: "session.close",
				preparedAuthority: { ...prepared, requestKey: "close-request" },
				source: { ...acknowledged, requestKey: "latest-turn" },
				sourceOperationId: "create",
				sourceEvidence: active(),
				target: { ...receipt },
				payloadHash,
			},
			closeTime,
		);
		expect(fresh.target).toEqual({ ...receipt });
		expect(fresh.target).not.toBe(receipt);
		expect(() =>
			createManagedRetirementEvidence(
				{
					operation: "session.close",
					preparedAuthority: { ...prepared, requestKey: "close-request" },
					source: acknowledged,
					sourceOperationId: "create",
					sourceEvidence: active(false),
					target: { ...receipt },
					payloadHash,
				},
				closeTime,
			),
		).toThrow();
		expect(() =>
			createManagedRetirementEvidence(
				{
					operation: "session.close",
					preparedAuthority: { ...prepared, requestKey: "close-request" },
					source: acknowledged,
					sourceOperationId: "create",
					sourceEvidence: active(),
					target: { ...receipt, endpointIncarnation: "c".repeat(64) },
					payloadHash,
				},
				closeTime,
			),
		).toThrow();
		expect(closeEvidence({ ...receipt }).requestHash).not.toBe(
			closeEvidence({ ...receipt, endpointIncarnation: "c".repeat(64) }).requestHash,
		);
	});

	test("catalog cleanup pairs parent receipt with its exact child and permits nested lifecycle target", () => {
		const owner = catalog();
		expect(isManagedCatalogProvisional(owner)).toBe(true);
		expect(isSessionAuthorityV3ProvisionalOperation(owner)).toBe(true);
		expect(parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document([], [owner])))).toEqual(
			document([], [owner]),
		);
		const legacyTarget = { sessionId: receipt.sessionId, endpointGeneration: receipt.endpointGeneration };
		expect(isManagedCatalogProvisional(catalog(false, legacyTarget))).toBe(true);
		expect(isSessionAuthorityV3Document(document([], [catalog(false, legacyTarget)]))).toBe(true);
		for (const invalid of [
			catalog(true, legacyTarget),
			catalog(false),
			catalog(true, { ...receipt, endpointIncarnation: "c".repeat(64) }),
		]) {
			expect(isManagedCatalogProvisional(invalid)).toBe(false);
			expect(isSessionAuthorityV3ProvisionalOperation(invalid)).toBe(false);
			expect(isSessionAuthorityV3Document(document([], [invalid]))).toBe(false);
		}
	});

	test("close parsing rejects partial or extra triples and ordinary raw targets retain incarnation bans", () => {
		for (const target of [
			{ sessionId: receipt.sessionId, endpointIncarnation: receipt.endpointIncarnation },
			{ ...receipt, endpointIncarnation: "B".repeat(64) },
			{ ...receipt, endpointGeneration: 9 },
			{ ...receipt, token: "forbidden" },
			{ ...receipt, body: {} },
		])
			expect(() => closeEvidence(target)).toThrow();
		expect(
			isManagedLifecycleEvidence(
				closeEvidence({ sessionId: receipt.sessionId, endpointGeneration: receipt.endpointGeneration }),
			),
		).toBe(true);
		for (const body of [
			{ endpointReceipt: receipt },
			{ lifecycle: observed() },
			{ target: receipt },
			{ token: "forbidden" },
		]) {
			expect(() =>
				createManagedLifecycleEvidence(
					{
						operation: "session.create",
						preparedAuthority: prepared,
						target: { cwd: prepared.canonicalWorkspace, body },
						payloadHash,
					},
					time,
				),
			).toThrow();
		}
		expect(
			isManagedLifecycleEvidence({ ...closeEvidence({ ...receipt }), acknowledged, endpointReceipt: receipt }),
		).toBe(false);
		for (const authority of [
			{ ...observed(), acknowledged: { ...acknowledged, endpointIncarnation: receipt.endpointIncarnation } },
			{ ...active(), proven: { ...proof, endpointIncarnation: receipt.endpointIncarnation } },
		])
			expect(isManagedLifecycleEvidence(authority)).toBe(false);
		const retired = {
			...observed(),
			state: "retired" as const,
			retirement: {
				sessionId: acknowledged.sessionId,
				generation: acknowledged.generation,
				acknowledgedSessionId: acknowledged.sessionId,
				observedAt: later,
				evidence: { source: "session_index", event: "host_unregistered", observedIndexSeq: 2, evidenceIndexSeq: 1 },
			},
		};
		expect(isManagedLifecycleEvidence(retired)).toBe(true);
		expect(
			isManagedLifecycleEvidence({
				...retired,
				retirement: {
					...retired.retirement,
					evidence: { ...retired.retirement.evidence, endpointReceipt: receipt },
				},
			}),
		).toBe(false);
	});

	test("payload lookalikes never gain canonical receipt permissions", () => {
		const late = createManagedLateLifecycleAcknowledgement(operation(), acknowledged, later, receipt);
		const root = mapping([operation(observed())]);
		for (const payload of [
			{ endpointReceipt: receipt },
			{ lifecycle: observed() },
			{ lifecycle: closeEvidence({ ...receipt }) },
			{ journal: [operation(observed())] },
			{ lateLifecycleAcknowledgement: late },
			{ provisionalOperations: [catalog()] },
			{ endpointIncarnation: receipt.endpointIncarnation },
		]) {
			for (const invalid of [
				{ ...root, observations: payload },
				{ ...root, events: [{ type: "message", payload }] },
				{ ...root, managedAuthority: { ...root.managedAuthority, ...payload } },
			]) {
				expect(isSessionAuthorityV3Mapping(invalid)).toBe(false);
				expect(isSessionAuthorityV3Document(document([invalid as SessionAuthorityV3Mapping]))).toBe(false);
			}
		}
		for (const field of ["token", "endpointToken", "descriptor", "processIncarnation", "hostIncarnation", "pid"]) {
			const evidence = { ...observed(), endpointReceipt: { ...receipt, [field]: "forbidden" } };
			expect(isManagedLifecycleEvidence(evidence)).toBe(false);
			expect(isSessionAuthorityV3ProvisionalOperation(provisional(evidence))).toBe(false);
			expect(isSessionAuthorityV3Mapping({ ...root, observations: { [field]: "forbidden" } })).toBe(false);
		}
	});
});
