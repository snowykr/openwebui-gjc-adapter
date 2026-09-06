import { describe, expect, test } from "bun:test";
import type { NormalizedModelSelection } from "../src/contracts";
import type { ManagedSdkAttachment, ManagedSdkRuntime, TenantSessionKey } from "../src/gjc/managed-sdk-runtime";
import type { ManagedPreparedTurnAuthority, ManagedTurnAuthority } from "../src/gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "../src/live/chat-completions";
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
const modelSelection: NormalizedModelSelection = {
	provider: "openai",
	modelId: "gpt-5",
	thinkingLevel: "high",
};

describe("managed turn runner", () => {
	test("requires complete managed authority for lifecycle invocation", async () => {
		const fake = new RunnerRuntime();
		await expect(
			fake.createExternalLifecycleSession({
				actor: { id: authority.principalId, namespace: "adapter" },
				capability: "session.create",
				requestKey: authority.requestKey,
				target: { cwd: authority.canonicalWorkspace },
			}),
		).rejects.toThrow("Complete managed tenant authority");
		await fake.createExternalLifecycleSession(authority, {
			actor: { id: authority.principalId, namespace: "adapter" },
			capability: "session.create",
			requestKey: authority.requestKey,
			target: { cwd: authority.canonicalWorkspace },
		});
		expect(fake.externalLifecycle).toHaveLength(1);
	});

	test("publishes only an exact bound managed generation and rejects unbound or stale evidence", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		let writes = 0;
		await runner.withLifecyclePublication(address(), async lifecycle => {
			await expect(
				lifecycle.publishManaged!(
					{
						kind: "managed-generation",
						sessionId: authority.sessionId,
						generation: authority.generation,
						leaseId: authority.leaseId,
						epoch: authority.epoch,
					},
					() => {
						writes += 1;
					},
				),
			).rejects.toThrow("complete bound authority");
			await runner.getState({ ...address(), lifecycle, managedAuthority: authority });
			await expect(
				lifecycle.publishManaged!(
					{
						kind: "managed-generation",
						sessionId: authority.sessionId,
						generation: authority.generation - 1,
						leaseId: authority.leaseId,
						epoch: authority.epoch,
					},
					() => {
						writes += 1;
					},
				),
			).rejects.toThrow("proof changed");
			await expect(
				lifecycle.publishManaged!(
					{
						kind: "managed-generation",
						sessionId: authority.sessionId,
						generation: authority.generation,
						leaseId: "lease-stale",
						epoch: authority.epoch,
					},
					() => {
						writes += 1;
					},
				),
			).rejects.toThrow("proof changed");
			await expect(
				lifecycle.publishManaged!(
					{
						kind: "managed-generation",
						sessionId: authority.sessionId,
						generation: authority.generation,
						leaseId: authority.leaseId,
						epoch: "epoch-stale",
					},
					() => {
						writes += 1;
					},
				),
			).rejects.toThrow("proof changed");
			await expect(
				lifecycle.publishManaged!(
					{
						kind: "managed-generation",
						sessionId: authority.sessionId,
						generation: authority.generation,
						leaseId: authority.leaseId,
						epoch: authority.epoch,
					},
					() => {
						writes += 1;
						return "published";
					},
				),
			).resolves.toBe("published");
		});
		expect(writes).toBe(1);
	});

	test("creates through external lifecycle adoption and replays ordered public Router frames after acknowledgement binding", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		const observed: string[] = [];
		const result = await runner.create({
			preparedManagedAuthority: withoutIdentity(),
			cwd: authority.canonicalWorkspace,
			sessionRoot: "/sessions",
			projectId: authority.projectId,
			chatId: authority.chatId,
			userMessageId: "message-1",
			text: "hello",
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
		expect(JSON.stringify(fake)).not.toMatch(/credential|password|endpointIncarnation/i);
	});

	test("continues, answers an explicitly correlated gate, and sends public terminal cancellation", async () => {
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

	test("returns the ordered managed turn outcome for abort-and-prompt", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		const result = await runner.runControl!(managedAbortAndPromptInput(), managedControlMapping(), {} as never);
		expect(result.result).toMatchObject({
			text: "done",
			rawFrameCursor: 2,
			eventCursor: 2,
			managedAuthority: authority,
			managedProof: {
				kind: "managed-generation",
				sessionId: authority.sessionId,
				generation: authority.generation,
			},
		});
		expect(result.result?.events.map(event => event.id)).toEqual(["a", "b"]);
		expect(fake.requests.map(frame => frame.operation)).toEqual(["turn.abort_and_prompt"]);
		expect(fake.subscriptionCountAtRequest).toEqual([1]);
		expect(fake.unsubscribed).toBe(1);
	});

	test("fails closed on managed abort-and-prompt cancellation or failure", async () => {
		const cancelled = new RunnerRuntime();
		const cancellation = new AbortController();
		cancellation.abort();
		const cancelledRunner = createManagedGjcTurnRunner(cancelled.runtime);
		await expect(
			cancelledRunner.runControl!(
				managedAbortAndPromptInput(cancellation.signal),
				managedControlMapping(),
				{} as never,
			),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(cancelled.requests).toHaveLength(0);

		const failed = new RunnerRuntime();
		failed.failAbortAndPrompt = true;
		const failedRunner = createManagedGjcTurnRunner(failed.runtime);
		await expect(
			failedRunner.runControl!(managedAbortAndPromptInput(), managedControlMapping(), {} as never),
		).rejects.toThrow("abort-and-prompt failure");
		expect(failed.requests.map(frame => frame.operation)).toEqual(["turn.abort_and_prompt"]);
		expect(failed.unsubscribed).toBe(1);
	});

	test("propagates managed frame listener failures instead of swallowing them", async () => {
		const fake = new RunnerRuntime();
		fake.status = "retired";
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await expect(
			runner.create({
				preparedManagedAuthority: withoutIdentity(),
				cwd: authority.canonicalWorkspace,
				sessionRoot: "/sessions",
				projectId: authority.projectId,
				chatId: authority.chatId,
				userMessageId: "message-listener-error",
				text: "listener error",
				observer: () => {
					throw new Error("managed listener failed");
				},
			}),
		).rejects.toThrow("managed listener failed");
		expect(fake.unsubscribed).toBe(1);
	});

	test("cancels a dispatched managed abort-and-prompt before exposing a result", async () => {
		const fake = new RunnerRuntime();
		const cancellation = new AbortController();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await expect(
			runner.runControl!(
				managedAbortAndPromptInput(cancellation.signal),
				managedControlMapping(),
				{} as never,
				undefined,
				() => cancellation.abort(),
			),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(fake.requests.map(frame => frame.operation)).toEqual(["turn.abort_and_prompt", "turn.abort"]);
		expect(fake.unsubscribed).toBe(1);
	});

	test("applies model then thinking selection setters before create and continue dispatch", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await runner.create({
			preparedManagedAuthority: withoutIdentity(),
			cwd: authority.canonicalWorkspace,
			sessionRoot: "/sessions",
			projectId: authority.projectId,
			chatId: authority.chatId,
			userMessageId: "message-selection-create",
			text: "select on create",
			modelSelection,
		});
		expect(fake.requests.map(frame => frame.operation)).toEqual(["model.set", "thinking.set", "turn.prompt"]);
		expect(fake.requests[0]?.input).toEqual({ id: "openai/gpt-5", thinkingLevel: "high" });
		expect(fake.requests[1]?.input).toEqual({ level: "high" });

		fake.requests.length = 0;
		const result = await runner.continue({
			...address(),
			authority,
			userMessageId: "message-selection-continue",
			text: "select on continue",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "op-selection-continue",
			modelSelection,
		});
		expect(fake.requests.map(frame => frame.operation)).toEqual(["model.set", "thinking.set", "turn.follow_up"]);
		expect(result.modelSelection).toEqual(modelSelection);
	});

	test("surfaces setter failure without dispatching a prompt", async () => {
		const fake = new RunnerRuntime();
		fake.setterFailure = "thinking.set";
		fake.status = "retired";
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await expect(
			runner.create({
				preparedManagedAuthority: withoutIdentity(),
				cwd: authority.canonicalWorkspace,
				sessionRoot: "/sessions",
				projectId: authority.projectId,
				chatId: authority.chatId,
				userMessageId: "message-selection-failure",
				text: "setter failure",
				modelSelection,
			}),
		).rejects.toMatchObject({ code: "thinking_set_failed" });
		expect(fake.requests.map(frame => frame.operation)).toEqual(["model.set", "thinking.set"]);
		expect(fake.closeCalls).toBe(1);
	});

	test("rejects malformed or mismatched model setter state before thinking or prompt", async () => {
		for (const modelSetResult of [
			{ ...modelSelection, provider: "other" },
			{ ...modelSelection, extra: true },
		] as const) {
			const fake = new RunnerRuntime();
			fake.modelSetResult = modelSetResult;
			const runner = createManagedGjcTurnRunner(fake.runtime);
			await expect(
				runner.continue({
					...address(),
					authority,
					userMessageId: "message-selection-mismatch",
					text: "mismatched selection",
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "op-selection-mismatch",
					modelSelection,
				}),
			).rejects.toMatchObject({ code: "invalid_result" });
			expect(fake.requests.map(frame => frame.operation)).toEqual(["model.set"]);
		}
	});

	test("rejects malformed thinking acknowledgements without dispatching a prompt", async () => {
		for (const thinkingSetResult of [
			{},
			{ changed: false },
			{ changed: "true" },
			{ changed: 1 },
			{ changed: true, extra: true },
			{ provider: "openai", modelId: "gpt-5" },
			{ ...modelSelection, thinkingLevel: "low" },
			{ ...modelSelection, extra: true },
			{ changed: true, ...modelSelection },
		] as const) {
			const fake = new RunnerRuntime();
			fake.thinkingSetResult = thinkingSetResult;
			await expect(
				createManagedGjcTurnRunner(fake.runtime).continue({
					...address(),
					authority,
					userMessageId: "thinking-invalid",
					text: "invalid",
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "thinking-invalid",
					modelSelection,
				}),
			).rejects.toMatchObject({ code: "invalid_result" });
			expect(fake.requests.map(frame => frame.operation)).toEqual(["model.set", "thinking.set"]);
			expect(fake.subscriptions).toHaveLength(0);
		}
	});

	test("accepts an exact normalized selection from thinking.set as well as changed:true", async () => {
		const fake = new RunnerRuntime();
		fake.thinkingSetResult = { ...modelSelection };
		const result = await createManagedGjcTurnRunner(fake.runtime).continue({
			...address(),
			authority,
			userMessageId: "thinking-selection",
			text: "selected",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "thinking-selection",
			modelSelection,
		});
		expect(result.modelSelection).toEqual(modelSelection);
		expect(result.text).toBe("done");
		expect(fake.requests.map(frame => frame.operation)).toEqual(["model.set", "thinking.set", "turn.follow_up"]);
	});

	test("does not return the acknowledged runner result before its delayed public terminal", async () => {
		const fake = new RunnerRuntime();
		fake.delayTerminal = true;
		const observed = deferred<void>();
		const turn = createManagedGjcTurnRunner(fake.runtime).continue({
			...address(),
			authority,
			userMessageId: "delayed-terminal",
			text: "hello",
			rawFrameCursor: 0,
			eventCursor: 0,
			operationId: "delayed-terminal",
			observer: () => {
				observed.resolve();
			},
		});
		await observed.promise;
		let settled = false;
		void turn.then(() => {
			settled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		await fake.subscriptions[0]!.listener(
			routerFrame({ type: "agent_end", id: "b", finalText: "authoritative delayed" }, 2),
		);
		await expect(turn).resolves.toMatchObject({ text: "authoritative delayed", rawFrameCursor: 2 });
		expect(fake.unsubscribed).toBe(1);
	});

	test("follow_up control waits for correlated terminal and retains text and events", async () => {
		const fake = new RunnerRuntime();
		fake.delayTerminal = true;
		const runner = createManagedGjcTurnRunner(fake.runtime, 1_000);
		const control = {
			...managedAbortAndPromptInput(),
			control: { operation: "follow_up" as const, text: "follow-up text" },
		};
		const turn = runner.runControl!(control, managedControlMapping(), {} as never);
		let settled = false;
		void turn.then(() => {
			settled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(fake.requests.at(-1)).toMatchObject({ operation: "turn.follow_up", input: { text: "follow-up text" } });
		expect(settled).toBe(false);
		await fake.subscriptions[0]!.listener(
			routerFrame({ type: "agent_end", id: "b", finalText: "follow-up completed" }, 2),
		);
		await expect(turn).resolves.toMatchObject({
			result: { text: "follow-up completed", events: [{ type: "message_update" }, { type: "agent_end" }] },
		});
	});

	test("follow_up control propagates semantic failure after acknowledgement", async () => {
		const fake = new RunnerRuntime();
		fake.delayTerminal = true;
		const runner = createManagedGjcTurnRunner(fake.runtime, 1_000);
		const turn = runner.runControl!(
			{ ...managedAbortAndPromptInput(), control: { operation: "follow_up" } },
			managedControlMapping(),
			{} as never,
		);
		await new Promise(resolve => setTimeout(resolve, 10));
		await fake.subscriptions[0]!.listener(
			routerFrame({ type: "agent_failed", error: { message: "follow-up failed" } }, 2),
		).catch(() => undefined);
		await expect(turn).rejects.toMatchObject({ code: "prompt_failed", message: "follow-up failed" });
	});

	test("pre-aborted managed start performs no lifecycle or publication effect", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		const controller = new AbortController();
		controller.abort();
		let publications = 0;
		await expect(
			runner.startManagedSession(
				{
					cwd: authority.canonicalWorkspace,
					sessionRoot: "/sessions",
					projectId: authority.projectId,
					chatId: authority.chatId,
					userMessageId: "cancelled",
					text: "no create",
					preparedManagedAuthority: withoutIdentity(),
					signal: controller.signal,
				},
				async () => {
					publications += 1;
				},
				async () => {
					publications += 1;
				},
			),
		).rejects.toMatchObject({ code: "gjc_turn_cancelled" });
		expect(fake.externalLifecycle).toHaveLength(0);
		expect(fake.requests).toHaveLength(0);
		expect(publications).toBe(0);
	});

	test("session.new acknowledges assigned successor before currentness proof", async () => {
		const fake = new RunnerRuntime();
		fake.createPreparedExternalLifecycleSession = async (_prepared, request) => {
			fake.externalLifecycle.push(request);
			return { ok: true, result: { sessionId: "new-session", endpointGeneration: 12 } };
		};
		const runner = createManagedGjcTurnRunner(fake.runtime);
		let acknowledged = false;
		const register = fake.registerLifecycleTenant.bind(fake);
		fake.registerLifecycleTenant = async (key, outcome) => {
			expect(acknowledged).toBe(true);
			return register(key, outcome);
		};
		const result = await runner.runControl!(
			{ ...managedAbortAndPromptInput(), control: { operation: "session.new" } },
			managedControlMapping(),
			{} as never,
			successor => {
				acknowledged = true;
				expect(successor).toMatchObject({
					sessionId: "new-session",
					managedAuthority: { generation: 12, principalId: authority.principalId },
				});
			},
		);
		expect(result.result?.managedAuthority?.sessionId).toBe("new-session");
		expect(result.result?.managedAuthority?.requestKey).not.toBe(authority.requestKey);
		expect(fake.requests).toHaveLength(0);
	});

	test("rejects foreign selected resume before lifecycle invocation", async () => {
		const fake = new RunnerRuntime();
		let resumes = 0;
		const resume = fake.resumeExternalLifecycleSession.bind(fake);
		fake.resumeExternalLifecycleSession = async (key, request) => {
			resumes += 1;
			return resume(key, request);
		};
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await expect(
			runner.runControl!(
				{
					...managedAbortAndPromptInput(),
					control: { operation: "session.resume", sessionId: "foreign", sessionFile: "/foreign/session" },
				},
				managedControlMapping(),
				{} as never,
			),
		).rejects.toThrow("persisted exact target authority");
		expect(resumes).toBe(0);
		expect(fake.requests).toHaveLength(0);
	});

	test("uses configured continuation budget across setters and prevents late prompt dispatch", async () => {
		const fake = new RunnerRuntime();
		const release = deferred<void>();
		const original = fake.request.bind(fake);
		fake.request = async (attachment, frame, options) => {
			if (frame.operation === "model.set") await release.promise;
			return original(attachment, frame, options);
		};
		const runner = createManagedGjcTurnRunner(fake.runtime, 25);
		await expect(
			runner.continue({
				...address(),
				authority,
				modelSelection,
				userMessageId: "bounded",
				text: "never dispatched",
				operationId: "bounded",
				rawFrameCursor: 0,
				eventCursor: 0,
			}),
		).rejects.toMatchObject({ code: "timeout" });
		expect(fake.requests).toHaveLength(0);
		release.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(fake.requests).toHaveLength(0);
	});

	test("requires exact retirement for close and performs pre-prompt cleanup once after failure", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		fake.status = "retired";
		await runner.operations.close({ authority, target: { sessionId: authority.sessionId } });
		expect(fake.closeCalls).toBe(1);
		fake.failPrompt = true;
		await expect(
			runner.create({
				preparedManagedAuthority: withoutIdentity(),
				cwd: authority.canonicalWorkspace,
				sessionRoot: "/sessions",
				projectId: authority.projectId,
				chatId: authority.chatId,
				userMessageId: "message-4",
				text: "fail",
			}),
		).rejects.toThrow("prompt failure");
		expect(fake.closeCalls).toBe(2);
		fake.status = "replaced";
		await expect(runner.operations.close({ authority, target: { sessionId: authority.sessionId } })).rejects.toThrow(
			"retirement",
		);
	});

	test("routes managed branch through public lifecycle and returns exact successor authority", async () => {
		const fake = new RunnerRuntime();
		fake.forkResult = { sessionId: "successor-session", endpointGeneration: 8 };
		const runner = createManagedGjcTurnRunner(fake.runtime);
		const result = await runner.runControl!(
			{
				project: { cwd: authority.canonicalWorkspace } as never,
				prompt: "branch prompt",
				chatId: authority.chatId,
				messageId: "message-branch",
				userMessageId: "message-branch",
				userMessageParentId: null,
				continued: true,
				ownerUserId: authority.principalId,
				control: { operation: "branch" },
			} as never,
			{
				principalId: authority.principalId,
				chatId: authority.chatId,
				projectId: authority.projectId,
				sessionId: authority.sessionId,
				rawFrameCursor: 0,
				eventCursor: 0,
				operationId: "operation-branch",
				managedAuthority: authority,
			},
			{} as never,
		);
		expect(result?.sessionId).toBe("successor-session");
		expect(result?.result?.managedAuthority).toMatchObject({
			...authority,
			sessionId: "successor-session",
			generation: 8,
		});
		expect(result?.result?.managedProof).toEqual({
			kind: "managed-generation",
			sessionId: "successor-session",
			generation: 8,
			leaseId: authority.leaseId,
			epoch: authority.epoch,
		});
		expect(result?.result).not.toHaveProperty("attachment");
		expect(JSON.stringify(result)).not.toMatch(/descriptor|sessionFile|tmux|token|credential/i);
		expect(fake.requests).toHaveLength(0);
		expect(fake.forkRequests).toHaveLength(1);
		expect(fake.forkRequests[0]).toMatchObject({
			capability: "session.fork",
			requestKey: authority.requestKey,
			target: { sourceSessionId: authority.sessionId },
		});
	});

	test("rejects a lifecycle fork that returns the source identity without closing the source", async () => {
		const fake = new RunnerRuntime();
		const runner = createManagedGjcTurnRunner(fake.runtime);
		await expect(
			runner.runControl!(
				{
					project: { cwd: authority.canonicalWorkspace } as never,
					prompt: "branch prompt",
					chatId: authority.chatId,
					messageId: "message-branch-source",
					userMessageId: "message-branch-source",
					userMessageParentId: null,
					continued: true,
					ownerUserId: authority.principalId,
					control: { operation: "branch" },
				} as never,
				{
					principalId: authority.principalId,
					chatId: authority.chatId,
					projectId: authority.projectId,
					sessionId: authority.sessionId,
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "operation-branch-source",
					managedAuthority: authority,
				},
				{} as never,
			),
		).rejects.toBeInstanceOf(Error);
		expect(fake.closeCalls).toBe(0);
	});
});

function withoutIdentity(): ManagedPreparedTurnAuthority {
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

function managedControlMapping() {
	return {
		principalId: authority.principalId,
		chatId: authority.chatId,
		projectId: authority.projectId,
		sessionId: authority.sessionId,
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "operation-abort-and-prompt",
		managedAuthority: authority,
	} as never;
}

function managedAbortAndPromptInput(signal?: AbortSignal): LiveGatewayRunnerInput {
	return {
		project: {
			id: authority.projectId,
			name: "Project",
			cwd: authority.canonicalWorkspace,
			allowedRoot: "/workspace",
			createdAt: new Date("2026-07-08T00:00:00.000Z"),
		},
		prompt: "fallback prompt",
		chatId: authority.chatId,
		messageId: "message-abort-and-prompt",
		userMessageId: "message-abort-and-prompt",
		userMessageParentId: null,
		continued: true,
		ownerUserId: authority.principalId,
		control: { operation: "abort_and_prompt", text: "replacement prompt" },
		...(signal === undefined ? {} : { signal }),
	};
}

class RunnerRuntime {
	readonly state = "running";
	readonly attachment = { isCurrent: () => true };
	readonly tokens = new Map<string, ManagedSdkAttachment>();
	readonly requests: Record<string, unknown>[] = [];
	readonly subscriptions: { correlation: Record<string, unknown>; listener: (frame: unknown) => Promise<void> }[] = [];
	readonly subscriptionHistory: {
		correlation: Record<string, unknown>;
		listener: (frame: unknown) => Promise<void>;
	}[] = [];
	readonly externalLifecycle: Record<string, unknown>[] = [];
	readonly forkRequests: Record<string, unknown>[] = [];
	readonly registered: unknown[] = [];
	readonly subscriptionCountAtRequest: number[] = [];
	status: "retired" | "current" | "replaced" = "current";
	unsubscribed = 0;
	closeCalls = 0;
	failPrompt = false;
	failAbortAndPrompt = false;
	delayTerminal = false;
	setterFailure: "model.set" | "thinking.set" | undefined;
	modelSetResult: Readonly<Record<string, unknown>> | undefined;
	forkResult: { readonly sessionId: string; readonly endpointGeneration: number } = {
		sessionId: authority.sessionId,
		endpointGeneration: authority.generation,
	};
	thinkingSetResult: Readonly<Record<string, unknown>> | undefined;
	get runtime(): ManagedSdkRuntime {
		return this as unknown as ManagedSdkRuntime;
	}
	async reconcile() {}
	async acquireAttachment(key: unknown) {
		return this.token(key as TenantSessionKey);
	}
	async registerLifecycleTenant(key: unknown, outcome: unknown) {
		this.registered.push({ key, outcome });
		return this.token(key as TenantSessionKey);
	}
	private token(key: TenantSessionKey): ManagedSdkAttachment {
		const identity = JSON.stringify(key);
		let token = this.tokens.get(identity);
		if (token === undefined) {
			token = { tenant: key, generation: key.generation, isCurrent: this.attachment.isCurrent };
			this.tokens.set(identity, token);
		}
		return token;
	}
	async createExternalLifecycleSession(_tenant: unknown, request?: Record<string, unknown>) {
		if (request === undefined) throw new Error("Complete managed tenant authority is required.");
		this.externalLifecycle.push(request);
		return lifecycleSuccess();
	}
	async createPreparedExternalLifecycleSession(_authority: unknown, request: Record<string, unknown>) {
		this.externalLifecycle.push(request);
		return lifecycleSuccess();
	}
	async resumeExternalLifecycleSession(_tenant: unknown, request?: Record<string, unknown>) {
		if (request === undefined) throw new Error("Complete managed tenant authority is required.");
		return { kind: "result", outcome: lifecycleSuccess() };
	}
	async request(
		_attachment: unknown,
		frame: Record<string, unknown>,
		options?: { beforeDispatch?: () => void; onDispatch?: () => void },
	) {
		options?.beforeDispatch?.();
		if (frame.type === "query_request")
			return { type: "query_response", ok: true, page: { items: [], complete: true } };
		this.subscriptionCountAtRequest.push(this.subscriptions.length);
		this.requests.push(frame);
		if (frame.operation === "model.set") {
			if (this.setterFailure === "model.set") throw new Error("model setter failure");
			return {
				type: "control_response",
				ok: true as const,
				result: this.modelSetResult ?? modelSelection,
			};
		}
		if (frame.operation === "thinking.set") {
			if (this.setterFailure === "thinking.set") throw new Error("thinking setter failure");
			return {
				type: "control_response",
				ok: true as const,
				result: this.thinkingSetResult ?? { changed: true },
			};
		}
		if (frame.operation === "turn.prompt" && this.failPrompt) throw new Error("prompt failure");
		if (frame.operation === "turn.abort_and_prompt" && this.failAbortAndPrompt)
			throw new Error("abort-and-prompt failure");
		options?.onDispatch?.();
		if (
			frame.operation === "turn.prompt" ||
			frame.operation === "turn.follow_up" ||
			frame.operation === "turn.abort_and_prompt" ||
			frame.operation === "workflow.gate_answer"
		) {
			const active = this.subscriptions.at(-1);
			if (active === undefined) throw new Error("managed frame subscription must precede request");
			await active.listener(routerFrame({ type: "message_update", id: "a", text: "done" }, 1));
			await active.listener(routerFrame({ type: "message_update", id: "a", text: "done" }, 1));
			if (!this.delayTerminal)
				await active.listener(routerFrame({ type: "agent_end", id: "b", finalText: "done" }, 2));
		}
		return {
			type: "control_response",
			ok: true as const,
			result: { commandId: "command-1", turnId: "turn-1", accepted: true },
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
		const buffered: unknown[] = [];
		let bound = false;
		let active = true;
		let tail = Promise.resolve();
		const deliver = async (frame: unknown) => {
			if (!bound) {
				buffered.push(frame);
				return;
			}
			tail = tail.then(async () => {
				if (active) await listener(frame);
			});
			void tail.catch(() => undefined);
		};
		const subscription = { correlation: {}, listener: deliver };
		this.subscriptions.push(subscription);
		this.subscriptionHistory.push(subscription);
		const unsubscribe = (() => {
			if (!active) return;
			active = false;
			this.unsubscribed += 1;
			this.subscriptions.splice(this.subscriptions.indexOf(subscription), 1);
		}) as (() => void) & { bind(correlation: Record<string, unknown>): void; drain(): Promise<void> };
		unsubscribe.bind = correlation => {
			subscription.correlation = correlation;
			bound = true;
			for (const frame of buffered) void deliver(frame);
			buffered.length = 0;
		};
		unsubscribe.drain = async () => {
			await tail;
		};
		void operation;
		return unsubscribe;
	}
	async generationStatus() {
		return { status: this.status };
	}
	async forkLifecycleSession(_tenantOrRequest: unknown, maybeRequest?: Record<string, unknown>) {
		const request = maybeRequest ?? (_tenantOrRequest as Record<string, unknown>);
		this.forkRequests.push(request);
		return { ok: true as const, operation: "session.fork", result: this.forkResult };
	}
	async closeLifecycleSession(_tenantOrRequest?: unknown, _maybeRequest?: Record<string, unknown>) {
		this.closeCalls += 1;
		return lifecycleSuccess();
	}
	async deleteLifecycleSession(_tenantOrRequest?: unknown, _maybeRequest?: Record<string, unknown>) {
		return lifecycleSuccess();
	}
	async listLifecycleSessions(_tenantOrRequest?: unknown, _maybeRequest?: Record<string, unknown>) {
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
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
}
