import { describe, expect, test } from "bun:test";
import {
	encodeSessionAuthorityV3Document,
	isSessionAuthorityV3Document,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
} from "../src/gjc/session-authority-v3";

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

describe("session authority v3 full graph", () => {
	test("round-trips the golden graph without dropping replay, gate, successor, provisional, or recursive tombstone evidence", () => {
		const parsed = parseSessionAuthorityV3Document(JSON.stringify(golden()));
		expect(parsed).toBeDefined();
		const replayed = parseSessionAuthorityV3Document(encodeSessionAuthorityV3Document(parsed!));
		expect(replayed).toEqual(parsed);
		expect(replayed!.mappings[0]!.journal[0]!.result!.gate!.gateId).toBe("gate-1");
		expect(replayed!.mappings[0]!.journal[1]!.acknowledgedSuccessor!.sessionId).toBe("session-next");
		expect(replayed!.mappings[0]!.reassignment!.sourceTombstone!.prior!.projectId).toBe("project-older");
		expect(replayed!.provisionalOperations[0]!.managedAuthority.generation).toBe(5);
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
});
