import { describe, expect, test } from "bun:test";
import { SessionMappingStore } from "../src/gjc/session-router";
import {
	GjcTurnCancelledError,
	type GjcControlResult,
	type GjcLifecyclePublicationAddress,
	type GjcLifecycleTransaction,
	type GjcTurnRunner,
} from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { attachmentProof } from "./gjc-lifecycle-fixtures";
import { FakeGjcTurnRunner, project } from "./gjc-routing-runner-fixtures";

const controlTurn = (userMessageId: string): LiveGatewayRunnerInput => ({
	project,
	prompt: "proceed",
	chatId: "chat-control",
	messageId: `assistant-${userMessageId}`,
	userMessageId,
	userMessageParentId: "prior",
	continued: true,
	control: { operation: "action_reply", actionId: "action-1", answer: "proceed" },
});

const controlEvent = { type: "tool_start", id: "tool-1" } as const;

class ControlTurnRunner extends FakeGjcTurnRunner {
	readonly calls: LiveGatewayRunnerInput[] = [];

	async runControl(
		input: LiveGatewayRunnerInput,
		_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
		_lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
		_onAcknowledgedSuccessor?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[3],
		onDispatch?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[4],
	): Promise<GjcControlResult> {
		this.calls.push(input);
		onDispatch?.();
		return {
			result: {
				text: "control done",
				events: [controlEvent],
				sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
				activeLeaf: "leaf-1",
				rawFrameCursor: 1,
				eventCursor: 1,
				attachment: attachmentProof({ cwd: project.cwd, sessionId: "session-1" }),
			},
		};
	}
}

class PreDispatchCancellationControlRunner extends ControlTurnRunner {
	#first = true;

	constructor(private readonly cancelBeforeDispatch: () => void) {
		super();
	}

	async runControl(
		input: LiveGatewayRunnerInput,
		_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
		_lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
		_onAcknowledgedSuccessor?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[3],
		onDispatch?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[4],
	): Promise<GjcControlResult> {
		if (this.#first) {
			this.#first = false;
			this.calls.push(input);
			this.cancelBeforeDispatch();
			throw new GjcTurnCancelledError();
		}
		return await super.runControl(input, _mapping, _lifecycle, _onAcknowledgedSuccessor, onDispatch);
	}
}

class DispatchedErrorControlRunner extends ControlTurnRunner {
	async runControl(
		input: LiveGatewayRunnerInput,
		_mapping: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[1],
		_lifecycle: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[2],
		_onAcknowledgedSuccessor?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[3],
		onDispatch?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[4],
	): Promise<GjcControlResult> {
		this.calls.push(input);
		onDispatch?.();
		throw new Error("control failed after dispatch");
	}
}

class CancelledReplayControlRunner extends ControlTurnRunner {
	constructor(private readonly cancelBeforeEffect: () => void) {
		super();
	}

	async withLifecyclePublication<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T> {
		return await super.withLifecyclePublication(address, async lifecycle => {
			this.cancelBeforeEffect();
			return await effect(lifecycle);
		});
	}
}

function seedMapping(mappings: SessionMappingStore): void {
	mappings.set({
		chatId: "chat-control",
		projectId: project.id,
		sessionId: "session-1",
		sessionFile: "/workspace/project/.gjc/sessions/session-1.jsonl",
		activeLeaf: "leaf-1",
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "prior",
		modelSelection: { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "medium" },
	});
}

function rowIdentity(outbox: InMemoryOutboxStore): Array<readonly [string, string]> {
	return outbox.listPending().map(row => [row.operationId, row.payloadHash] as const);
}

