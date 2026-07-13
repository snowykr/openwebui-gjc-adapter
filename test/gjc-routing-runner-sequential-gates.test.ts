import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackedSessionMappingStore } from "../src/gjc/session-router";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { deepInterviewWorkflowGateEvent, FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

describe("createGjcRoutingLiveGatewayRunner sequential workflow gates", () => {
	test("resumes a persisted correlation and stores the next gate", async () => {
		// Given: a process restart reloads a pending gate and its SDK turn correlation.
		const root = mkdtempSync(join(tmpdir(), "gjc-sequential-gate-"));
		try {
			const filePath = join(root, "mappings.json");
			new FileBackedSessionMappingStore(filePath).set({
				chatId: "chat-1",
				projectId: project.id,
				sessionId: "session-1",
				sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
				activeLeaf: "leaf-1",
				rawFrameCursor: 7,
				eventCursor: 3,
				operationId: "user-1",
				assistantText: "pending",
				modelSelection: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "medium" },
				events: [deepInterviewWorkflowGateEvent],
			});
			const mappings = new FileBackedSessionMappingStore(filePath);
			const turnRunner = new FakeGjcTurnRunner();
			turnRunner.gateResponseEvents = [nextWorkflowGateEvent];
			const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

			// When: the reloaded gate is answered.
			const result = await runner.run({
				project,
				prompt: "1",
				chatId: "chat-1",
				messageId: "assistant-2",
				userMessageId: "user-2",
				userMessageParentId: "user-1",
				continued: true,
			});

			// Then: the resumed answer uses the original correlation and persists the new gate.
			expect(turnRunner.gateResponses[0]?.gateCorrelation).toEqual({
				commandId: "command-1",
				turnId: "turn-1",
				sessionId: "session-1",
			});
			expect(result.content).toContain("Choose deployment target");
			expect(result.content).toContain("1. Cloud");
			expect(new FileBackedSessionMappingStore(filePath).get("chat-1")?.events?.at(-1)).toMatchObject({
				id: "gate-deep-2",
				payload: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

const nextWorkflowGateEvent = {
	type: "workflow_gate",
	id: "gate-deep-2",
	payload: {
		gateId: "gate-deep-2",
		schemaHash: "sha256:next",
		idempotencyKey: "idem-deep-2",
		commandId: "command-1",
		turnId: "turn-1",
		sessionId: "session-1",
		context: { prompt: "Choose deployment target" },
		options: [
			{ label: "Cloud", value: "cloud" },
			{ label: "Local", value: "local" },
		],
		schema: { type: "string", enum: ["cloud", "local"] },
	},
} as const;
