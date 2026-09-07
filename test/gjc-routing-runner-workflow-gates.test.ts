import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedModelSelection } from "../src/contracts";
import { isManagedLifecycleEvidence } from "../src/gjc/managed-lifecycle-evidence";
import type { ManagedSdkRuntime } from "../src/gjc/managed-sdk-runtime";
import { scopedSessionMappingStore } from "../src/gjc/scoped-session-mapping-store";
import { canonicalSessionMappingKey, SessionAuthorityLoadError } from "../src/gjc/session-authority";
import { FileBackedSessionMappingStore, type SessionMappingStore } from "../src/gjc/session-router";
import { V3FileBackedSessionMappingStore } from "../src/gjc/session-v3-file-backed-mapping-store";
import type {
	GjcLifecycleTransaction,
	GjcRespondWorkflowGateInput,
	GjcSessionAddress,
	GjcStartNewSessionInput,
	GjcTurnResult,
	ManagedGenerationProof,
	ManagedPreparedTurnAuthority,
} from "../src/gjc/turn-runner";
import { GjcTurnCancelledError } from "../src/gjc/turn-runner";
import { createManagedGjcTurnRunner } from "../src/live/gjc-managed-turn-runner";
import { createGjcRoutingLiveGatewayRunner } from "../src/live/gjc-routing-runner";
import { projectTurnEvents, synthesizeProjectionRows } from "../src/live/workflow-gate-projection";
import { handleWorkflowGateReply } from "../src/live/workflow-gate-turns";
import { InMemoryOutboxStore } from "../src/state/outbox";
import { lifecycleFixture, managedPreparedAuthority } from "./gjc-lifecycle-fixtures";
import {
	decisionWorkflowGateEvent,
	deepInterviewWorkflowGateEvent,
	FakeGjcTurnRunner,
	project,
} from "./gjc-routing-runner-fixtures";

const ownerUserId = "owner-test";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function managedMappingStore(): V3FileBackedSessionMappingStore {
	const root = mkdtempSync(join(tmpdir(), "gjc-gate-v3-"));
	roots.push(root);
	return new V3FileBackedSessionMappingStore(join(root, "mappings.json"));
}

class PreDispatchCancellationWorkflowGateRunner extends FakeGjcTurnRunner {
	#first = true;

	constructor(private readonly cancelBeforeDispatch: () => void) {
		super();
	}

	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		if (this.#first) {
			this.#first = false;
			this.gateResponses.push(input);
			this.cancelBeforeDispatch();
			throw new GjcTurnCancelledError();
		}
		return await super.respondWorkflowGate(input);
	}
}

class DispatchedErrorWorkflowGateRunner extends FakeGjcTurnRunner {
	async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		this.gateResponses.push(input);
		input.onDispatch?.();
		throw new Error("workflow gate failed after dispatch");
	}
}

