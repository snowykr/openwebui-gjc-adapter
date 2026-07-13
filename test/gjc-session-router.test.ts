import { describe, expect, test } from "bun:test";
import type { NormalizedModelSelection } from "../src/contracts";
import type {
	GjcContinueSessionInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../src/gjc/rpc-runner";
import { type RouteGjcTurnInput, routeGjcTurn, SessionMappingStore } from "../src/gjc/session-router";
import type { RegisteredProject } from "../src/projects/registry";

class FakeGjcTurnRunner implements GjcTurnRunner {
	readonly starts: GjcStartNewSessionInput[] = [];
	readonly continues: GjcContinueSessionInput[] = [];
	readonly switches: GjcSwitchSessionInput[] = [];
	readonly states: GjcSessionStateInput[] = [];

	state: GjcSessionState = {
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 7,
		eventCursor: 3,
	};
	returnedSelection: NormalizedModelSelection | undefined;
	failPrompt = false;

	async startNewSession(input: GjcStartNewSessionInput): Promise<GjcSessionAddress & GjcTurnResult> {
		this.starts.push(input);
		if (this.failPrompt) throw new Error("prompt failed");
		return {
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: input.projectId,
			chatId: input.chatId,
			sessionId: "session-1",
			text: `new:${input.text}`,
			events: [{ type: "assistant", text: `new:${input.text}` }],
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			...(this.returnedSelection === undefined ? {} : { modelSelection: this.returnedSelection }),
		};
	}

	async continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		this.continues.push(input);
		if (this.failPrompt) throw new Error("prompt failed");
		return {
			text: `continued:${input.text}`,
			events: [{ type: "assistant", text: `continued:${input.text}` }],
			sessionFile: input.sessionFile,
			activeLeaf: "leaf-2",
			rawFrameCursor: input.rawFrameCursor + 5,
			eventCursor: input.eventCursor + 2,
			...(this.returnedSelection === undefined ? {} : { modelSelection: this.returnedSelection }),
		};
	}

	async switchSession(input: GjcSwitchSessionInput): Promise<void> {
		this.switches.push(input);
	}

	async getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		this.states.push(input);
		return this.state;
	}
}

describe("routeGjcTurn", () => {
	test("starts a project-bound session when no chat mapping exists", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const project = createProject();

		const result = await routeGjcTurn(routeInput(runner, mappings, { project }));

		expect(runner.starts).toHaveLength(1);
		expect(runner.starts[0]).toMatchObject({
			cwd: project.cwd,
			sessionRoot: `${project.cwd}/.gjc/sessions`,
			projectId: project.id,
			chatId: "chat-1",
			userMessageId: "message-1",
			text: "hello",
		});
		expect(runner.switches).toHaveLength(0);
		expect(result.assistantText).toBe("new:hello");
		expect(result.mapping).toEqual({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "message-1",
			assistantText: "new:hello",
			events: [{ type: "assistant", text: "new:hello" }],
		});
		expect(mappings.entries()).toHaveLength(1);
	});

	test("continues a mapped session after switching and reading state", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const project = createProject();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
			activeLeaf: "leaf-0",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "message-1",
		});

		const result = await routeGjcTurn(
			routeInput(runner, mappings, {
				userMessageId: "message-2",
				parentId: "message-1",
				text: "again",
			}),
		);

		expect(runner.starts).toHaveLength(0);
		expect(runner.switches).toHaveLength(1);
		expect(runner.states).toHaveLength(1);
		expect(runner.continues).toHaveLength(1);
		expect(runner.continues[0]).toMatchObject({
			cwd: project.cwd,
			projectId: project.id,
			sessionId: "session-1",
			chatId: "chat-1",
			userMessageId: "message-2",
			parentId: "message-1",
			activeLeaf: "leaf-1",
			rawFrameCursor: 7,
			eventCursor: 3,
			operationId: "message-2",
		});
		expect(result.assistantText).toBe("continued:again");
		expect(result.mapping).toMatchObject({
			activeLeaf: "leaf-2",
			rawFrameCursor: 12,
			eventCursor: 5,
			operationId: "message-2",
		});
	});

	test("rejects persisted session files outside the project session root", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const project = createProject();
		mappings.set({
			chatId: "chat-1",
			projectId: project.id,
			sessionId: "session-1",
			sessionFile: "/tmp/outside-session.jsonl",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "message-1",
		});

		await expect(
			routeGjcTurn(
				routeInput(runner, mappings, {
					userMessageId: "message-2",
					text: "again",
				}),
			),
		).rejects.toThrow("outside project session root");
		expect(runner.switches).toHaveLength(0);
	});

	test("keeps one mapping and does not rerun duplicate operations", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();

		const first = await routeGjcTurn(routeInput(runner, mappings));
		const duplicate = await routeGjcTurn(routeInput(runner, mappings));

		expect(runner.starts).toHaveLength(1);
		expect(runner.continues).toHaveLength(0);
		expect(mappings.entries()).toHaveLength(1);
		expect(duplicate.mapping).toEqual(first.mapping);
		expect(duplicate.assistantText).toBe("new:hello");
		expect(duplicate.events).toEqual([{ type: "assistant", text: "new:hello" }]);
	});

	test("persists only the normalized selection returned by a successful selected operation", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const requested = selection("anthropic", "requested", "low");
		runner.returnedSelection = selection("anthropic", "normalized", "medium");

		const result = await routeGjcTurn(
			routeInput(runner, mappings, {
				chatId: "chat-selected",
				userMessageId: "message-selected",
				modelSelection: requested,
			}),
		);

		expect(runner.starts[0]?.modelSelection).toEqual(requested);
		expect(result.mapping.modelSelection).toEqual(runner.returnedSelection);
		expect(mappings.get("chat-selected")?.modelSelection).toEqual(runner.returnedSelection);
	});

	test("leaves an existing mapping unchanged when the selected prompt fails", async () => {
		const runner = new FakeGjcTurnRunner();
		const mappings = new SessionMappingStore();
		const originalSelection = selection("anthropic", "bound", "medium");
		mappings.set({
			chatId: "chat-1",
			projectId: "project",
			sessionId: "session-1",
			rawFrameCursor: 2,
			eventCursor: 1,
			operationId: "message-1",
			modelSelection: originalSelection,
		});
		runner.failPrompt = true;

		await expect(
			routeGjcTurn(
				routeInput(runner, mappings, {
					userMessageId: "message-2",
					text: "again",
					modelSelection: selection("openai", "new", "high"),
				}),
			),
		).rejects.toThrow("prompt failed");
		expect(mappings.get("chat-1")).toMatchObject({ operationId: "message-1", modelSelection: originalSelection });
	});
});

function selection(
	provider: string,
	modelId: string,
	thinkingLevel: NormalizedModelSelection["thinkingLevel"],
): NormalizedModelSelection {
	return { provider, modelId, thinkingLevel };
}

function routeInput(
	runner: GjcTurnRunner,
	mappings: SessionMappingStore,
	overrides: Partial<RouteGjcTurnInput> = {},
): RouteGjcTurnInput {
	return {
		project: createProject(),
		chatId: "chat-1",
		userMessageId: "message-1",
		text: "hello",
		runner,
		mappings,
		...overrides,
	};
}

function createProject(): RegisteredProject {
	return {
		id: "project",
		name: "Project",
		cwd: "/workspace/project",
		allowedRoot: "/workspace",
		createdAt: new Date("2026-07-08T00:00:00.000Z"),
	};
}
