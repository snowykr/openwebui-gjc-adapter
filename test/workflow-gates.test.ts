import { describe, expect, test } from "bun:test";
import {
	answerFromWorkflowGateReply,
	type PendingWorkflowGate,
	projectPendingWorkflowGateMessage,
	resolveWorkflowGateAnswer,
	WorkflowGateStore,
} from "../src/projection/workflow-gates";
import { decisionGate, deepInterviewGate } from "./workflow-gates-fixtures";

const baseGate: PendingWorkflowGate = {
	gateId: "gate-1",
	schemaHash: "sha256:abc",
	idempotencyKey: "idem-1",
	boundUserMessageId: null,
	status: "pending",
	schema: {
		required: ["decision", "reason"],
		properties: {
			decision: { type: "string", enum: ["approve", "reject"] },
			reason: { type: "string" },
		},
	},
};

describe("resolveWorkflowGateAnswer", () => {
	test("projects workflow gate options as a numbered OpenWebUI reply prompt", () => {
		const message = projectPendingWorkflowGateMessage(deepInterviewGate);

		expect(message).toContain("Choose authentication method");
		expect(message).toContain("1. JWT");
		expect(message).toContain("2. OAuth2");
		expect(message).toContain("3. Session cookies");
		expect(message).toContain("Reply with a number");
	});

	test("maps a numbered deep-interview reply into the structured GJC answer", () => {
		const result = answerFromWorkflowGateReply(deepInterviewGate, "1");

		expect(result).toEqual({ ok: true, answer: { selected: ["JWT"] } });
	});

	test("maps a numbered decision gate reply into the structured decision answer", () => {
		const result = answerFromWorkflowGateReply(decisionGate, "2");

		expect(result).toEqual({ ok: true, answer: { decision: "reject" } });
	});

	test("maps deep-interview free text and clarification replies into schema-shaped answers", () => {
		expect(answerFromWorkflowGateReply(deepInterviewGate, "Use SAML instead")).toEqual({
			ok: true,
			answer: { selected: [], other: true, custom: "Use SAML instead" },
		});
		expect(answerFromWorkflowGateReply(deepInterviewGate, "clarify: what is JWT?")).toEqual({
			ok: true,
			answer: { action: "clarify", question: "what is JWT?" },
		});
	});

	test("rejects out-of-range numbered workflow gate replies", () => {
		const result = answerFromWorkflowGateReply(deepInterviewGate, "9");

		expect(result).toMatchObject({
			ok: false,
			reason: "invalid_answer",
			errors: ["9 is not a valid workflow gate choice. Choose a number from 1 to 3."],
		});
	});

	test("accepts a valid answer and binds the next user message", () => {
		const store = new WorkflowGateStore();
		store.add(baseGate);

		const result = resolveWorkflowGateAnswer({
			store,
			answer: { decision: "approve", reason: "Looks good" },
			userMessageId: "user-msg-2",
		});

		expect(result.status).toBe("accepted");
		expect(store.list()[0]).toMatchObject({ status: "accepted", boundUserMessageId: "user-msg-2" });
	});

	test("rejects invalid answers while keeping the gate pending and unbound", () => {
		const store = new WorkflowGateStore();
		store.add(baseGate);

		const result = resolveWorkflowGateAnswer({
			store,
			answer: { decision: "maybe", reason: "" },
			userMessageId: "user-msg-2",
		});

		expect(result).toMatchObject({ status: "rejected", reason: "invalid_answer" });
		expect(store.list()[0]).toMatchObject({ status: "pending", boundUserMessageId: null });
	});

	test("rejects prototype-chain answers that only satisfy required fields through __proto__", () => {
		const store = new WorkflowGateStore();
		store.add(baseGate);
		const pollutedAnswer = JSON.parse('{"__proto__":{"decision":"approve","reason":"x"}}');

		const result = resolveWorkflowGateAnswer({
			store,
			answer: pollutedAnswer,
			userMessageId: "user-msg-2",
		});

		expect(result).toMatchObject({ status: "rejected", reason: "invalid_answer" });
		expect(store.pending()).toHaveLength(1);
	});

	test("validates root string enum gate schemas", () => {
		const store = new WorkflowGateStore();
		store.add({ ...baseGate, schema: { type: "string", enum: ["approve", "reject"] } });

		expect(resolveWorkflowGateAnswer({ store, answer: "approve", userMessageId: "user-msg-2" }).status).toBe(
			"accepted",
		);
	});

	test("rejects invalid root boolean gate answers", () => {
		const store = new WorkflowGateStore();
		store.add({ ...baseGate, schema: { type: "boolean" } });

		const result = resolveWorkflowGateAnswer({ store, answer: "true", userMessageId: "user-msg-2" });

		expect(result).toMatchObject({ status: "rejected", reason: "invalid_answer" });
		expect(store.pending()).toHaveLength(1);
	});

	test("rejects string answers longer than the advertised maxLength", () => {
		const store = new WorkflowGateStore();
		store.add({
			...baseGate,
			schema: {
				type: "object",
				required: ["reason"],
				additionalProperties: false,
				properties: { reason: { type: "string", maxLength: 5 } },
			},
		});

		const result = resolveWorkflowGateAnswer({
			store,
			answer: { reason: "too long" },
			userMessageId: "user-msg-2",
		});

		expect(result).toMatchObject({ status: "rejected", reason: "invalid_answer" });
		expect(store.pending()).toHaveLength(1);
	});

	test("validates root null gate answers from chat replies", () => {
		const result = answerFromWorkflowGateReply({ ...baseGate, schema: { type: "null" } }, "null");

		expect(result).toEqual({ ok: true, answer: null });
	});

	test("validates schema-valued additional properties", () => {
		const gate: PendingWorkflowGate = {
			...baseGate,
			schema: {
				type: "object",
				required: ["decision"],
				properties: { decision: { type: "string", enum: ["approve", "reject"] } },
				additionalProperties: { type: "null" },
			},
		};
		const accepted = new WorkflowGateStore();
		accepted.add(gate);
		const rejected = new WorkflowGateStore();
		rejected.add(gate);

		expect(
			resolveWorkflowGateAnswer({
				store: accepted,
				answer: { decision: "approve", expiresAt: null },
				userMessageId: "user-msg-2",
			}).status,
		).toBe("accepted");
		expect(
			resolveWorkflowGateAnswer({
				store: rejected,
				answer: { decision: "approve", expiresAt: "tomorrow" },
				userMessageId: "user-msg-2",
			}),
		).toMatchObject({ status: "rejected", reason: "invalid_answer" });
	});

	test("projects pending gates as assistant-visible messages", () => {
		const message = projectPendingWorkflowGateMessage({
			...baseGate,
			schema: { type: "string", enum: ["approve", "reject"] },
		});

		expect(message).toContain("GJC workflow gate pending");
		expect(message).toContain("approve");
		expect(message).toContain("gate-1");
	});

	test("rejects ambiguous multiple pending gates without binding either gate", () => {
		const store = new WorkflowGateStore();
		store.add(baseGate);
		store.add({ ...baseGate, gateId: "gate-2", idempotencyKey: "idem-2" });

		const result = resolveWorkflowGateAnswer({
			store,
			answer: { decision: "approve", reason: "Looks good" },
			userMessageId: "user-msg-2",
		});

		expect(result).toEqual({ status: "rejected", reason: "ambiguous_pending_gate" });
		expect(store.pending()).toHaveLength(2);
		expect(store.pending().map(gate => gate.boundUserMessageId)).toEqual([null, null]);
	});
});
