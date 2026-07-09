import type { PendingWorkflowGate } from "../src/projection/workflow-gates";

export const deepInterviewGate: PendingWorkflowGate = {
	gateId: "gate-deep-1",
	stage: "deep-interview",
	kind: "question",
	schemaHash: "sha256:deep",
	idempotencyKey: "idem-deep-1",
	boundUserMessageId: null,
	status: "pending",
	context: { prompt: "Choose authentication method" },
	options: [
		{ label: "JWT", value: "JWT" },
		{ label: "OAuth2", value: "OAuth2" },
		{ label: "Session cookies", value: "Session cookies" },
	],
	schema: {
		type: "object",
		required: ["selected"],
		additionalProperties: false,
		properties: {
			selected: {
				type: "array",
				minItems: 1,
				items: { type: "string", enum: ["JWT", "OAuth2", "Session cookies"] },
			},
			other: { type: "boolean" },
			custom: { type: "string", minLength: 1, pattern: "\\S" },
			action: { type: "string", enum: ["answer", "clarify"] },
			question: { type: "string", minLength: 1, pattern: "\\S" },
		},
		anyOf: [
			{
				type: "object",
				required: ["selected"],
				additionalProperties: false,
				properties: {
					selected: {
						type: "array",
						minItems: 1,
						maxItems: 1,
						items: { type: "string", enum: ["JWT", "OAuth2", "Session cookies"] },
					},
				},
			},
			{
				type: "object",
				required: ["selected", "other", "custom"],
				additionalProperties: false,
				properties: {
					selected: {
						type: "array",
						maxItems: 0,
						items: { type: "string", enum: ["JWT", "OAuth2", "Session cookies"] },
					},
					other: { const: true },
					custom: { type: "string", minLength: 1, pattern: "\\S" },
				},
			},
			{
				type: "object",
				required: ["action", "question"],
				additionalProperties: false,
				properties: {
					action: { const: "clarify" },
					question: { type: "string", minLength: 1, pattern: "\\S" },
				},
			},
		],
	},
};

export const decisionGate: PendingWorkflowGate = {
	gateId: "gate-plan-1",
	stage: "ralplan",
	kind: "approval",
	schemaHash: "sha256:decision",
	idempotencyKey: "idem-plan-1",
	boundUserMessageId: null,
	status: "pending",
	context: { prompt: "Approve this plan?" },
	options: [
		{ label: "Approve", value: "approve" },
		{ label: "Reject", value: "reject" },
	],
	schema: {
		type: "object",
		required: ["decision"],
		additionalProperties: false,
		properties: {
			decision: { type: "string", enum: ["approve", "reject"] },
		},
	},
};
