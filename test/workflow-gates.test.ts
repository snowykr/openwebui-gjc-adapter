import { describe, expect, test } from "bun:test";
import {
	type PendingWorkflowGate,
	projectPendingWorkflowGateMessage,
	resolveWorkflowGateAnswer,
	WorkflowGateStore,
} from "../src/projection/workflow-gates";

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