describe("createGjcRoutingLiveGatewayRunner workflow gates", () => {
	test("surfaces workflow gate options as the assistant message", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		turnRunner.events = [deepInterviewWorkflowGateEvent];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings: managedMappingStore() });

		const result = await runner.run({
			project,
			prompt: "/deep-interview",
			chatId: "chat-1",
			messageId: "assistant-1",
			userMessageId: "user-1",
			userMessageParentId: null,
			ownerUserId: "owner-test",
			preparedManagedAuthority: managedPreparedAuthority({
				projectId: project.id,
				canonicalWorkspace: project.cwd,
				chatId: "chat-1",
				requestKey: "user-1",
			}),
			continued: false,
		});

		expect(result.content).toContain("Choose authentication method");
		expect(result.content).toContain("1. JWT");
		expect(result.content).toContain("Reply with a number");
	});

	test("routes numbered workflow gate replies back to GJC instead of continuing the session", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		const result = await runner.run(replyInput("1"));

		expect(result).toEqual({ content: "workflow gate accepted" });
		expect(turnRunner.continues).toHaveLength(0);
		expect(turnRunner.gateResponses).toMatchObject([
			{
				gateId: "gate-deep-1",
				answer: { selected: ["JWT"] },
				promptText: "1",
				idempotencyKey: "chat-1:user-2",
				userMessageId: "user-2",
				gateCorrelation: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
			},
		]);
		expect(mappings.get("chat-1")?.managedAuthority).toMatchObject({
			principalId: ownerUserId,
			sessionId: "session-1",
			canonicalWorkspace: project.cwd,
		});
		for (const field of ["sessionFile", "recoveryAttachment", "activeLeaf"])
			expect(turnRunner.gateResponses[0]).not.toHaveProperty(field);
		expect(mappings.get("chat-1")?.attachment).toBeUndefined();
	});
	test("cleans up a pre-aborted workflow gate reply so the same message can retry", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const cancellations: unknown[] = [];
		const cleared: unknown[] = [];
		turnRunner.cancelTurn = cancellation => cancellations.push(cancellation);
		Object.assign(turnRunner, {
			clearTurnCancellation: (cancellation: unknown) => cleared.push(cancellation),
		});
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const controller = new AbortController();
		controller.abort();

		await expect(runner.run({ ...replyInput("1"), signal: controller.signal })).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		expect(cancellations).toHaveLength(0);
		expect(cleared).toHaveLength(1);
		expect(cleared[0]).toMatchObject({
			principalId: ownerUserId,
			projectId: project.id,
			chatId: "chat-1",
			sessionId: "session-1",
			operationId: "user-2",
			managedAuthority: managedPreparedAuthority(),
		});
		expect(mappings.operation("chat-1", "user-2")).toBeUndefined();
		expect(turnRunner.gateResponses).toHaveLength(0);

		await expect(runner.run(replyInput("1"))).resolves.toEqual({ content: "workflow gate accepted" });
		expect(turnRunner.gateResponses).toHaveLength(1);
	});
	test("discards a workflow gate cancelled after begin but before SDK dispatch so the same ID can retry", async () => {
		const controller = new AbortController();
		const turnRunner = new PreDispatchCancellationWorkflowGateRunner(() => controller.abort());
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(runner.run({ ...replyInput("1"), signal: controller.signal })).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		expect(mappings.operation("chat-1", "user-2")).toBeUndefined();

		await expect(runner.run(replyInput("1"))).resolves.toEqual({ content: "workflow gate accepted" });
		expect(mappings.operation("chat-1", "user-2")).toMatchObject({ state: "complete" });
	});
	test("does not send a terminal abort before gate dispatch and retries the same message", async () => {
		const authority = managedPreparedAuthority();
		let cancellation = new AbortController();
		let answerCalls = 0;
		let abortCalls = 0;
		let subscriptionsClosed = 0;
		const requests: Record<string, unknown>[] = [];
		const currentAttachment = { tenant: authority, generation: authority.generation, isCurrent: () => true };
		const runtime = {
			state: "running",
			async reconcile() {},
			async acquireAttachment() {
				return currentAttachment;
			},
			prepareFrameSubscription(
				_attachment: unknown,
				operation: string,
				listener: Parameters<ManagedSdkRuntime["prepareFrameSubscription"]>[2],
			) {
				let active = true;
				let delivery = Promise.resolve();
				return Object.assign(
					() => {
						if (!active) return;
						active = false;
						subscriptionsClosed += 1;
					},
					{
						bind(correlation: Parameters<ReturnType<ManagedSdkRuntime["prepareFrameSubscription"]>["bind"]>[0]) {
							if (answerCalls !== 2) return;
							delivery = Promise.resolve().then(async () => {
								if (!active) return;
								await listener({
									tenant: authority,
									operation,
									correlation,
									frame: {
										name: "event",
										body: { type: "agent_end", finalText: "accepted" },
										...correlation,
										sessionId: authority.sessionId,
										generation: authority.generation,
										seq: 1,
									},
								});
							});
						},
						async drain() {
							await delivery;
						},
					},
				);
			},
			async request(
				_attachment: unknown,
				frame: Record<string, unknown>,
				options?: { beforeDispatch?: () => void; onDispatch?: () => void },
			) {
				if (frame.type === "query_request")
					return { type: "query_response", ok: true, page: { items: [], complete: true } };
				if (frame.operation === "workflow.gate_answer") {
					answerCalls += 1;
					if (answerCalls === 1) cancellation.abort();
				}
				options?.beforeDispatch?.();
				requests.push(frame);
				options?.onDispatch?.();
				if (frame.operation === "turn.abort") abortCalls += 1;
				if (frame.operation === "workflow.gate_answer" && answerCalls === 3) cancellation.abort();
				return {
					type: "control_response",
					ok: true,
					result: { commandId: "command-1", turnId: "turn-1", accepted: true },
				};
			},
		} as unknown as ManagedSdkRuntime;
		const turnRunner = createManagedGjcTurnRunner(runtime);
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const outbox = new InMemoryOutboxStore();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings, outbox });
		const answer = (userMessageId = "user-2") =>
			runner.run({ ...replyInput("1"), userMessageId, signal: cancellation.signal });
		await expect(answer()).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		expect(abortCalls).toBe(0);
		expect(requests).toHaveLength(0);
		expect(mappings.operation("chat-1", "user-2")).toBeUndefined();
		expect(outbox.listPending()).toHaveLength(0);
		cancellation = new AbortController();
		await expect(answer()).resolves.toMatchObject({ content: "accepted" });
		expect(answerCalls).toBe(2);
		expect(abortCalls).toBe(0);
		expect(mappings.operation("chat-1", "user-2")?.state).toBe("complete");
		mappings.upsert({
			...requiredMapping(mappings),
			events: [deepInterviewWorkflowGateEvent],
		});
		const beforeCancellation = requiredMapping(mappings);
		const rowsBeforeCancellation = outbox.listPending();
		await expect(answer("user-3")).rejects.toMatchObject({
			name: "GjcTurnCancelledError",
		});
		expect(abortCalls).toBe(1);
		expect(requests.map(frame => frame.operation)).toEqual([
			"workflow.gate_answer",
			"workflow.gate_answer",
			"turn.abort",
		]);
		expect(requests[0]).toMatchObject({
			idempotencyKey: "chat-1:user-2",
			input: { id: "gate-deep-1", response: { selected: ["JWT"] }, expectedSessionId: authority.sessionId },
		});
		expect(subscriptionsClosed).toBe(3);
		expect(mappings.operation("chat-1", "user-3")?.state).toBe("uncertain");
		expect(mappings.operation("chat-1", "user-3")?.result).toBeUndefined();
		expect(requiredMapping(mappings)).toEqual(beforeCancellation);
		expect(outbox.listPending()).toEqual(rowsBeforeCancellation);
	});
	test("retains uncertain workflow gate authority when an SDK dispatch was acknowledged before an error", async () => {
		const turnRunner = new DispatchedErrorWorkflowGateRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(runner.run(replyInput("1"))).rejects.toThrow("workflow gate failed after dispatch");
		expect(mappings.operation("chat-1", "user-2")).toMatchObject({
			state: "uncertain",
			id: "user-2",
		});
	});
	test("requires complete mapped managed tenant authority before dispatch", async () => {
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const mapping = requiredMapping(mappings);
		const authority = managedPreparedAuthority();
		for (const managedAuthority of [
			undefined,
			{ ...authority, principalId: "foreign-owner" },
			{ ...authority, projectId: "foreign-project" },
			{ ...authority, canonicalWorkspace: "/foreign/workspace" },
			{ ...authority, chatId: "foreign-chat" },
			{ ...authority, sessionId: "foreign-session" },
			{ ...authority, generation: 0 },
			{ ...authority, generation: 1.5 },
			{ ...authority, leaseId: "" },
			{ ...authority, epoch: "" },
			{ ...authority, requestKey: " " },
		]) {
			const turnRunner = new FakeGjcTurnRunner();
			await expect(
				handleWorkflowGateReply(
					{ turnRunner, mappings },
					replyInput("1"),
					{ ...mapping, managedAuthority },
					gateLifecycle(mapping),
				),
			).rejects.toThrow("exact principal, workspace, and session authority");
			expect(turnRunner.gateResponses).toHaveLength(0);
			expect(mappings.operation("chat-1", "user-2")).toBeUndefined();
		}
		const turnRunner = new FakeGjcTurnRunner();
		await expect(
			handleWorkflowGateReply(
				{ turnRunner, mappings },
				{ ...replyInput("1"), ownerUserId: undefined },
				mapping,
				gateLifecycle(mapping),
			),
		).rejects.toThrow("exact principal, workspace, and session authority");
		expect(turnRunner.gateResponses).toHaveLength(0);
	});
	test("requires managed lifecycle publication before dispatch without a legacy fallback", async () => {
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const mapping = requiredMapping(mappings);
		const turnRunner = new FakeGjcTurnRunner();
		await expect(
			handleWorkflowGateReply({ turnRunner, mappings }, replyInput("1"), mapping, {
				...gateLifecycle(mapping),
				publishManaged: undefined,
			} as unknown as GjcLifecycleTransaction),
		).rejects.toThrow("requires managed lifecycle publication");
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(mappings.operation("chat-1", "user-2")).toBeUndefined();
	});
	test("rejects foreign gate correlation before managed dispatch", async () => {
		const mappings = pendingGateMappings({
			...deepInterviewWorkflowGateEvent,
			payload: { ...deepInterviewWorkflowGateEvent.payload, sessionId: "foreign-session" },
		});
		const turnRunner = new FakeGjcTurnRunner();
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		await expect(runner.run(replyInput("1"))).rejects.toThrow("correlation does not match");
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(mappings.operation("chat-1", "user-2")).toBeUndefined();
	});
	test("rejects missing or changed managed result authority and proof without publishing", async () => {
		const authority = managedPreparedAuthority();
		const proof: ManagedGenerationProof = {
			kind: "managed-generation",
			sessionId: authority.sessionId,
			generation: authority.generation,
			leaseId: authority.leaseId,
			epoch: authority.epoch,
		};
		const changes: Partial<GjcTurnResult>[] = [
			{ managedAuthority: undefined },
			{ managedProof: undefined },
			...(
				[
					["principalId", "foreign-owner"],
					["projectId", "foreign-project"],
					["canonicalWorkspace", "/foreign/workspace"],
					["chatId", "foreign-chat"],
					["sessionId", "foreign-session"],
					["generation", 2],
					["leaseId", "foreign-lease"],
					["epoch", "foreign-epoch"],
					["requestKey", ""],
					["requestKey", "foreign-request"],
				] as const
			).map(([field, value]) => ({ managedAuthority: { ...authority, [field]: value } })),
			...(
				[
					["sessionId", "foreign-session"],
					["generation", 2],
					["leaseId", "foreign-lease"],
					["epoch", "foreign-epoch"],
				] as const
			).map(([field, value]) => ({ managedProof: { ...proof, [field]: value } })),
		];
		for (const change of changes) {
			const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
			const mapping = requiredMapping(mappings);
			class ChangedResultRunner extends FakeGjcTurnRunner {
				async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
					return { ...(await super.respondWorkflowGate(input)), ...change };
				}
			}
			const turnRunner = new ChangedResultRunner();
			const outbox = new InMemoryOutboxStore();
			let publicationCalls = 0;
			const lifecycle: GjcLifecycleTransaction = {
				...gateLifecycle(mapping),
				async publishManaged() {
					publicationCalls += 1;
					throw new Error("invalid publication");
				},
			};
			await expect(
				handleWorkflowGateReply({ turnRunner, mappings, outbox }, replyInput("1"), mapping, lifecycle),
			).rejects.toThrow("matching current managed authority and proof");
			expect(publicationCalls).toBe(0);
			expect(requiredMapping(mappings)).toEqual(mapping);
			expect(mappings.operation("chat-1", "user-2")?.state).toBe("uncertain");
			expect(outbox.listPending()).toHaveLength(0);
		}
	});
	test("uses managed publication exclusively for a matching result", async () => {
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const mapping = requiredMapping(mappings);
		const fixture = gateLifecycle(mapping);
		let managedPublications = 0;
		const lifecycle: GjcLifecycleTransaction = {
			...fixture,
			async publishManaged(proof, write) {
				managedPublications += 1;
				return await fixture.publishManaged!(proof, write);
			},
		};
		await expect(
			handleWorkflowGateReply(
				{ turnRunner: new FakeGjcTurnRunner(), mappings },
				replyInput("1"),
				mapping,
				lifecycle,
			),
		).resolves.toEqual({ content: "workflow gate accepted" });
		expect(managedPublications).toBe(1);
		expect(mappings.operation("chat-1", "user-2")?.state).toBe("complete");
	});
	test("accepts result authority bound to the current gate ingress without changing its generation", async () => {
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const mapping = requiredMapping(mappings);
		class IngressBoundResultRunner extends FakeGjcTurnRunner {
			async respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
				const result = await super.respondWorkflowGate(input);
				return { ...result, managedAuthority: managedPreparedAuthority({ requestKey: input.userMessageId }) };
			}
		}
		await expect(
			handleWorkflowGateReply(
				{ turnRunner: new IngressBoundResultRunner(), mappings },
				replyInput("1"),
				mapping,
				gateLifecycle(mapping),
			),
		).resolves.toEqual({ content: "workflow gate accepted" });
		expect(requiredMapping(mappings).managedAuthority).toEqual(managedPreparedAuthority({ requestKey: "user-2" }));
	});
	test("does not publish a dispatched gate when cancellation arrives at publication", async () => {
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const mapping = requiredMapping(mappings);
		const cancellation = new AbortController();
		const outbox = new InMemoryOutboxStore();
		const turnRunner = new FakeGjcTurnRunner();
		const lifecycle: GjcLifecycleTransaction = {
			...gateLifecycle(mapping),
			async publishManaged(_proof, write) {
				cancellation.abort();
				return write();
			},
		};
		await expect(
			handleWorkflowGateReply(
				{ turnRunner, mappings, outbox },
				{ ...replyInput("1"), signal: cancellation.signal },
				mapping,
				lifecycle,
			),
		).rejects.toMatchObject({ name: "GjcTurnCancelledError" });
		expect(turnRunner.gateResponses).toHaveLength(1);
		expect(requiredMapping(mappings)).toEqual(mapping);
		expect(mappings.operation("chat-1", "user-2")?.state).toBe("uncertain");
		expect(outbox.listPending()).toHaveLength(0);
	});
	test("bounds oversized gate fields before projecting the gate label", () => {
		// projectPendingWorkflowGateMessage() concatenates the prompt and every
		// option before boundedText() truncates; a retained gate with a
		// payload-sized prompt would allocate that whole string during boot
		// projection. The projected label must equal boundedText() applied to the
		// full message while never materializing the full message itself.
		const hugePrompt = "x".repeat(10_000);
		const hugeLabel = "y".repeat(10_000);
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-huge-1",
					payload: {
						gateId: "gate-huge-1",
						schemaHash: "sha256:huge",
						idempotencyKey: "idem-huge-1",
						boundUserMessageId: null,
						status: "pending",
						context: { prompt: hugePrompt },
						options: [{ label: hugeLabel, value: hugeLabel }],
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		// The projected label is boundedText() of the assembled message; the
		// huge fields must not leak past the 80-char truncation.
		expect(description!.length).toBeLessThanOrEqual(80);
		expect(description!).not.toContain("x".repeat(80));
		expect(description!).not.toContain("y".repeat(80));
	});
	test("preserves the schema-derived gate prompt fallback in the projected label", () => {
		// A gate without context.prompt/title must keep projectPendingWorkflowGateMessage()'s
		// schema fallback; dropping it would change the payload hash across an upgrade
		// and make startup synthesis reject the stored outbox row.
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-string-1",
					payload: {
						gateId: "gate-string-1",
						schemaHash: "sha256:string",
						idempotencyKey: "idem-string-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { type: "string" },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		expect(description!).toContain("Answer with the requested text for this workfl");
	});
	test("preserves the default string-schema prompt for absent and invalid schemas", () => {
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-missing-schema-1",
					payload: {
						gateId: "gate-missing-schema-1",
						schemaHash: "sha256:missing-schema",
						idempotencyKey: "idem-missing-schema-1",
						boundUserMessageId: null,
						status: "pending",
					},
				},
				{
					type: "workflow_gate",
					id: "gate-invalid-schema-1",
					payload: {
						gateId: "gate-invalid-schema-1",
						schemaHash: "sha256:invalid-schema",
						idempotencyKey: "idem-invalid-schema-1",
						boundUserMessageId: null,
						status: "pending",
						schema: null,
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const descriptions = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.filter((value): value is string => value?.includes("workflow gate pending") ?? false);
		expect(descriptions).toHaveLength(2);
		for (const description of descriptions)
			expect(description).toContain("Answer with the requested text for this workfl");
	});
	test("preserves the fallback projection for a workflow gate without an identity", () => {
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					payload: {
						schemaHash: "custom",
						context: { prompt: "Approve?" },
						schema: { type: "boolean" },
						options: [{ label: "Approve", value: true }],
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		expect(projected).toMatchObject([
			{
				type: "status",
				data: {
					description: expect.stringContaining("Answer with the requested text for this workfl"),
					gjc_adapter: {
						metadata: { eventType: "workflow_gate", gateId: null },
						workflow_gate: { gateId: "unknown-gate", schemaHash: "unknown", optionCount: 0 },
					},
				},
			},
		]);
		expect(JSON.stringify(projected)).not.toContain("Approve?");
		expect(JSON.stringify(projected)).not.toContain('"custom"');
	});
	test("bounds a huge schema enum in the gate prompt fallback", () => {
		// A large enum must not be joined whole before the label truncates;
		// only the bounded prefix is projected.
		const hugeEnum = Array.from({ length: 10_000 }, (_, index) => `option-${index}`);
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-enum-1",
					payload: {
						gateId: "gate-enum-1",
						schemaHash: "sha256:enum",
						idempotencyKey: "idem-enum-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { enum: hugeEnum },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		expect(description!.length).toBeLessThanOrEqual(80);
		expect(description!).toContain("option-0");
		expect(description!).not.toContain("option-9999");
	});
	test("keeps the oversized first enum value's prefix in the gate prompt", () => {
		// A first enum value that alone exceeds the window must retain its
		// prefix (boundedText of the assembled message would show it); dropping
		// it would change the payload hash across the streaming change.
		const oversized = "x".repeat(100);
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-enum-first-1",
					payload: {
						gateId: "gate-enum-first-1",
						schemaHash: "sha256:enum-first",
						idempotencyKey: "idem-enum-first-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { enum: [oversized] },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toBeDefined();
		expect(description!.length).toBeLessThanOrEqual(80);
		expect(description!).toContain(`Choose one of: ${"x".repeat(20)}`);
		expect(description!).not.toContain(`Choose one of: ${"x".repeat(80)}`);
	});
	test("keeps enum values after an empty nested array prefix", () => {
		// Array#toString([[[]], [true]]) is ",true". The empty first nested
		// component must not be mistaken for a truncated prefix, or the second
		// enum value is lost and boot synthesis changes the persisted hash.
		const projected = projectTurnEvents(
			[
				{
					type: "workflow_gate",
					id: "gate-enum-nested-empty-1",
					payload: {
						gateId: "gate-enum-nested-empty-1",
						schemaHash: "sha256:enum-nested-empty",
						idempotencyKey: "idem-enum-nested-empty-1",
						boundUserMessageId: null,
						status: "pending",
						schema: { enum: [[[[]], [true]]] },
					},
				},
			],
			"gjc/anthropic/claude-sonnet-4:medium",
		);
		const description = projected
			.map(event => (event as { data?: { description?: string } }).data?.description)
			.find(value => value?.includes("workflow gate pending"));
		expect(description).toContain("Choose one of: ,true");
	});
	test("preserves the authenticated principal for workflow gate publication and replay after restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-workflow-gate-projection-"));
		const mappingFile = join(root, "mappings.json");
		const principalId = "normal-workflow-user";
		const adminPrincipalId = "admin-1";
		const seed = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const seedMapping = requiredMapping(seed);
		const mappings = new V3FileBackedSessionMappingStore(mappingFile);
		mappings.setScoped(
			{ principalId, chatId: "chat-1" },
			{
				...seedMapping,
				principalId,
				managedAuthority: managedPreparedAuthority({ principalId }),
			},
		);
		const turn = { ...replyInput("1"), ownerUserId: principalId };
		const outbox = new InMemoryOutboxStore();
		try {
			const first = createGjcRoutingLiveGatewayRunner({
				turnRunner: new FakeGjcTurnRunner(),
				mappings,
				outbox,
				ownerUserId: adminPrincipalId,
			});
			await first.run(turn);
			expect(outbox.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId, ownerUserId: principalId },
				{ operationId: `${turn.userMessageId}:event`, principalId, ownerUserId: principalId },
			]);

			const restartedMappings = new V3FileBackedSessionMappingStore(mappingFile);
			const synthesized = new InMemoryOutboxStore();
			synthesizeProjectionRows(synthesized, restartedMappings, adminPrincipalId, adminPrincipalId);
			expect(synthesized.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId, ownerUserId: principalId },
				{ operationId: `${turn.userMessageId}:event`, principalId, ownerUserId: principalId },
			]);

			const replayRunner = new FakeGjcTurnRunner();
			const replay = createGjcRoutingLiveGatewayRunner({
				turnRunner: replayRunner,
				mappings: restartedMappings,
				outbox: synthesized,
				ownerUserId: adminPrincipalId,
			});
			await replay.run(turn);
			expect(synthesized.listPending()).toMatchObject([
				{ operationId: turn.userMessageId, principalId, ownerUserId: principalId },
				{ operationId: `${turn.userMessageId}:event`, principalId, ownerUserId: principalId },
			]);
			expect(replayRunner.gateResponses).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("streams resumed workflow gate events before completion", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		let release!: () => void;
		turnRunner.completionBarrier = new Promise<void>(resolve => {
			release = resolve;
		});
		turnRunner.gateResponseEvents = [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", text: "workflow " } } },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start" } } },
			{ type: "agent_end" },
		];
		const liveEvents: unknown[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const result = await runner.run({
			...replyInput("1"),
			requestedModelId: "gjc/anthropic/claude-sonnet-4:medium",
			onLiveEvents: events => {
				liveEvents.push(...events);
			},
		});
		if (result.chunks === undefined) throw new Error("expected live chunks");
		if (!(Symbol.asyncIterator in result.chunks)) throw new Error("expected async live chunks");
		const iterator = result.chunks[Symbol.asyncIterator]();

		expect(await iterator.next()).toEqual({ value: "workflow ", done: false });
		expect(turnRunner.gateResponses[0]?.observer).toBeDefined();
		release();
		expect(await iterator.next()).toEqual({ value: "gate accepted", done: false });
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
		expect(liveEvents).toEqual([
			expect.objectContaining({
				type: "status",
				data: expect.objectContaining({ description: "Thinking started", done: false }),
			}),
			expect.objectContaining({
				type: "status",
				data: expect.objectContaining({ description: "agent_end", done: true }),
			}),
		]);
	});
	test("delivers workflow gate artifact fallback after terminal-only observation", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		turnRunner.gateObservedEvents = [{ type: "agent_end" }];
		turnRunner.gateResponseEvents = [
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start" } } },
			{ type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
			{ type: "tool_execution_start", payload: { toolName: "read" } },
			{ type: "tool_execution_end", payload: { toolName: "read" } },
			{ type: "agent_end" },
		];
		const liveEvents: unknown[] = [];
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });
		const result = await runner.run({
			...replyInput("1"),
			requestedModelId: "gjc/anthropic/claude-sonnet-4:medium",
			onLiveEvents: events => {
				liveEvents.push(...events);
			},
		});
		if (result.chunks === undefined) throw new Error("expected live chunks");
		for await (const _chunk of result.chunks) {
			// Drain the response so completion fallback events are delivered.
		}

		expect(liveEvents).toEqual([
			expect.objectContaining({ data: expect.objectContaining({ description: "Thinking started" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "Thinking completed" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "Tool read started" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "Tool read finished" }) }),
			expect.objectContaining({ data: expect.objectContaining({ description: "agent_end" }) }),
		]);
	});
	test("cold-resumes a persisted gate binding and answers its exact session without starting a new turn", async () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-cold-gate-"));
		try {
			const filePath = join(root, "mappings.json");
			const first = new V3FileBackedSessionMappingStore(filePath);
			for (const mapping of pendingGateMappings(deepInterviewWorkflowGateEvent).entries())
				first.setScoped({ principalId: ownerUserId, chatId: mapping.chatId }, mapping);
			const turnRunner = new FakeGjcTurnRunner();
			const resumed = createGjcRoutingLiveGatewayRunner({
				turnRunner,
				mappings: new V3FileBackedSessionMappingStore(filePath),
			});

			await expect(resumed.run(replyInput("1"))).resolves.toEqual({ content: "workflow gate accepted" });
			expect(turnRunner.managedStarts).toHaveLength(0);
			expect(turnRunner.continues).toHaveLength(0);
			expect(turnRunner.gateResponses).toMatchObject([
				{
					gateId: "gate-deep-1",
					sessionId: "session-1",
					managedAuthority: managedPreparedAuthority(),
					gateCorrelation: { commandId: "command-1", turnId: "turn-1", sessionId: "session-1" },
				},
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects invalid numbered workflow gate replies without answering GJC", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await expect(runner.run(replyInput("9"))).rejects.toThrow("Invalid workflow gate reply");
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(turnRunner.continues).toHaveLength(0);
	});

	test("rejects a workflow gate bound to a different canonical workspace before dispatch", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		const mapping = requiredMapping(mappings);
		const foreign = {
			...mapping,
			managedAuthority: managedPreparedAuthority({ canonicalWorkspace: "/tmp/foreign" }),
		};
		await expect(
			handleWorkflowGateReply({ turnRunner, mappings }, replyInput("1"), foreign, gateLifecycle(mapping)),
		).rejects.toThrow("exact principal, workspace, and session authority");
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(mappings.operation("chat-1", "user-2")).toBeUndefined();
	});

	test("routes numbered approval gate replies as structured decisions", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(decisionWorkflowGateEvent);
		const runner = createGjcRoutingLiveGatewayRunner({ turnRunner, mappings });

		await runner.run(replyInput("1"));

		expect(turnRunner.gateResponses).toMatchObject([
			{
				gateId: "gate-plan-1",
				answer: { decision: "approve" },
				idempotencyKey: "chat-1:user-2",
			},
		]);
	});

	test("classifies duplicate replay before catalog or transport and keeps its immutable binding", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		mappings.upsert({ ...requiredMapping(mappings), operationId: "user-2", assistantText: "cached" });
		let readerCount = 0;
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "gjc",
			createNeutralModelReader: () => {
				readerCount += 1;
				throw new Error("must not read");
			},
		});

		expect(await runner.run(replyInput("1"))).toMatchObject({
			content: "cached",
			model: "gjc/anthropic/claude-sonnet-4:medium",
		});
		expect(readerCount).toBe(0);
		expect(turnRunner.gateResponses).toHaveLength(0);
		expect(turnRunner.managedStarts).toHaveLength(0);
	});

	test("rejects pending missing or mismatched bindings without mutable reads or writes", async () => {
		for (const modelSelection of [
			undefined,
			{ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
		] as const) {
			const turnRunner = new FakeGjcTurnRunner();
			const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent, modelSelection ?? null);
			const before = requiredMapping(mappings);
			let readerCount = 0;
			const runner = createGjcRoutingLiveGatewayRunner({
				turnRunner,
				mappings,
				requestedModelId: () => "gjc/anthropic/claude-sonnet-4:medium",
				createNeutralModelReader: () => {
					readerCount += 1;
					throw new Error("must not read");
				},
			});

			await expect(runner.run(replyInput("1"))).rejects.toThrow(
				modelSelection === undefined ? "no valid GJC model selection binding" : "original GJC model selection",
			);
			expect(readerCount).toBe(0);
			expect(turnRunner.gateResponses).toHaveLength(0);
			expect(mappings.get("chat-1")).toEqual({ ...before, modelSelection });
		}
	});

	test("answers a matching pending gate from its bound tuple despite mutable catalog drift", async () => {
		const turnRunner = new FakeGjcTurnRunner();
		const mappings = pendingGateMappings(deepInterviewWorkflowGateEvent);
		let readerCount = 0;
		const runner = createGjcRoutingLiveGatewayRunner({
			turnRunner,
			mappings,
			requestedModelId: () => "gjc",
			createNeutralModelReader: () => {
				readerCount += 1;
				throw new Error("drifted catalog must not be read");
			},
		});

		expect(await runner.run(replyInput("1"))).toEqual({
			content: "workflow gate accepted",
			model: "gjc/anthropic/claude-sonnet-4:medium",
		});
		expect(readerCount).toBe(0);
		expect(turnRunner.gateResponses).toHaveLength(1);
		expect(mappings.get("chat-1")?.modelSelection).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4",
			thinkingLevel: "medium",
		});
	});

	for (const failure of ["setter", "prompt"] as const) {
		test(`keeps V3 mappings and outbox unchanged with an uncertain receipt after selected ${failure} failure`, async () => {
			const root = mkdtempSync(join(tmpdir(), `gjc-${failure}-failure-`));
			try {
				const filePath = join(root, "mappings.json");
				const mappings = new V3FileBackedSessionMappingStore(filePath);
				mappings.setScoped(
					{ principalId: ownerUserId, chatId: "seed-chat" },
					{ ...baseMapping("seed-chat"), operationId: "seed-user" },
				);
				const before = JSON.parse(readFileSync(filePath, "utf8"));
				class FailingStartFakeGjcTurnRunner extends FakeGjcTurnRunner {
					async startManagedSession<T>(
						input: GjcStartNewSessionInput & { readonly preparedManagedAuthority: ManagedPreparedTurnAuthority },
						publish: (
							result: GjcSessionAddress & GjcTurnResult,
							lifecycle: GjcLifecycleTransaction,
						) => Promise<T>,
						beforePrompt: (
							address: GjcSessionAddress,
							proof: ManagedGenerationProof,
							lifecycle: GjcLifecycleTransaction,
						) => Promise<void>,
					): Promise<T> {
						return await super.startManagedSession(
							input,
							async (result, lifecycle) => {
								if (failure === "prompt") throw new Error(`${failure} failed`);
								return await publish(result, lifecycle);
							},
							async (address, proof, lifecycle) => {
								if (failure === "setter") throw new Error(`${failure} failed`);
								await beforePrompt(address, proof, lifecycle);
							},
						);
					}
				}
				const turnRunner = new FailingStartFakeGjcTurnRunner();
				const outbox = new InMemoryOutboxStore();
				const runner = createGjcRoutingLiveGatewayRunner({
					turnRunner,
					mappings,
					outbox,
					requestedModelId: () => "gjc/anthropic/claude-sonnet-4:low",
					createNeutralModelReader: selectedReader,
				});

				await expect(
					runner.run({
						...replyInput("hello"),
						chatId: "failed-chat",
						preparedManagedAuthority: managedPreparedAuthority({ chatId: "failed-chat", requestKey: "user-2" }),
					}),
				).rejects.toThrow(`${failure} failed`);
				expect(mappings.getScoped({ principalId: ownerUserId, chatId: "failed-chat" })).toBeUndefined();
				const document = JSON.parse(readFileSync(filePath, "utf8")) as {
					readonly mappings: readonly { readonly chatId?: unknown }[];
					readonly provisionalOperations: readonly Record<string, unknown>[];
				};
				expect(document.mappings).toEqual(
					(before as { readonly mappings: readonly { readonly chatId?: unknown }[] }).mappings,
				);
				const failedChatKey = canonicalSessionMappingKey(ownerUserId, "failed-chat");
				expect(document.mappings.some(mapping => mapping.chatId === failedChatKey)).toBeFalse();
				expect(document.provisionalOperations).toHaveLength(1);
				expect(isManagedLifecycleEvidence(document.provisionalOperations[0]!.lifecycle)).toBe(true);
				expect(document.provisionalOperations[0]).toMatchObject({
					id: "user-2",
					ingressId: "user-2",
					kind: "create",
					state: "uncertain",
					chatId: failedChatKey,
					projectId: "project",
					detail: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
				expect(Object.keys(document.provisionalOperations[0] ?? {}).sort()).toEqual(
					[
						"chatId",
						"detail",
						"id",
						"ingressId",
						"kind",
						"lifecycle",
						"managedAuthority",
						"projectId",
						"sessionId",
						"startedAt",
						"state",
					].sort(),
				);
				expect(document.provisionalOperations[0]).toMatchObject({
					sessionId: "session-1",
					managedAuthority: managedPreparedAuthority({ chatId: failedChatKey, requestKey: "user-2" }),
				});
				const failedOperation = document.provisionalOperations[0]!;
				const preparedAuthority = {
					principalId: ownerUserId,
					projectId: "project",
					canonicalWorkspace: project.cwd,
					chatId: "failed-chat",
					leaseId: "lease-1",
					epoch: "epoch-1",
					requestKey: "user-2",
				};
				expect(failedOperation.lifecycle).toMatchObject({
					operation: "session.create",
					actor: { id: ownerUserId, namespace: "openwebui-gjc-adapter" },
					state: failure === "prompt" ? "active_generation_proven" : "uncertain",
					requestKey: "user-2",
					requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
					payloadHash: failedOperation.detail,
					preparedAuthority,
					target: { kind: "existing_path", path: project.cwd },
					acknowledged: { ...preparedAuthority, sessionId: "session-1", generation: 1 },
				});
				if (failure === "prompt")
					expect(failedOperation.lifecycle).toMatchObject({
						proven: {
							kind: "managed-generation",
							sessionId: "session-1",
							generation: 1,
							leaseId: "lease-1",
							epoch: "epoch-1",
						},
					});
				else expect(failedOperation.lifecycle).not.toHaveProperty("proven");
				expect(failedOperation.lifecycle).not.toHaveProperty("retirement");
				expect(turnRunner.managedStarts).toHaveLength(1);
				expect(JSON.stringify(document)).not.toMatch(/descriptor|sessionFile|attachment/);
				expect(JSON.stringify(document.provisionalOperations[0])).not.toMatch(/assistant|hello/);
				expect(outbox.listPending()).toHaveLength(0);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
	test("reloads V3 with no provisional operations and rejects a malformed provisional collection", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v3-provisional-"));
		try {
			const filePath = join(root, "mappings.json");
			const scope = { principalId: ownerUserId, chatId: "seed-chat" };
			new V3FileBackedSessionMappingStore(filePath).setScoped(scope, baseMapping("seed-chat"));
			const before = readFileSync(filePath, "utf8");
			const mappings = new V3FileBackedSessionMappingStore(filePath);
			expect(mappings.getScoped(scope)).toMatchObject({ chatId: "seed-chat" });
			expect(readFileSync(filePath, "utf8")).toBe(before);
			mappings.setScoped(
				{ principalId: ownerUserId, chatId: "next-chat" },
				{ ...baseMapping("next-chat"), operationId: "next-user" },
			);
			expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({
				version: 3,
				provisionalOperations: [],
			});

			writeFileSync(filePath, JSON.stringify({ ...JSON.parse(before), provisionalOperations: {} }), "utf8");
			expect(() => new V3FileBackedSessionMappingStore(filePath)).toThrow(SessionAuthorityLoadError);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("quarantines untrusted legacy authority instead of admitting a workflow gate mapping", () => {
		const root = mkdtempSync(join(tmpdir(), "gjc-v2-quarantine-"));
		try {
			const filePath = join(root, "mappings.json");
			const legacy = JSON.stringify([{ chatId: "old-chat" }]);
			writeFileSync(filePath, legacy, "utf8");

			const mappings = new FileBackedSessionMappingStore(filePath);
			expect(mappings.entries()).toEqual([]);
			const quarantines = readdirSync(root).filter(name => name.startsWith("mappings.json.legacy-"));
			expect(quarantines).toHaveLength(1);
			expect(readFileSync(join(root, quarantines[0]!), "utf8")).toBe(legacy);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function pendingGateMappings(
	event: unknown,
	modelSelection: NormalizedModelSelection | null = {
		provider: "anthropic",
		modelId: "claude-sonnet-4",
		thinkingLevel: "medium",
	},
) {
	const mappings = scopedSessionMappingStore(managedMappingStore(), ownerUserId, "chat-1");
	mappings.set({
		principalId: ownerUserId,
		chatId: "chat-1",
		projectId: project.id,
		sessionId: "session-1",
		managedAuthority: managedPreparedAuthority(),
		rawFrameCursor: 7,
		eventCursor: 3,
		operationId: "user-1",
		assistantText: "pending",
		modelSelection: modelSelection ?? undefined,
		events: [event as never],
	});
	return mappings;
}

function requiredMapping(mappings: SessionMappingStore) {
	const mapping = mappings.get("chat-1");
	if (mapping === undefined) throw new Error("expected mapping");
	return mapping;
}

function replyInput(prompt: string) {
	return {
		project,
		prompt,
		chatId: "chat-1",
		messageId: "assistant-2",
		userMessageId: "user-2",
		userMessageParentId: "user-1",
		ownerUserId,
		continued: true,
	};
}

function baseMapping(chatId: string) {
	return {
		principalId: ownerUserId,
		chatId,
		projectId: project.id,
		sessionId: "session-1",
		managedAuthority: managedPreparedAuthority({ chatId }),
		rawFrameCursor: 0,
		eventCursor: 0,
		operationId: "user-1",
	};
}

function gateLifecycle(mapping: ReturnType<typeof requiredMapping>): GjcLifecycleTransaction {
	return lifecycleFixture(
		{
			cwd: project.cwd,
			sessionRoot: `${project.cwd}/.gjc/sessions`,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			sessionId: mapping.sessionId,
		},
		mapping.managedAuthority,
	);
}

function selectedReader() {
	return {
		async getAvailableModels() {
			return [
				{
					provider: "anthropic",
					id: "claude-sonnet-4",
					reasoning: true,
					thinking: { validLevels: ["off", "low"] },
				},
			];
		},
		async getActiveProviders() {
			return [{ provider: "anthropic", connectionKind: "credential" }];
		},
		async getState() {
			return {};
		},
		stop() {},
	};
}
