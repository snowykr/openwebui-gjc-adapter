import { describe, expect, test } from "bun:test";
import type { ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
import type { ManagedTurnAuthority } from "../src/gjc/turn-runner";
import { createManagedGjcTurnRunner } from "../src/live/gjc-managed-turn-runner";

const authority: ManagedTurnAuthority = {
	principalId: "principal-1",
	projectId: "project-1",
	canonicalWorkspace: "/workspace/project-1",
	chatId: "chat-1",
	sessionId: "session-1",
	generation: 3,
	leaseId: "lease-1",
	epoch: "epoch-1",
	requestKey: "request-1",
};

describe("unwired managed turn runner", () => {
	test("creates through external lifecycle adoption and streams ordered public Router frames before request settlement", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		const observed: string[] = [];
		const result = await runner.create({
			authority: withoutIdentity(),
			cwd: authority.canonicalWorkspace,
			sessionRoot: "/sessions",
			projectId: authority.projectId,
			chatId: authority.chatId,
			userMessageId: "message-1",
			text: "hello",
			lifecycleTarget: { path: authority.canonicalWorkspace },
			observer: event => {
				observed.push(event.type);
			},
		});
		expect(result.text).toBe("done");
		expect(result.events.map(event => event.id)).toEqual(["a", "b"]);
		expect(result.rawFrameCursor).toBe(2);
		expect(observed).toEqual(["message_update", "agent_end"]);
		expect(fake.externalLifecycle).toHaveLength(1);
		expect(fake.registered).toHaveLength(1);
		expect(fake.subscriptionCountAtRequest).toEqual([1]);
		expect(fake.unsubscribed).toBe(1);
		expect(JSON.stringify(fake)).not.toMatch(/token|credential|password/i);
	});

	test("continues, answers an explicitly correlated gate, sends public terminal cancellation, and has no session switch", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await runner.continue({
			...address(),
			authority,
			userMessageId: "message-2",
			text: "follow up",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "op-2",
		});
		await runner.gate({
			...address(),
			authority,
			gateId: "gate-1",
			answer: { approved: true },
			promptText: "approve",
			userMessageId: "message-3",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "op-3",
			gateCorrelation: { sessionId: authority.sessionId, commandId: "gate-command", turnId: "gate-turn" },
		});
		await runner.cancel({
			authority,
			projectId: authority.projectId,
			chatId: authority.chatId,
			sessionId: authority.sessionId,
		});
		expect(fake.requests.map(frame => frame.operation)).toEqual([
			"turn.follow_up",
			"workflow.gate_answer",
			"turn.abort",
		]);
		expect(fake.subscriptionHistory[1]?.correlation).toEqual({
			commandId: "command-1",
			turnId: "turn-1",
		});
		expect(fake.subscriptionCountAtRequest).toEqual([1, 1, 0]);
		expect("switch" in runner).toBeFalse();
	});

	test("requires exact retirement for close and performs pre-prompt cleanup once after failure", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		fake.status = "retired";
		await runner.closePreflight({ authority, target: { sessionId: authority.sessionId } });
		expect(fake.closeCalls).toBe(1);
		fake.failPrompt = true;
		await expect(
			runner.create({
				authority: withoutIdentity(),
				cwd: authority.canonicalWorkspace,
				sessionRoot: "/sessions",
				projectId: authority.projectId,
				chatId: authority.chatId,
				userMessageId: "message-4",
				text: "fail",
				lifecycleTarget: { path: authority.canonicalWorkspace },
			}),
		).rejects.toThrow("prompt failure");
		expect(fake.closeCalls).toBe(2);
		fake.status = "replaced";
		await expect(runner.closePreflight({ authority, target: { sessionId: authority.sessionId } })).rejects.toThrow(
			"retirement",
		);
	});
});

function withoutIdentity(): Omit<ManagedTurnAuthority, "sessionId" | "generation"> {
	const { sessionId: _sessionId, generation: _generation, ...value } = authority;
	return value;
}
function address() {
	return {
		cwd: authority.canonicalWorkspace,
		sessionRoot: "/sessions",
		projectId: authority.projectId,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		lifecycle: {} as never,
	};
}

