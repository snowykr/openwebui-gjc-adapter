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
	test("creates, prompts, preserves ordered unique managed frames, and projects finalized text", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		const observed: string[] = [];
		const result = await runner.create({
			authority,
			cwd: authority.canonicalWorkspace,
			sessionRoot: "/sessions",
			projectId: authority.projectId,
			chatId: authority.chatId,
			userMessageId: "message-1",
			text: "hello",
			lifecycleTarget: { cwd: authority.canonicalWorkspace },
			observer: event => {
				observed.push(event.type);
			},
		});
		expect(result.text).toBe("done");
		expect(result.events.map(event => event.id)).toEqual(["a", "b"]);
		expect(observed).toEqual(["message_update", "agent_end"]);
		expect(fake.subscriptions).toHaveLength(1);
		expect(fake.unsubscribed).toBe(1);
		expect(JSON.stringify(fake)).not.toMatch(/token|credential|password/i);
	});

	test("continues, answers a correlated gate, controls terminal cancellation, and has no session.switch", async () => {
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
		expect(fake.subscriptions[1]?.correlation).toEqual({
			commandId: "gate-command",
			turnId: "gate-turn",
			sessionId: authority.sessionId,
		});
		expect("switch" in runner).toBeFalse();
	});

	test("closes an exact generation only when retirement is proven and cleans a pre-prompt failure exactly once", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		fake.status = "retired";
		await runner.closePreflight({ authority, target: { sessionId: authority.sessionId } });
		expect(fake.closeCalls).toBe(1);
		fake.failPrompt = true;
		await expect(
			runner.create({
				authority,
				cwd: authority.canonicalWorkspace,
				sessionRoot: "/sessions",
				projectId: authority.projectId,
				chatId: authority.chatId,
				userMessageId: "message-4",
				text: "fail",
				lifecycleTarget: { cwd: authority.canonicalWorkspace },
			}),
		).rejects.toThrow("prompt failure");
		expect(fake.closeCalls).toBe(2);
		fake.status = "replaced";
		await expect(runner.closePreflight({ authority, target: { sessionId: authority.sessionId } })).rejects.toThrow(
			"retirement",
		);
	});
});

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
	readonly subscriptions: { correlation: Record<string, unknown> }[] = [];
	status: "retired" | "current" | "replaced" = "current";
	unsubscribed = 0;
	closeCalls = 0;
	failPrompt = false;
	readonly lifecycleService = {
		createExternal: async () => ({ ok: true }),
		resumeExternal: async () => ({ kind: "result", outcome: { ok: true } }),
	};
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {}
	async acquireAttachment(key: unknown) {
		return { tenant: key, generation: authority.generation, attachment: this.attachment };
	}
	async request(_attachment: unknown, frame: Record<string, unknown>) {
		this.requests.push(frame);
		if (frame.operation === "turn.prompt" && this.failPrompt) throw new Error("prompt failure");
		return { commandId: "command-1", turnId: "turn-1", finalizedAssistantText: "done" };
	}
	subscribeFrames(
		_attachment: unknown,
		_operation: string,
		correlation: Record<string, unknown>,
		listener: (frame: unknown) => Promise<void>,
	) {
		this.subscriptions.push({ correlation });
		void listener({ frame: { type: "message_update", id: "a", text: "done" } });
		void listener({ frame: { type: "message_update", id: "a", text: "done" } });
		void listener({ frame: { type: "agent_end", id: "b" } });
		return () => {
			this.unsubscribed += 1;
		};
	}
	async generationStatus() {
		return { status: this.status };
	}
	async forkLifecycleSession() {
		return { ok: true };
	}
	async closeLifecycleSession() {
		this.closeCalls += 1;
		return { ok: true };
	}
	async deleteLifecycleSession() {
		return { ok: true };
	}
	async listLifecycleSessions() {
		return { ok: true, result: { sessions: [] } };
	}
}
