import { describe, expect, test } from "bun:test";
import type { NormalizedModelSelection } from "../src/contracts";
import {
	createGjcRpcTurnRunner,
	type GjcContinueSessionInput,
	type GjcRpcRunnerTransport,
	type GjcRpcRunnerTransportEvent,
} from "../src/gjc/rpc-runner";

describe("createGjcRpcTurnRunner session events", () => {
	test("publishes one starting client before await and serializes complete selected turns", async () => {
		const start = Promise.withResolvers<void>();
		const setter = Promise.withResolvers<void>();
		const client = new SelectionTransport({ start: start.promise, setter: setter.promise });
		let created = 0;
		const runner = createGjcRpcTurnRunner({
			clientFactory: () => {
				created += 1;
				return client;
			},
		});
		let reentrantState: Promise<unknown> = Promise.resolve();
		client.onStart = () => {
			reentrantState = runner.getState(turnAddress);
		};
		const first = runner.continueSession(turnInput(firstSelection, "first"));
		const second = runner.continueSession(turnInput(secondSelection, "second"));
		await Promise.resolve();
		expect(created).toBe(1);
		expect(client.calls).toEqual(["start"]);
		start.resolve();
		await until(() => client.calls.includes("set:anthropic:claude-sonnet-4:medium"));
		expect(client.calls).toEqual(["start", "state", "set:anthropic:claude-sonnet-4:medium"]);
		setter.resolve();
		const [, ...results] = await Promise.all([reentrantState, first, second]);
		expect(results.map(result => result.modelSelection)).toEqual([firstSelection, secondSelection]);
		expect(client.calls).toEqual([
			"start",
			"state",
			"set:anthropic:claude-sonnet-4:medium",
			"prompt:first",
			"state",
			"text",
			"state",
			"state",
			"set:openai:gpt-5:high",
			"prompt:second",
			"state",
			"text",
		]);
	});

	test("does not prompt or return a successful outcome after setter or prompt failure", async () => {
		const setterFailure = new SelectionTransport({ fail: "set" });
		const promptFailure = new SelectionTransport({ fail: "prompt" });
		const setterPromise = createGjcRpcTurnRunner({ clientFactory: () => setterFailure }).continueSession(
			turnInput(firstSelection, "setter failure"),
		);
		await expect(setterPromise).rejects.toThrow("set_default_model_selection");
		const promptPromise = createGjcRpcTurnRunner({ clientFactory: () => promptFailure }).continueSession(
			turnInput(firstSelection, "prompt failure"),
		);
		await expect(promptPromise).rejects.toThrow("GJC RPC prompt failed");
		expect(setterFailure.calls).toEqual(["start", "state", "set:anthropic:claude-sonnet-4:medium"]);
		expect(promptFailure.calls).toEqual([
			"start",
			"state",
			"set:anthropic:claude-sonnet-4:medium",
			"prompt:prompt failure",
		]);
	});

	test("reads refreshed gate state after response without applying a model selection", async () => {
		const client = new SelectionTransport({});
		const runner = createGjcRpcTurnRunner({ clientFactory: () => client });
		expect([await runner.getAvailableModels?.(turnAddress), ...client.calls]).toEqual([[], "start", "models"]);
		await runner.respondWorkflowGate?.({
			...turnAddress,
			gateId: "wg_fixture_ralplan_000001",
			answer: true,
			idempotencyKey: "fixture-key",
			userMessageId: "message-gate",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "message-gate",
		});
		expect(client.calls).toEqual([
			"start",
			"models",
			"switch:undefined",
			"gate:wg_fixture_ralplan_000001",
			"state",
			"text",
		]);
	});
});

const firstSelection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "medium" } as const;
const secondSelection = { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" } as const;
const turnAddress = {
	cwd: "/workspace/project",
	sessionRoot: "/workspace/project/.gjc/sessions",
	projectId: "project",
	sessionId: "session-1",
	chatId: "chat-1",
} as const;

function turnInput(modelSelection: NormalizedModelSelection, text: string): GjcContinueSessionInput {
	return {
		...turnAddress,
		userMessageId: text,
		text,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: text,
		modelSelection,
	};
}

class SelectionTransport implements GjcRpcRunnerTransport {
	readonly calls: string[] = [];
	onStart: (() => void) | undefined;
	readonly #start: Promise<void>;
	readonly #setter: Promise<void>;
	readonly #fail: "set" | "prompt" | undefined;

	constructor(input: {
		readonly start?: Promise<void>;
		readonly setter?: Promise<void>;
		readonly fail?: "set" | "prompt";
	}) {
		this.#start = input.start ?? Promise.resolve();
		this.#setter = input.setter ?? Promise.resolve();
		this.#fail = input.fail;
	}
	async start(): Promise<void> {
		this.calls.push("start");
		this.onStart?.();
		await this.#start;
	}
	stop(): void {
		this.calls.push("stop");
	}
	async newSession() {
		this.calls.push("new");
		return { cancelled: false };
	}
	async switchSession(path: string) {
		this.calls.push(`switch:${path}`);
		return { cancelled: false };
	}
	async getState() {
		this.calls.push("state");
		return { sessionId: "session-1", rawFrameCursor: 0, eventCursor: 0 };
	}
	async getAvailableModels(): Promise<readonly unknown[]> {
		this.calls.push("models");
		return [];
	}
	async setDefaultModelSelection(
		provider: string,
		modelId: string,
		thinkingLevel: NormalizedModelSelection["thinkingLevel"],
	): Promise<NormalizedModelSelection> {
		this.calls.push(`set:${provider}:${modelId}:${thinkingLevel}`);
		if (this.#fail === "set") throw new Error("fixture setter failure");
		await this.#setter;
		return { provider, modelId, thinkingLevel };
	}
	async promptAndWait(message: string): Promise<readonly GjcRpcRunnerTransportEvent[]> {
		this.calls.push(`prompt:${message}`);
		if (this.#fail === "prompt") throw new Error("fixture prompt failure");
		return [{ type: "agent_end" }];
	}
	onWorkflowGate(): () => void {
		return () => undefined;
	}
	async respondGate(gateId: string): Promise<unknown> {
		this.calls.push(`gate:${gateId}`);
		return {
			gate_id: gateId,
			status: "accepted",
			answer_hash: "1111111111111111111111111111111111111111111111111111111111111111",
			resolved_at: "2026-01-01T00:00:01.000Z",
		};
	}
	async getLastAssistantText(): Promise<string> {
		this.calls.push("text");
		return "fixture assistant";
	}
}

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("fixture condition was not reached");
}