class RunnerRuntime {
	readonly attachment = { isCurrent: () => true };
	readonly requests: Record<string, unknown>[] = [];
	readonly subscriptions: { correlation: Record<string, unknown>; listener: (frame: unknown) => Promise<void> }[] = [];
	readonly subscriptionHistory: {
		correlation: Record<string, unknown>;
		listener: (frame: unknown) => Promise<void>;
	}[] = [];
	readonly externalLifecycle: Record<string, unknown>[] = [];
	readonly registered: unknown[] = [];
	readonly subscriptionCountAtRequest: number[] = [];
	status: "retired" | "current" | "replaced" = "current";
	unsubscribed = 0;
	closeCalls = 0;
	failPrompt = false;
	readonly lifecycleService = {
		createExternal: (request: Record<string, unknown>) => this.createExternalLifecycleSession(request),
		resumeExternal: (request: Record<string, unknown>) => this.resumeExternalLifecycleSession(request),
	};
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {}
	async acquireAttachment(key: unknown) {
		return { tenant: key, generation: authority.generation, attachment: this.attachment };
	}
	async registerLifecycleTenant(key: unknown, outcome: unknown) {
		this.registered.push({ key, outcome });
		return { tenant: key, generation: authority.generation, attachment: this.attachment };
	}
	async createExternalLifecycleSession(request: Record<string, unknown>) {
		this.externalLifecycle.push(request);
		return lifecycleSuccess();
	}
	async resumeExternalLifecycleSession(_request: Record<string, unknown>) {
		return { kind: "result", outcome: lifecycleSuccess() };
	}
	async request(_attachment: unknown, frame: Record<string, unknown>, options?: { onDispatch?: () => void }) {
		this.subscriptionCountAtRequest.push(this.subscriptions.length);
		this.requests.push(frame);
		if (frame.operation === "turn.prompt" && this.failPrompt) throw new Error("prompt failure");
		options?.onDispatch?.();
		if (
			frame.operation === "turn.prompt" ||
			frame.operation === "turn.follow_up" ||
			frame.operation === "workflow.gate_answer"
		) {
			const active = this.subscriptions.at(-1);
			if (active === undefined) throw new Error("managed frame subscription must precede request");
			await active.listener(routerFrame({ type: "message_update", id: "a", text: "done" }, 1));
			await active.listener(routerFrame({ type: "message_update", id: "a", text: "done" }, 1));
			await active.listener(routerFrame({ type: "agent_end", id: "b" }, 2));
		}
		return {
			type: "control_response",
			ok: true as const,
			result: { commandId: "command-1", turnId: "turn-1", finalizedAssistantText: "done" },
		};
	}
	subscribeFrames(
		_attachment: unknown,
		_operation: string,
		correlation: Record<string, unknown>,
		listener: (frame: unknown) => Promise<void>,
	) {
		const subscription = { correlation, listener };
		this.subscriptions.push(subscription);
		this.subscriptionHistory.push(subscription);
		const unsubscribe = (() => {
			this.unsubscribed += 1;
			this.subscriptions.splice(
				this.subscriptions.findIndex(item => item.listener === listener),
				1,
			);
		}) as (() => void) & { drain(): Promise<void> };
		unsubscribe.drain = async () => undefined;
		return unsubscribe;
	}
	prepareFrameSubscription(_attachment: unknown, operation: string, listener: (frame: unknown) => Promise<void>) {
		const subscription = { correlation: {}, listener };
		this.subscriptions.push(subscription);
		this.subscriptionHistory.push(subscription);
		const unsubscribe = (() => {
			this.unsubscribed += 1;
			this.subscriptions.splice(
				this.subscriptions.findIndex(item => item.listener === listener),
				1,
			);
		}) as (() => void) & { bind(correlation: Record<string, unknown>): void; drain(): Promise<void> };
		unsubscribe.bind = correlation => {
			subscription.correlation = correlation;
		};
		unsubscribe.drain = async () => undefined;
		void operation;
		return unsubscribe;
	}
	async generationStatus() {
		return { status: this.status };
	}
	async forkLifecycleSession() {
		return lifecycleSuccess();
	}
	async closeLifecycleSession() {
		this.closeCalls += 1;
		return lifecycleSuccess();
	}
	async deleteLifecycleSession() {
		return lifecycleSuccess();
	}
	async listLifecycleSessions() {
		return { ok: true, result: { sessions: [] } };
	}
}

function lifecycleSuccess() {
	return { ok: true as const, result: { sessionId: authority.sessionId, endpointGeneration: authority.generation } };
}
function routerFrame(body: Record<string, unknown>, seq: number) {
	return {
		frame: {
			body,
			sessionId: authority.sessionId,
			generation: authority.generation,
			commandId: "command-1",
			turnId: "turn-1",
			seq,
		},
	};
}
