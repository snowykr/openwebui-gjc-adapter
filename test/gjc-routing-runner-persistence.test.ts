import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackedSessionMappingStore, SessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { buildSessionMappingPayloadHash } from "../src/live/workflow-gate-turns";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

describe("createGjcRoutingLiveGatewayRunner persistence", () => {
	test("persists mappings across file-backed store instances", () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const first = new FileBackedSessionMappingStore(filePath);
		first.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "user-1",
			assistantText: "new:hello",
			events: [{ type: "assistant", text: "new:hello" }],
		});

		const second = new FileBackedSessionMappingStore(filePath);
		expect(second.get("chat-1")).toEqual(first.get("chat-1"));
	});

	test("serializes only exact normalized tuple keys", () => {
		withFileStore((store, filePath) => {
			const modelSelection = { ...mediumSelection };
			Reflect.set(modelSelection, "canonicalId", "gjc/anthropic/claude-sonnet-4:medium");
			store.set(mappingInput(modelSelection));
			const persisted = JSON.parse(readFileSync(filePath, "utf8"));
			expect(persisted.mappings[0].modelSelection).toEqual(mediumSelection);
			expect(JSON.stringify(persisted)).not.toContain("gjc/anthropic");
		});
	});

	test("round-trips a normalized tuple through a file-backed reload", () => {
		withFileStore((store, filePath) => {
			store.set(mappingInput(mediumSelection));
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.modelSelection).toEqual(mediumSelection);
		});
	});

	test("includes the normalized tuple in the mapping payload hash", () => {
		withFileStore(store => {
			const mapping = store.set(mappingInput(mediumSelection));
			expect(buildSessionMappingPayloadHash(mapping)).not.toBe(
				buildSessionMappingPayloadHash({ ...mapping, modelSelection: undefined }),
			);
		});
	});

	test("strips corrupted tuples when loading a file-backed mapping", () => {
		withFileStore((store, filePath) => {
			const mapping = store.set(mappingInput(mediumSelection));
			writeFileSync(
				filePath,
				JSON.stringify({ mappings: [{ ...mapping, modelSelection: { ...mediumSelection, provider: "a%2Fb" } }] }),
			);
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.modelSelection).toBeUndefined();
		});
	});

	test("returns cached duplicate content after store reload without rerunning", async () => {
		const filePath = join(mkdtempSync(join(tmpdir(), "gjc-session-mapping-")), "mappings.json");
		const firstRunner = new FakeGjcTurnRunner();
		const firstStore = new FileBackedSessionMappingStore(filePath);
		const first = createGjcRoutingLiveGatewayRunner({ turnRunner: firstRunner, mappings: firstStore });
		expect(
			await first.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });

		const secondRunner = new FakeGjcTurnRunner();
		const secondStore = new FileBackedSessionMappingStore(filePath);
		const second = createGjcRoutingLiveGatewayRunner({ turnRunner: secondRunner, mappings: secondStore });

		expect(
			await second.run({
				project,
				prompt: "hello",
				chatId: "chat-1",
				messageId: "assistant-1",
				userMessageId: "user-1",
				userMessageParentId: null,
				continued: false,
			}),
		).toEqual({ content: "new:hello" });
		expect(secondRunner.starts).toHaveLength(0);
		expect(secondRunner.switches).toHaveLength(0);
		expect(secondRunner.continues).toHaveLength(0);
	});

	test("enqueues a stable session_mapping outbox operation when provided", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const outbox = new InMemoryOutboxStore();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox, ownerUserId: "owner-1" });

		await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
		});

		const operations = outbox.listPending();
		expect(operations).toHaveLength(1);
		expect(operations[0]).toMatchObject({
			operationId: "user-1",
			ownerUserId: "owner-1",
			projectId: project.id,
			chatId: "chat-1",
			kind: "session_mapping",
			state: "pending",
		});
		const enqueued = outbox.get("user-1");
		if (enqueued === undefined) throw new Error("expected enqueued operation");
		expect(operations[0]?.payloadHash).toBe(enqueued.payloadHash);
	});

	test.each([
		["start", false],
		["continuation", true],
	] as const)("reports the returned %s selection instead of its requested alias", async (_label, continued) => {
		const turnRunner = new FakeGjcTurnRunner();
		const start = turnRunner.startNewSession.bind(turnRunner);
		turnRunner.startNewSession = async input => ({ ...(await start(input)), modelSelection: mediumSelection });
		const resume = turnRunner.continueSession.bind(turnRunner);
		turnRunner.continueSession = async input => ({ ...(await resume(input)), modelSelection: mediumSelection });
		const mappings = new SessionMappingStore();
		if (continued) mappings.set(mappingInput(mediumSelection));
		const transcript: string[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "foreign-callback-must-not-win",
			createNeutralModelReader: () => neutralReader(transcript),
		});

		const result = await runner.run({
			...turn(continued ? "chat-1" : "chat-neutral", "user-2", continued),
			requestedModelId: "gjc",
		});
		const selectedInput = continued ? turnRunner.continues[0] : turnRunner.starts[0];
		expect(transcript).toEqual(["catalog", "state", "stop"]);
		expect(selectedInput?.modelSelection).toEqual(lowSelection);
		if (continued) {
			expect(turnRunner.states).toHaveLength(1);
			expect(selectedInput).toMatchObject({
				activeLeaf: "leaf-1",
				rawFrameCursor: 7,
				eventCursor: 3,
			});
		}
		expect(mappings.get(continued ? "chat-1" : "chat-neutral")?.modelSelection).toEqual(mediumSelection);
		expect(result.model).toBe("gjc/anthropic/claude-sonnet-4:medium");
	});
});

const lowSelection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "low" } as const;
const mediumSelection = { ...lowSelection, thinkingLevel: "medium" } as const;

function mappingInput(modelSelection: typeof mediumSelection) {
	return {
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "user-1",
		modelSelection,
	};
}

function withFileStore(run: (store: FileBackedSessionMappingStore, filePath: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "gjc-selection-mapping-"));
	const filePath = join(root, "mappings.json");
	try {
		run(new FileBackedSessionMappingStore(filePath), filePath);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function neutralReader(transcript: string[]) {
	return {
		async getAvailableModels() {
			transcript.push("catalog");
			return [
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
					reasoning: true,
					thinking: { validLevels: ["off", "low", "medium"] },
				},
			];
		},
		async getState() {
			transcript.push("state");
			return { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "low" };
		},
		stop() {
			transcript.push("stop");
		},
	};
}

function turn(chatId: string, userMessageId: string, continued = false) {
	return {
		project,
		prompt: "hello",
		chatId,
		messageId: `assistant-${userMessageId}`,
		userMessageId,
		userMessageParentId: null,
		continued,
	};
}
