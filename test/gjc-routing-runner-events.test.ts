import { describe, expect, test } from "bun:test";
import { SessionMappingStore } from "../src/gjc/session-router";
import type {
	GjcContinueSessionInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../src/gjc/turn-runner";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import type { RegisteredProject } from "../src/projects/registry";
import { attachmentProof, lifecycleFixture } from "./gjc-lifecycle-fixtures";
import { staticModelReaderFactory } from "./model-selection-fixtures";

class FakeGjcTurnRunner implements GjcTurnRunner {
	events: GjcTurnResult["events"] = [{ type: "assistant", text: "assistant from gjc" }];
	state: GjcSessionState = {
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
	};

	async startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (
			result: GjcSessionAddress & GjcTurnResult,
			lifecycle: ReturnType<typeof lifecycleFixture>,
		) => Promise<T>,
	): Promise<T> {
		const result = {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-1",
			text: `new:${input.text}`,
			events: this.events,
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
		return await publish({ ...result, attachment: attachmentProof(result) }, lifecycleFixture(result));
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		return {
			text: `continued:${input.text}`,
			events: this.events,
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-2",
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		};
	}

	async switchSession(_input: GjcSwitchSessionInput): Promise<void> {}

	async getState(_input: GjcSessionStateInput): Promise<GjcSessionState> {
		return this.state;
	}
}

describe("createGjcRoutingLiveGatewayRunner event projection", () => {
	test("projects GJC agent lifecycle events as visible subagent status events", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [
			{ type: "agent_start", id: "agent-1", text: "Subagent started" },
			{ type: "agent_end", id: "agent-1", text: "Subagent done" },
			{ type: "assistant", text: "done" },
		];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new SessionMappingStore(),
			modelReaderFactory: staticModelReaderFactory(),
		});

		const result = await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
			requestedModelId: "gjc",
		});

		expect(result).toMatchObject({
			content: "new:hello",
			events: [
				{
					type: "status",
					data: {
						description: "agent_start",
						done: false,
						gjc_adapter: {
							frameKind: "subagent_progress",
							phase: "progress",
							model: "gjc/anthropic/claude-sonnet-4:low",
							metadata: { eventType: "agent_start", id: "agent-1" },
						},
					},
				},
				{
					type: "status",
					data: {
						description: "agent_end",
						done: true,
						gjc_adapter: {
							frameKind: "subagent_progress",
							phase: "end",
							metadata: { eventType: "agent_end", id: "agent-1" },
						},
					},
				},
			],
		});
		expect(JSON.stringify(result.events)).not.toContain("Subagent started");
		expect(JSON.stringify(result.events)).not.toContain("Subagent done");
	});

	test("omits raw unsupported GJC event text from OpenWebUI status metadata", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [
			{ type: "message_start", id: "message-1", text: "SECRET_PROMPT_TEXT_SHOULD_NOT_BE_STORED" },
			{ type: "assistant", text: "done" },
		];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new SessionMappingStore(),
			modelReaderFactory: staticModelReaderFactory(),
		});

		const result = await runner.run({
			project,
			prompt: "hello",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
			requestedModelId: "gjc",
		});

		expect(JSON.stringify(result.events)).not.toContain("SECRET_PROMPT_TEXT_SHOULD_NOT_BE_STORED");
		expect(result.events).toEqual([
			expect.objectContaining({
				type: "status",
				data: expect.objectContaining({
					hidden: true,
					gjc_adapter: expect.objectContaining({
						metadata: { id: "message-1", textPresent: true },
					}),
				}),
			}),
		]);
	});

	test("projects workflow gates with structured OpenWebUI status metadata", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [
			{
				type: "workflow_gate",
				id: "gate-plan-1",
				payload: {
					gateId: "gate-plan-1",
					stage: "ralplan",
					kind: "approval",
					schemaHash: "sha256:decision",
					createdAt: "2026-07-09T00:00:00.000Z",
					required: true,
					context: { prompt: "Approve this plan?" },
					options: [{ label: "Approve", value: "approve" }],
					schema: {
						type: "object",
						required: ["decision"],
						properties: { decision: { type: "string", enum: ["approve"] } },
					},
				},
			},
		];
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings: new SessionMappingStore(),
			modelReaderFactory: staticModelReaderFactory(),
		});

		const result = await runner.run({
			project,
			prompt: "/ralplan",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			continued: false,
			requestedModelId: "gjc",
		});

		expect(result.events).toEqual([
			expect.objectContaining({
				type: "status",
				data: expect.objectContaining({
					gjc_adapter: expect.objectContaining({
						workflow_gate: expect.objectContaining({
							gateId: "gate-plan-1",
							stage: "ralplan",
							kind: "approval",
							schemaHash: "sha256:decision",
							createdAt: "2026-07-09T00:00:00.000Z",
							required: true,
						}),
					}),
				}),
			}),
		]);
	});
});

const project: RegisteredProject = {
	id: "project",
	name: "Project",
	cwd: "/workspace/project",
	allowedRoot: "/workspace",
	createdAt: new Date("2026-07-08T00:00:00.000Z"),
};