describe("control operation replay", () => {
	test("replays a current completed control op with record-mapping rows and projected events", async () => {
		const mappings = new SessionMappingStore();
		seedMapping(mappings);
		const outbox = new InMemoryOutboxStore();
		const turnRunner = new ControlTurnRunner();
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox });

		const completed = await gateway.run(controlTurn("control-1"));
		expect(completed.content).toBe("control done");
		expect(completed.events).toHaveLength(1);
		expect(outbox.listPending()).toHaveLength(2);
		const rowsAtCompletion = rowIdentity(outbox);

		const replayed = await gateway.run(controlTurn("control-1"));

		expect(replayed.content).toBe("control done");
		expect(replayed.events).toEqual(completed.events);
		expect(turnRunner.calls).toHaveLength(1);
		expect(rowIdentity(outbox)).toEqual(rowsAtCompletion);
	});
	test("replays a superseded completed control op without re-enqueueing rows", async () => {
		const mappings = new SessionMappingStore();
		seedMapping(mappings);
		const outbox = new InMemoryOutboxStore();
		const turnRunner = new ControlTurnRunner();
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox });

		await gateway.run(controlTurn("control-1"));
		const { control: _control, ...regularTurn } = controlTurn("control-2");
		await gateway.run({ ...regularTurn, prompt: "follow-up" });
		expect(mappings.get("chat-control")?.operationId).toBe("control-2");
		const rowsAfterRegularTurn = rowIdentity(outbox);

		const replayed = await gateway.run(controlTurn("control-1"));

		expect(replayed.content).toBe("control done");
		expect(turnRunner.calls).toHaveLength(1);
		expect(turnRunner.continues).toHaveLength(1);
		expect(rowIdentity(outbox)).toEqual(rowsAfterRegularTurn);
	});
	test("rejects a completed control replay cancelled after lifecycle reattachment", async () => {
		const mappings = new SessionMappingStore();
		seedMapping(mappings);
		const outbox = new InMemoryOutboxStore();
		const userMessageId = "control-replay-cancelled";
		const first = createGjcRoutingLiveGatewayRunner({
			turnRunner: new ControlTurnRunner(),
			mappings,
			outbox,
		});
		await first.run(controlTurn(userMessageId));
		const rowsAtCompletion = rowIdentity(outbox);

		const controller = new AbortController();
		const replayRunner = new CancelledReplayControlRunner(() => controller.abort());
		const replay = createGjcRoutingLiveGatewayRunner({ turnRunner: replayRunner, mappings, outbox });

		await expect(replay.run({ ...controlTurn(userMessageId), signal: controller.signal })).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		expect(replayRunner.calls).toHaveLength(0);
		expect(rowIdentity(outbox)).toEqual(rowsAtCompletion);
	});
	test("cleans up a pre-aborted control so the same operation ID can retry", async () => {
		const mappings = new SessionMappingStore();
		seedMapping(mappings);
		const turnRunner = new ControlTurnRunner();
		const cancellations: unknown[] = [];
		const cleared: unknown[] = [];
		turnRunner.cancelTurn = cancellation => cancellations.push(cancellation);
		Object.assign(turnRunner, {
			clearTurnCancellation: (cancellation: unknown) => cleared.push(cancellation),
		});
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const userMessageId = "control-pre-aborted";
		const aborted = new AbortController();
		aborted.abort();

		await expect(gateway.run({ ...controlTurn(userMessageId), signal: aborted.signal })).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		const cancellation = {
			projectId: project.id,
			chatId: "chat-control",
			sessionId: "session-1",
			operationId: userMessageId,
		};
		expect(cancellations).toEqual([cancellation]);
		expect(cleared).toEqual([cancellation]);
		expect(turnRunner.calls).toHaveLength(0);
		expect(mappings.operation("chat-control", userMessageId)).toBeUndefined();

		const retry = new AbortController();
		await expect(gateway.run({ ...controlTurn(userMessageId), signal: retry.signal })).resolves.toMatchObject({
			content: "control done",
		});
		expect(turnRunner.calls).toHaveLength(1);
		expect(mappings.operation("chat-control", userMessageId)).toMatchObject({ state: "complete" });
		expect(cleared).toHaveLength(2);
	});
	test("discards a control cancelled after begin but before SDK dispatch so the same ID can retry", async () => {
		const mappings = new SessionMappingStore();
		seedMapping(mappings);
		const controller = new AbortController();
		const turnRunner = new PreDispatchCancellationControlRunner(() => controller.abort());
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const userMessageId = "control-dispatch-cancelled";

		await expect(gateway.run({ ...controlTurn(userMessageId), signal: controller.signal })).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		expect(mappings.operation("chat-control", userMessageId)).toBeUndefined();

		await expect(gateway.run(controlTurn(userMessageId))).resolves.toMatchObject({ content: "control done" });
		expect(mappings.operation("chat-control", userMessageId)).toMatchObject({ state: "complete" });
	});
	test("retains uncertain control authority when an SDK dispatch was acknowledged before an error", async () => {
		const mappings = new SessionMappingStore();
		seedMapping(mappings);
		const turnRunner = new DispatchedErrorControlRunner();
		const gateway = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const userMessageId = "control-dispatched-error";

		await expect(gateway.run(controlTurn(userMessageId))).rejects.toThrow("control failed after dispatch");
		expect(mappings.operation("chat-control", userMessageId)).toMatchObject({
			state: "uncertain",
			id: userMessageId,
		});
	});
});
