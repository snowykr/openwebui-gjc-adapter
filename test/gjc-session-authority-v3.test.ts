import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createManagedLifecycleEvidence,
	isManagedLifecycleEvidence,
	type ManagedHistoricalSavedSession,
	transitionManagedLifecycleEvidence,
} from "../src/gjc/managed-lifecycle-evidence";
import type { HistoricalSessionBinding } from "../src/gjc/session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Operation,
} from "../src/gjc/session-authority-v3";
import { SessionV3FileBackedMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import type {
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "../src/gjc/turn-runner";

const timestamp = "2026-08-24T00:00:00.000Z";

function authority(chatId: string, projectId: string, sessionId: string, generation = 1) {
	return {
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		principalId: "tenant-a",
		projectId,
		canonicalWorkspace: "/srv/projects/a",
		chatId,
		sessionId,
		generation,
		leaseId: `lease-${generation}`,
		epoch: `runtime-${generation}`,
		requestKey: `request-${generation}`,
	};
}

function mapping(projectId = "project-a", sessionId = "session-current") {
	const chatId = "chat-a";
	const completed = {
		id: "turn-1",
		kind: "prompt",
		state: "complete",
		startedAt: timestamp,
		completedAt: timestamp,
		result: {
			kind: "turn",
			assistantText: "answer",
			managedAuthority: authority(chatId, projectId, sessionId),
			events: [{ type: "message", id: "event-1", payload: { durable: true } }],
			mapping: { chatId, projectId, sessionId, rawFrameCursor: 4, eventCursor: 2, operationId: "turn-1" },
			correlation: { chatId, projectId, operationId: "turn-1" },
			gate: { gateId: "gate-1", commandId: "command-1", turnId: "turn-1", sessionId },
		},
	};
	const tombstone = {
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		chatId,
		projectId: "project-old",
		sessionId: "session-old",
		createdAt: timestamp,
		header: { chatId, projectId: "project-old", sessionId: "session-old" },
		rawFrameCursor: 1,
		eventCursor: 1,
		operationId: "old-turn",
		observations: { source: "retired" },
		managedAuthority: authority(chatId, "project-old", "session-old", 2),
		journal: [],
		retiredAt: timestamp,
		prior: {
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			chatId,
			projectId: "project-older",
			sessionId: "session-older",
			createdAt: timestamp,
			header: { chatId, projectId: "project-older", sessionId: "session-older" },
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "older-turn",
			managedAuthority: authority(chatId, "project-older", "session-older", 3),
			journal: [],
			retiredAt: timestamp,
		},
	};
	return {
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		chatId,
		projectId,
		sessionId,
		createdAt: timestamp,
		header: { chatId, projectId, sessionId },
		rawFrameCursor: 4,
		eventCursor: 2,
		operationId: "turn-1",
		assistantText: "answer",
		events: [{ type: "message", text: "answer" }],
		observations: { source: "golden" },
		managedAuthority: authority(chatId, projectId, sessionId),
		journal: [
			completed,
			{
				id: "create-next",
				kind: "create",
				state: "uncertain",
				startedAt: timestamp,
				acknowledgedSuccessor: {
					sessionId: "session-next",
					managedAuthority: authority(chatId, projectId, "session-next", 4),
				},
			},
		],
		reassignment: {
			state: "committed",
			sourceProjectId: "project-old",
			targetProjectId: projectId,
			startedAt: timestamp,
			completedAt: timestamp,
			sourceTombstone: tombstone,
		},
	};
}

function golden() {
	return {
		kind: SESSION_AUTHORITY_V3_KIND,
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		mappings: [mapping()],
		provisionalOperations: [
			{
				id: "provisional-1",
				kind: "prompt",
				state: "pending",
				startedAt: timestamp,
				chatId: "chat-b",
				projectId: "project-b",
				sessionId: "session-b",
				managedAuthority: authority("chat-b", "project-b", "session-b", 5),
			},
		],
	};
}

function clonedGolden(): Record<string, any> {
	return JSON.parse(JSON.stringify(golden()));
}

function historical(
	chat: string,
	projectId: string,
	sessionId: string | undefined,
	nodeRef: string,
): HistoricalSessionBinding {
	return {
		kind: "unbound-history",
		chatId: chat,
		projectId,
		...(sessionId === undefined ? {} : { sessionId }),
		principalId: "tenant-a",
		canonicalWorkspace: "/srv/projects/a",
		reason: "generation-unproven",
		provenance: { source: "v2", documentHash: "a".repeat(64), nodeHash: "b".repeat(64), nodeRef },
	};
}
function historicalGolden(): unknown {
	const convert = (value: unknown, nodeRef: string): unknown => {
		if (Array.isArray(value)) return value.map((child, index) => convert(child, `${nodeRef}/${index}`));
		if (value === null || typeof value !== "object") return value;
		const entries = Object.entries(value);
		const raw = entries.find(([key]) => key === "managedAuthority")?.[1];
		const projection: Record<string, unknown> = Object.fromEntries(
			entries
				.filter(([key]) => key !== "managedAuthority")
				.map(([key, child]) => [key, convert(child, `${nodeRef}/${key}`)]),
		);
		if (raw !== undefined && raw !== null && typeof raw === "object") {
			const chat = Reflect.get(raw, "chatId");
			const projectId = Reflect.get(raw, "projectId");
			const sessionId = Reflect.get(raw, "sessionId");
			if (typeof chat !== "string" || typeof projectId !== "string" || typeof sessionId !== "string")
				throw new Error("Bad fixture identity.");
			projection.historicalBinding = historical(chat, projectId, sessionId, nodeRef);
		}
		return projection;
	};
	return convert(golden(), "");
}

function bootstrapGraph() {
	const document = historicalGolden();
	if (!isSessionAuthorityV3Document(document)) throw new Error("Historical fixture must be valid V3.");
	const root = document.mappings[0]!;
	if (root.historicalBinding === undefined) throw new Error("Expected unbound fixture.");
	const { canonicalWorkspace: _workspace, ...originalBinding } = root.historicalBinding;
	const historicalBinding: HistoricalSessionBinding = { ...originalBinding, reason: "ownership-unresolved" };
	const prepared: ManagedPreparedTurnAuthority = {
		principalId: "tenant-a",
		projectId: root.projectId,
		canonicalWorkspace: "/srv/projects/a",
		chatId: root.chatId,
		leaseId: "bootstrap-lease",
		epoch: "bootstrap-epoch",
		requestKey: "manifest-occurrence-key",
	};
	const savedSession: ManagedHistoricalSavedSession = {
		id: root.sessionId,
		path: "/srv/projects/a/.gjc/sessions/saved.jsonl",
		identity: {
			dev: "66306",
			ino: "1481656",
			size: 3671,
			mtimeMs: 1788717200450,
			mtimeNs: "1788717200450003321",
			sha256: "b".repeat(64),
			nlink: "1",
			ctimeNs: "1788717200450003321",
		},
	};
	const { nlink: _nlink, ctimeNs: _ctimeNs, ...sessionIdentity } = savedSession.identity;
	const lifecycle = createManagedLifecycleEvidence(
		{
			operation: "session.resume",
			preparedAuthority: prepared,
			historicalSource: {
				kind: "bootstrap-history",
				manifestDigest: "c".repeat(64),
				historicalBinding,
				savedSession,
			},
			target: {
				sessionId: root.sessionId,
				cwd: prepared.canonicalWorkspace,
				sessionPath: savedSession.path,
				sessionIdentity,
			},
			payloadHash: "d".repeat(64),
		},
		timestamp,
	);
	const operation: SessionAuthorityV3Operation = {
		id: "bootstrap-operation",
		kind: "resume",
		state: "pending",
		startedAt: timestamp,
		detail: lifecycle.payloadHash,
		lifecycle,
	};
	const { managedAuthority: _managedAuthority, historicalBinding: _historicalBinding, ...rootFields } = root;
	const mapping = { ...rootFields, historicalBinding, journal: [...root.journal, operation] };
	const graph: SessionAuthorityV3Document = { ...document, mappings: [mapping] };
	const acknowledged: ManagedTurnAuthority = { ...prepared, sessionId: root.sessionId, generation: 19 };
	const proof: ManagedGenerationProof = {
		kind: "managed-generation",
		sessionId: acknowledged.sessionId,
		generation: acknowledged.generation,
		leaseId: acknowledged.leaseId,
		epoch: acknowledged.epoch,
	};
	return {
		document: graph,
		mapping,
		operation,
		lifecycle,
		prepared,
		acknowledged,
		proof,
		historicalBinding,
		priorJournal: structuredClone(root.journal),
	};
}

describe("session authority v3 full graph", () => {
	test("ordinary store reopen retains bootstrap request identity and historical results without serving", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v3-bootstrap-evidence-"));
		const path = join(root, "authority.json");
		try {
			const fixture = bootstrapGraph();
			const invoking = transitionManagedLifecycleEvidence(fixture.lifecycle, "invoking", {}, timestamp);
			const ack = transitionManagedLifecycleEvidence(
				invoking,
				"acknowledged_unproven",
				{ acknowledged: fixture.acknowledged },
				timestamp,
			);
			const active = transitionManagedLifecycleEvidence(
				ack,
				"active_generation_proven",
				{ proven: fixture.proof },
				timestamp,
			);
			for (const lifecycle of [fixture.lifecycle, invoking, ack, active]) {
				const document = {
					...fixture.document,
					mappings: [
						{ ...fixture.mapping, journal: [...fixture.priorJournal, { ...fixture.operation, lifecycle }] },
					],
				};
				writeFileSync(path, encodeSessionAuthorityV3Document(document));
				const store = new SessionV3FileBackedMappingStore(path);
				expect(store.get(fixture.mapping.chatId)).toBeUndefined();
				expect(() => store.assertServingReady()).toThrow("unbound history");
				store.close();
				const recovered = parseSessionAuthorityV3Document(readFileSync(path, "utf8"))!;
				const operation = recovered.mappings[0]!.journal.at(-1)!;
				expect(operation.state).toBe("uncertain");
				expect(operation.lifecycle?.requestKey).toBe(lifecycle.requestKey);
				expect(operation.lifecycle?.requestHash).toBe(lifecycle.requestHash);
				expect(operation.lifecycle?.historicalSource).toEqual(lifecycle.historicalSource);
				expect(operation.lifecycle?.acknowledged).toEqual(lifecycle.acknowledged);
				expect(operation.lifecycle?.proven).toEqual(lifecycle.proven);
				expect(recovered.mappings[0]!.journal[0]).toEqual(fixture.priorJournal[0]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("round-trips pending bootstrap acknowledgement and proof without promoting historical graph authority", () => {
		const fixture = bootstrapGraph();
		const invoking = transitionManagedLifecycleEvidence(fixture.lifecycle, "invoking", {}, timestamp);
		const ack = transitionManagedLifecycleEvidence(
			invoking,
			"acknowledged_unproven",
			{ acknowledged: fixture.acknowledged },
			timestamp,
		);
		const active = transitionManagedLifecycleEvidence(
			ack,
			"active_generation_proven",
			{ proven: fixture.proof },
			timestamp,
		);
		for (const lifecycle of [fixture.lifecycle, invoking, ack, active]) {
			const document = {
				...fixture.document,
				mappings: [{ ...fixture.mapping, journal: [...fixture.priorJournal, { ...fixture.operation, lifecycle }] }],
			};
			expect(isManagedLifecycleEvidence(lifecycle)).toBe(true);
			expect(isSessionAuthorityV3Document(document)).toBe(true);
			const replayed = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document))!;
			expect(structuredClone(replayed)).toEqual(structuredClone(document));
			expect(replayed.mappings[0]!.managedAuthority).toBeUndefined();
			expect(replayed.mappings[0]!.historicalBinding).toEqual(fixture.historicalBinding);
			expect(replayed.mappings[0]!.journal.slice(0, -1)).toEqual([...fixture.priorJournal]);
		}
	});

	test("permits bootstrap success result only after promotion while preserving original historical results", () => {
		const fixture = bootstrapGraph();
		const ack = transitionManagedLifecycleEvidence(
			transitionManagedLifecycleEvidence(fixture.lifecycle, "invoking", {}, timestamp),
			"acknowledged_unproven",
			{ acknowledged: fixture.acknowledged },
			timestamp,
		);
		const active = transitionManagedLifecycleEvidence(
			ack,
			"active_generation_proven",
			{ proven: fixture.proof },
			timestamp,
		);
		const managedAuthority = { ...fixture.acknowledged, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH };
		const completed: SessionAuthorityV3Operation = {
			...fixture.operation,
			state: "complete",
			completedAt: timestamp,
			lifecycle: active,
			result: {
				kind: "control",
				assistantText: "resumed",
				managedAuthority,
				mapping: {
					chatId: fixture.mapping.chatId,
					projectId: fixture.mapping.projectId,
					sessionId: fixture.mapping.sessionId,
					operationId: fixture.operation.id,
					rawFrameCursor: 4,
					eventCursor: 2,
				},
			},
		};
		expect(
			isSessionAuthorityV3Document({
				...fixture.document,
				mappings: [{ ...fixture.mapping, journal: [...fixture.priorJournal, completed] }],
			}),
		).toBe(false);
		const { historicalBinding: _historical, ...fields } = fixture.mapping;
		const promoted = { ...fields, managedAuthority, journal: [...fixture.priorJournal, completed] };
		const document: SessionAuthorityV3Document = { ...fixture.document, mappings: [promoted] };
		expect(isSessionAuthorityV3Document(document)).toBe(true);
		const reopened = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document))!;
		expect(structuredClone(reopened)).toEqual(structuredClone(document));
		expect(reopened.mappings[0]!.journal[0]!.result!.managedAuthority).toBeUndefined();
		expect(reopened.mappings[0]!.journal[0]!.result!.historicalBinding).toBeDefined();
		expect(reopened.mappings[0]!.journal.at(-1)!.lifecycle!.historicalSource).toEqual(active.historicalSource);
		for (const patch of [{ principalId: "foreign" }, { canonicalWorkspace: "/foreign" }])
			expect(
				isSessionAuthorityV3Document({
					...document,
					mappings: [{ ...promoted, managedAuthority: { ...managedAuthority, ...patch } }],
				}),
			).toBe(false);
	});

	test("rejects bootstrap evidence coupled to another historical occurrence or unresolved owner container", () => {
		const fixture = bootstrapGraph();
		for (const provenance of [
			{ ...fixture.historicalBinding.provenance, nodeRef: "/mappings/1" },
			{ ...fixture.historicalBinding.provenance, documentHash: "f".repeat(64) },
			{ ...fixture.historicalBinding.provenance, nodeHash: "f".repeat(64) },
		]) {
			const lifecycle = createManagedLifecycleEvidence(
				{
					operation: "session.resume",
					preparedAuthority: fixture.prepared,
					historicalSource: {
						...fixture.lifecycle.historicalSource!,
						historicalBinding: { ...fixture.historicalBinding, provenance },
					},
					target: fixture.lifecycle.target,
					payloadHash: fixture.lifecycle.payloadHash,
				},
				timestamp,
			);
			expect(isManagedLifecycleEvidence(lifecycle)).toBe(true);
			expect(
				isSessionAuthorityV3Document({
					...fixture.document,
					mappings: [
						{ ...fixture.mapping, journal: [...fixture.priorJournal, { ...fixture.operation, lifecycle }] },
					],
				}),
			).toBe(false);
		}
		const { principalId: _principal, ...unowned } = fixture.historicalBinding;
		const historicalBinding: HistoricalSessionBinding = { ...unowned, reason: "ownership-unresolved" };
		const lifecycle = createManagedLifecycleEvidence(
			{
				operation: "session.resume",
				preparedAuthority: fixture.prepared,
				historicalSource: { ...fixture.lifecycle.historicalSource!, historicalBinding },
				target: fixture.lifecycle.target,
				payloadHash: fixture.lifecycle.payloadHash,
			},
			timestamp,
		);
		const mapping = {
			...fixture.mapping,
			historicalBinding,
			journal: [...fixture.priorJournal, { ...fixture.operation, lifecycle }],
		};
		expect(isSessionAuthorityV3Document({ ...fixture.document, mappings: [mapping] })).toBe(true);
		const orphan = { ...fixture.operation, chatId: fixture.mapping.chatId, projectId: fixture.mapping.projectId };
		expect(isSessionAuthorityV3Document({ ...fixture.document, mappings: [], provisionalOperations: [orphan] })).toBe(
			false,
		);
	});

	test("retains scoped historical provisional bootstrap evidence without canonicalizing its logical acknowledgement", () => {
		const fixture = bootstrapGraph();
		const chatId = JSON.stringify([fixture.prepared.principalId, fixture.prepared.chatId]);
		const historicalBinding = {
			...fixture.historicalBinding,
			chatId,
			provenance: { ...fixture.historicalBinding.provenance, nodeRef: "/provisionalOperations/0" },
		};
		const intent = createManagedLifecycleEvidence(
			{
				operation: "session.resume",
				preparedAuthority: fixture.prepared,
				historicalSource: { ...fixture.lifecycle.historicalSource!, historicalBinding },
				target: fixture.lifecycle.target,
				payloadHash: fixture.lifecycle.payloadHash,
			},
			timestamp,
		);
		const ack = transitionManagedLifecycleEvidence(
			transitionManagedLifecycleEvidence(intent, "invoking", {}, timestamp),
			"acknowledged_unproven",
			{ acknowledged: fixture.acknowledged },
			timestamp,
		);
		const active = transitionManagedLifecycleEvidence(
			ack,
			"active_generation_proven",
			{ proven: fixture.proof },
			timestamp,
		);
		for (const lifecycle of [intent, ack, active]) {
			const document: SessionAuthorityV3Document = {
				...fixture.document,
				mappings: [],
				provisionalOperations: [
					{
						...fixture.operation,
						chatId,
						projectId: fixture.mapping.projectId,
						sessionId: fixture.mapping.sessionId,
						historicalBinding,
						lifecycle,
					},
				],
			};
			expect(isSessionAuthorityV3Document(document)).toBe(true);
			const decoded = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(document))!;
			expect(structuredClone(decoded)).toEqual(structuredClone(document));
			expect(decoded.provisionalOperations[0]!.lifecycle!.historicalSource!.historicalBinding.chatId).toBe(chatId);
			if (lifecycle.acknowledged !== undefined)
				expect(decoded.provisionalOperations[0]!.lifecycle!.acknowledged!.chatId).toBe(fixture.prepared.chatId);
		}
	});

	test("allows public saved selection fields only in validated bootstrap lifecycle positions", () => {
		const fixture = bootstrapGraph();
		expect(isSessionAuthorityV3Document(fixture.document)).toBe(true);
		for (const field of ["sessionPath", "sessionIdentity", "savedSession"]) {
			const value =
				field === "savedSession"
					? fixture.lifecycle.historicalSource!.savedSession
					: fixture.lifecycle.target[field];
			expect(
				isSessionAuthorityV3Document({
					...fixture.document,
					mappings: [{ ...fixture.mapping, observations: { [field]: value } }],
				}),
			).toBe(false);
		}
		expect(
			isSessionAuthorityV3Document({
				...fixture.document,
				mappings: [{ ...fixture.mapping, observations: { lifecycle: fixture.lifecycle } }],
			}),
		).toBe(false);
		const changed = {
			...fixture.operation,
			lifecycle: {
				...fixture.lifecycle,
				historicalSource: {
					...fixture.lifecycle.historicalSource!,
					savedSession: { ...fixture.lifecycle.historicalSource!.savedSession, path: "/foreign/saved.jsonl" },
				},
			},
		};
		expect(
			isSessionAuthorityV3Document({
				...fixture.document,
				mappings: [{ ...fixture.mapping, journal: [...fixture.priorJournal, changed] }],
			}),
		).toBe(false);
	});

	test("round-trips generation-free ordinary history at every identity occurrence", () => {
		const value = historicalGolden();
		expect(isSessionAuthorityV3Document(value)).toBe(true);
		if (!isSessionAuthorityV3Document(value)) throw new Error("Historical fixture must be valid V3.");
		const parsed = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(value))!;
		expect(parsed).toEqual(value);
		expect(parsed.mappings[0]!.managedAuthority).toBeUndefined();
		expect(parsed.mappings[0]!.journal[0]!.result!.historicalBinding?.sessionId).toBe("session-current");
		expect(parsed.mappings[0]!.journal[1]!.acknowledgedSuccessor!.historicalBinding?.sessionId).toBe("session-next");
		expect(parsed.mappings[0]!.reassignment!.sourceTombstone!.prior!.historicalBinding?.sessionId).toBe(
			"session-older",
		);
		expect(parsed.provisionalOperations[0]!.historicalBinding?.sessionId).toBe("session-b");
	});

	test("rejects simultaneous bindings and forged authority fields on unbound history", () => {
		const raw = historicalGolden();
		if (!isSessionAuthorityV3Document(raw)) throw new Error("Historical fixture must be valid V3.");
		for (const patch of [{ generation: 0 }, { generation: 9 }, { leaseId: "invented" }, { requestKey: "invented" }]) {
			const candidate = {
				...raw,
				mappings: [
					{ ...raw.mappings[0]!, historicalBinding: { ...raw.mappings[0]!.historicalBinding!, ...patch } },
				],
			};
			expect(isSessionAuthorityV3Document(candidate)).toBe(false);
		}
		expect(
			isSessionAuthorityV3Document({
				...raw,
				mappings: [{ ...raw.mappings[0]!, managedAuthority: authority("chat-a", "project-a", "session-current") }],
			}),
		).toBe(false);
		const bound = golden();
		expect(
			isSessionAuthorityV3Document({
				...bound,
				mappings: [
					{ ...bound.mappings[0], managedAuthority: { ...bound.mappings[0].managedAuthority, generation: 0 } },
				],
			}),
		).toBe(false);
	});

	test("allows inert projection fields only at declared graph locations", () => {
		const value = historicalGolden();
		if (!isSessionAuthorityV3Document(value)) throw new Error("Historical fixture must be valid V3.");
		const root = value.mappings[0]!;
		const result = root.journal[0]!.result!;
		const projected = {
			...value,
			mappings: [
				{
					...root,
					sessionFile: "/projection/current.jsonl",
					activeLeaf: "leaf",
					journal: [
						{
							...root.journal[0]!,
							result: {
								...result,
								mapping: { ...result.mapping, sessionFile: "/projection/replay.jsonl", activeLeaf: "old-leaf" },
							},
						},
						...root.journal.slice(1),
					],
				},
			],
		};
		expect(isSessionAuthorityV3Document(projected)).toBe(true);
		expect(
			isSessionAuthorityV3Document({
				...projected,
				mappings: [{ ...projected.mappings[0], observations: { sessionFile: "/hidden" } }],
			}),
		).toBe(false);
		expect(
			isSessionAuthorityV3Document({
				...projected,
				mappings: [{ ...projected.mappings[0], events: [{ type: "event", payload: { descriptor: "private" } }] }],
			}),
		).toBe(false);
	});

	test("rejects scoped foreign historical ownership and lifecycle claims on unbound nodes", () => {
		const scoped = JSON.stringify(["tenant-a", "chat-a"]);
		const binding = historical(scoped, "project-a", "session-a", "/provisionalOperations/0");
		const provisional = {
			id: "reserve",
			kind: "create",
			state: "uncertain",
			startedAt: timestamp,
			chatId: scoped,
			projectId: "project-a",
			sessionId: "session-a",
			historicalBinding: binding,
		};
		const document = {
			kind: SESSION_AUTHORITY_V3_KIND,
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: [],
			provisionalOperations: [provisional],
		};
		expect(isSessionAuthorityV3Document(document)).toBe(true);
		expect(
			isSessionAuthorityV3Document({
				...document,
				provisionalOperations: [{ ...provisional, historicalBinding: { ...binding, principalId: "foreign" } }],
			}),
		).toBe(false);
		const prepared = {
			principalId: "tenant-a",
			projectId: "project-a",
			canonicalWorkspace: "/srv/projects/a",
			chatId: "chat-a",
			leaseId: "lease",
			epoch: "epoch",
			requestKey: "create",
		};
		const lifecycle = createManagedLifecycleEvidence(
			{
				operation: "session.create",
				preparedAuthority: prepared,
				target: { cwd: prepared.canonicalWorkspace },
				payloadHash: "a".repeat(64),
			},
			timestamp,
		);
		expect(
			isSessionAuthorityV3Document({
				...document,
				provisionalOperations: [{ ...provisional, detail: lifecycle.payloadHash, lifecycle }],
			}),
		).toBe(false);
	});
	test("opens the golden graph and preserves runtime epochs across mutation and reopen", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v3-golden-store-"));
		const file = join(root, "authority.json");
		writeFileSync(file, JSON.stringify(golden()));
		let store: SessionV3FileBackedMappingStore | undefined;
		try {
			store = new SessionV3FileBackedMappingStore(file);
			store.beginOperation("chat-a", { id: "next-prompt", kind: "prompt", detail: "hash" });
			store.close();
			store = new SessionV3FileBackedMappingStore(file);
			expect(store.operation("chat-a", "next-prompt")?.state).toBe("uncertain");
			const persisted = parseSessionAuthorityV3Document(readFileSync(file, "utf8"))!;
			expect(persisted.mappings[0].managedAuthority?.epoch).toBe("runtime-1");
			expect(persisted.mappings[0].journal[0].result).toEqual(
				parseSessionAuthorityV3Document(JSON.stringify(golden()))!.mappings[0].journal[0].result,
			);
			expect(persisted.mappings[0].journal[1].acknowledgedSuccessor?.managedAuthority?.epoch).toBe("runtime-4");
			expect(persisted.mappings[0].reassignment?.sourceTombstone?.prior?.managedAuthority?.epoch).toBe("runtime-3");
			expect(persisted.provisionalOperations[0].managedAuthority?.epoch).toBe("runtime-5");
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("round-trips the golden graph without dropping replay, gate, successor, provisional, or recursive tombstone evidence", () => {
		const parsed = parseSessionAuthorityV3Document(JSON.stringify(golden()));
		expect(parsed).toBeDefined();
		const replayed = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(parsed!));
		expect(replayed).toEqual(parsed);
		expect(replayed!.mappings[0]!.journal[0]!.result!.gate!.gateId).toBe("gate-1");
		expect(replayed!.mappings[0]!.journal[1]!.acknowledgedSuccessor!.sessionId).toBe("session-next");
		expect(replayed!.mappings[0]!.reassignment!.sourceTombstone!.prior!.projectId).toBe("project-older");
		expect(replayed!.provisionalOperations[0]!.managedAuthority!.generation).toBe(5);
	});

	test("encodes deterministic bytes independent of source key order", () => {
		const first = parseSessionAuthorityV3Document(JSON.stringify(golden()))!;
		const source = golden();
		const second = parseSessionAuthorityV3Document(
			JSON.stringify({
				provisionalOperations: source.provisionalOperations,
				mappings: source.mappings,
				authorityEpoch: source.authorityEpoch,
				version: source.version,
				kind: source.kind,
			}),
		)!;
		expect(encodeSessionAuthorityV3Document(first)).toBe(encodeSessionAuthorityV3Document(second));
	});

	test("rejects malformed scalar authority, model selection, and nested credential data", () => {
		for (const patch of [{ generation: 0 }, { generation: 1.5 }, { requestKey: "" }, { token: "secret" }]) {
			const value = clonedGolden();
			Object.assign(value.mappings[0].managedAuthority, patch);
			expect(parseSessionAuthorityV3Document(JSON.stringify(value))).toBeUndefined();
		}
		for (const patch of [
			{ modelSelection: { provider: "provider", modelId: "model", thinkingLevel: "invalid" } },
			{ events: [{ type: "message", payload: { token: "secret" } }] },
			{ operationId: "" },
		]) {
			const value = clonedGolden();
			Object.assign(value.mappings[0], patch);
			expect(parseSessionAuthorityV3Document(JSON.stringify(value))).toBeUndefined();
		}
	});

	test("canonical decoding detaches model selection and nested event history", () => {
		const source = {
			...golden(),
			mappings: [{ ...mapping(), modelSelection: { provider: "provider", modelId: "model", thinkingLevel: "low" } }],
		};
		const before = JSON.stringify(source);
		const parsed = parseSessionAuthorityV3Document(before)!;
		expect(parsed).toBeDefined();
		expect(encodeSessionAuthorityV3Document(parsed)).toBe(
			encodeSessionAuthorityV3Document(parseSessionAuthorityV3Document(before)!),
		);
		Reflect.set(parsed.mappings[0]!.modelSelection!, "modelId", "changed");
		Reflect.set(parsed.mappings[0]!.journal[0]!.result!.events![0]!.payload!, "durable", false);
		expect(JSON.stringify(source)).toBe(before);
		expect(encodeSessionAuthorityV3Document(parsed)).not.toBe(
			encodeSessionAuthorityV3Document(parseSessionAuthorityV3Document(before)!),
		);
	});

	test("rejects malformed relational identities and tenant authority mismatches", () => {
		const wrongResult = clonedGolden();
		wrongResult.mappings[0].journal[0].result.mapping.operationId = "other";
		expect(isSessionAuthorityV3Document(wrongResult)).toBeFalse();
		const wrongTenant = clonedGolden();
		wrongTenant.mappings[0].managedAuthority.projectId = "other-project";
		expect(isSessionAuthorityV3Document(wrongTenant)).toBeFalse();
		const duplicate = clonedGolden();
		duplicate.provisionalOperations.push({
			...duplicate.provisionalOperations[0],
			id: "provisional-2",
			ingressId: "provisional-1",
		});
		expect(isSessionAuthorityV3Document(duplicate)).toBeFalse();
	});

	test("rejects legacy attachment credentials at any graph depth and missing managed authority", () => {
		for (const mutate of [
			(value: Record<string, any>) => {
				value.mappings[0].attachment = { descriptorPath: "/secret" };
			},
			(value: Record<string, any>) => {
				value.mappings[0].journal[0].result.mapping.tmuxPane = "%1";
			},
			(value: Record<string, any>) => {
				value.mappings[0].reassignment.sourceTombstone.prior.managedAuthority.descriptorPath = "/legacy";
			},
			(value: Record<string, any>) => {
				delete value.provisionalOperations[0].managedAuthority;
			},
		]) {
			const value = clonedGolden();
			mutate(value);
			expect(parseSessionAuthorityV3Document(JSON.stringify(value))).toBeUndefined();
		}
	});

	test("rejects a foreign principal throughout an owned managed graph", () => {
		for (const mutate of [
			(value: Record<string, any>) => {
				value.mappings[0].journal[0].result.managedAuthority.principalId = "tenant-b";
			},
			(value: Record<string, any>) => {
				value.mappings[0].journal[1].acknowledgedSuccessor.managedAuthority.principalId = "tenant-b";
			},
			(value: Record<string, any>) => {
				value.mappings[0].reassignment.sourceTombstone.managedAuthority.principalId = "tenant-b";
			},
			(value: Record<string, any>) => {
				value.mappings[0].reassignment.sourceTombstone.prior.managedAuthority.principalId = "tenant-b";
			},
			(value: Record<string, any>) => {
				value.provisionalOperations = [
					{
						id: "foreign-reservation",
						kind: "create",
						state: "pending",
						startedAt: timestamp,
						chatId: "chat-a",
						projectId: "project-a",
						sessionId: "session-next",
						managedAuthority: { ...authority("chat-a", "project-a", "session-next"), principalId: "tenant-b" },
					},
				];
			},
			(value: Record<string, any>) => {
				value.mappings[0].observations.__gjcSessionMappingScope = { principalId: "tenant-b" };
			},
		]) {
			const document = clonedGolden();
			mutate(document);
			expect(parseSessionAuthorityV3Document(JSON.stringify(document))).toBeUndefined();
		}
	});

	test("rejects a foreign reservation-only authority and nested results or successors on reopen", () => {
		const chatId = JSON.stringify(["tenant-a", "chat-a"]);
		const bound = authority(chatId, "project-a", "reserved");
		const root = mkdtempSync(join(tmpdir(), "gjc-v3-reservation-ownership-"));
		const file = join(root, "authority.json");
		const base = {
			kind: SESSION_AUTHORITY_V3_KIND,
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: [],
			provisionalOperations: [
				{
					id: "reserve",
					kind: "create",
					state: "pending",
					startedAt: timestamp,
					chatId,
					projectId: "project-a",
					sessionId: "reserved",
					managedAuthority: bound,
				},
			],
		};
		try {
			writeFileSync(file, JSON.stringify(base));
			const valid = new SessionV3FileBackedMappingStore(file);
			expect(
				valid.provisionalOperationScoped({ principalId: "tenant-a", chatId: "chat-a" }, "reserve")?.managedAuthority
					?.principalId,
			).toBe("tenant-a");
			valid.close();
			for (const scenario of [
				"owner",
				"successor-principal",
				"successor-workspace",
				"result-principal",
				"result-workspace",
			]) {
				const value: Record<string, any> = structuredClone(base);
				const operation = value.provisionalOperations[0];
				if (scenario === "owner") operation.managedAuthority.principalId = "tenant-b";
				else if (scenario.startsWith("successor"))
					operation.acknowledgedSuccessor = {
						sessionId: "next",
						managedAuthority: {
							...bound,
							sessionId: "next",
							...(scenario.endsWith("principal")
								? { principalId: "tenant-b" }
								: { canonicalWorkspace: "/foreign" }),
						},
					};
				else {
					operation.state = "complete";
					operation.completedAt = timestamp;
					operation.result = {
						kind: "control",
						assistantText: "",
						managedAuthority: {
							...bound,
							...(scenario.endsWith("principal")
								? { principalId: "tenant-b" }
								: { canonicalWorkspace: "/foreign" }),
						},
						mapping: {
							chatId,
							projectId: "project-a",
							sessionId: "reserved",
							operationId: "reserve",
							rawFrameCursor: 0,
							eventCursor: 0,
						},
					};
				}
				writeFileSync(file, JSON.stringify(value));
				expect(parseSessionAuthorityV3Document(JSON.stringify(value))).toBeUndefined();
				expect(() => new SessionV3FileBackedMappingStore(file)).toThrow("not strict V3");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("requires duplicate prior tombstone storage to match validated retained history", () => {
		const value = clonedGolden();
		value.mappings[0].reassignment.priorTombstone = structuredClone(
			value.mappings[0].reassignment.sourceTombstone.prior,
		);
		expect(parseSessionAuthorityV3Document(JSON.stringify(value))).toBeDefined();
		for (const mutate of [
			(prior: Record<string, any>) => {
				prior.managedAuthority.principalId = "foreign";
			},
			(prior: Record<string, any>) => {
				prior.events = [{ type: "message", text: "forged history" }];
			},
			(prior: Record<string, any>) => {
				prior.journal = [{ id: "forged", kind: "prompt", state: "pending", startedAt: timestamp }];
			},
		]) {
			const corrupt = structuredClone(value);
			mutate(corrupt.mappings[0].reassignment.priorTombstone);
			expect(parseSessionAuthorityV3Document(JSON.stringify(corrupt))).toBeUndefined();
		}
	});

	test("rejects a foreign successor workspace in a scoped reservation before persistence", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v3-provisional-successor-"));
		const file = join(root, "authority.json");
		const store = new SessionV3FileBackedMappingStore(file);
		const scope = { principalId: "tenant-a", chatId: "chat-a" };
		const bound = authority(scope.chatId, "project-a", "reserved");
		try {
			for (const canonicalWorkspace of ["/foreign", bound.canonicalWorkspace]) {
				const operation = {
					id: "reserve",
					kind: "create" as const,
					chatId: scope.chatId,
					projectId: "project-a",
					sessionId: "reserved",
					managedAuthority: bound,
					acknowledgedSuccessor: {
						sessionId: "next",
						managedAuthority: { ...bound, sessionId: "next", canonicalWorkspace },
					},
				};
				if (canonicalWorkspace === "/foreign") {
					expect(() => store.reserveProvisionalOperationScoped(scope, operation as never)).toThrow();
					expect(store.provisionalOperationScoped(scope, operation.id)).toBeUndefined();
				} else {
					store.reserveProvisionalOperationScoped(scope, operation as never);
					expect(parseSessionAuthorityV3Document(readFileSync(file, "utf8"))).toBeDefined();
				}
			}
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
