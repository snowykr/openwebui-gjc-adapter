import { jsonValueFromReply, validateWorkflowGateAnswer } from "./workflow-gate-schema";
import type {
	JsonObject,
	PendingWorkflowGate,
	WorkflowGateAnswer,
	WorkflowGateOption,
	WorkflowGateReplyResolution,
	WorkflowGateResolution,
	WorkflowGateSchema,
} from "./workflow-gate-types";

export { pendingWorkflowGateFromEvent } from "./workflow-gate-normalize";
export type {
	JsonObject,
	JsonValue,
	PendingWorkflowGate,
	WorkflowGateAnswer,
	WorkflowGateKind,
	WorkflowGateOption,
	WorkflowGatePropertySchema,
	WorkflowGateReplyResolution,
	WorkflowGateResolution,
	WorkflowGateSchema,
	WorkflowGateStage,
	WorkflowGateStatus,
} from "./workflow-gate-types";

export class WorkflowGateStore {
	readonly #gates: PendingWorkflowGate[] = [];

	add(gate: PendingWorkflowGate): void {
		const existingIndex = this.#gates.findIndex(item => item.idempotencyKey === gate.idempotencyKey);
		if (existingIndex >= 0) {
			this.#gates[existingIndex] = gate;
			return;
		}
		this.#gates.push(gate);
	}

	list(): readonly PendingWorkflowGate[] {
		return [...this.#gates];
	}

	pending(): readonly PendingWorkflowGate[] {
		return this.#gates.filter(gate => gate.status === "pending");
	}

	update(updated: PendingWorkflowGate): void {
		const index = this.#gates.findIndex(gate => gate.gateId === updated.gateId);
		if (index >= 0) this.#gates[index] = updated;
	}
}

export function projectPendingWorkflowGateMessage(gate: PendingWorkflowGate): string {
	const prompt = gatePrompt(gate);
	const options = gate.options ?? [];
	const optionLines = options.map((option, index) => {
		const description = option.description === undefined ? "" : ` - ${option.description}`;
		return `${index + 1}. ${stripLeadingChoiceNumber(option.label)}${description}`;
	});
	const answerHint =
		options.length > 0
			? `Reply with a number from 1 to ${options.length} to continue this GJC session.`
			: "Reply with the requested approval, rejection, or answer to continue this GJC session.";
	return [
		"### GJC workflow gate pending",
		"",
		prompt,
		...(optionLines.length === 0 ? [] : ["", ...optionLines]),
		"",
		`Gate ID: ${gate.gateId}`,
		`Schema hash: ${gate.schemaHash}`,
		"",
		answerHint,
	].join("\n");
}

export function answerFromWorkflowGateReply(gate: PendingWorkflowGate, replyText: string): WorkflowGateReplyResolution {
	const trimmed = replyText.trim();
	const options = gate.options ?? [];
	if (options.length > 0) return answerFromChoice(gate, options, trimmed);

	const parsedJson = jsonValueFromReply(trimmed);
	const answer = parsedJson === undefined ? primitiveAnswerFromReply(gate.schema, trimmed) : parsedJson;
	const errors = validateWorkflowGateAnswer(gate.schema, answer);
	if (errors.length > 0) return { ok: false, reason: "invalid_answer", errors };
	return { ok: true, answer };
}

export function resolveWorkflowGateAnswer(input: {
	readonly store: WorkflowGateStore;
	readonly answer: WorkflowGateAnswer;
	readonly userMessageId: string;
}): WorkflowGateResolution {
	const pending = input.store.pending();
	if (pending.length === 0) return { status: "rejected", reason: "no_pending_gate" };
	if (pending.length > 1) return { status: "rejected", reason: "ambiguous_pending_gate" };

	const gate = pending[0];
	if (gate === undefined) return { status: "rejected", reason: "no_pending_gate" };
	const errors = validateWorkflowGateAnswer(gate.schema, input.answer);
	if (errors.length > 0) return { status: "rejected", reason: "invalid_answer", gate, errors };

	const accepted: PendingWorkflowGate = { ...gate, status: "accepted", boundUserMessageId: input.userMessageId };
	input.store.update(accepted);
	return { status: "accepted", gate: accepted };
}

function answerFromChoice(
	gate: PendingWorkflowGate,
	options: readonly WorkflowGateOption[],
	trimmed: string,
): WorkflowGateReplyResolution {
	const selectedOption = optionFromReply(options, trimmed);
	if (selectedOption !== null) return { ok: true, answer: answerFromOption(gate, selectedOption) };
	if (!/^\d+$/.test(trimmed)) {
		const schemaAnswer = nonChoiceAnswerFromOptionGate(gate, trimmed);
		if (schemaAnswer !== null) return schemaAnswer;
	}
	return {
		ok: false,
		reason: "invalid_answer",
		errors: [`${trimmed} is not a valid workflow gate choice. Choose a number from 1 to ${options.length}.`],
	};
}

function nonChoiceAnswerFromOptionGate(gate: PendingWorkflowGate, trimmed: string): WorkflowGateReplyResolution | null {
	const clarifyQuestion = clarifyQuestionFromReply(trimmed);
	const candidate =
		clarifyQuestion === null
			? deepInterviewOtherAnswer(gate, trimmed)
			: ({ action: "clarify", question: clarifyQuestion } satisfies WorkflowGateAnswer);
	if (candidate === null) return null;
	const errors = validateWorkflowGateAnswer(gate.schema, candidate);
	return errors.length === 0 ? { ok: true, answer: candidate } : null;
}

function deepInterviewOtherAnswer(gate: PendingWorkflowGate, trimmed: string): WorkflowGateAnswer | null {
	if (!isSelectedArraySchema(gate.schema) || trimmed.length === 0) return null;
	return { selected: [], other: true, custom: trimmed };
}

function clarifyQuestionFromReply(trimmed: string): string | null {
	const match = /^clarify:\s*(.+)$/iu.exec(trimmed);
	const question = match?.[1]?.trim();
	return question === undefined || question.length === 0 ? null : question;
}

function gatePrompt(gate: PendingWorkflowGate): string {
	const prompt = stringJsonField(gate.context, "prompt") ?? stringJsonField(gate.context, "title");
	if (prompt !== undefined) return prompt;
	const schema = gate.schema;
	if (schema.enum !== undefined) return `Choose one of: ${schema.enum.map(String).join(", ")}`;
	if (schema.type === "boolean") return "Answer true/false for this approval gate.";
	if (schema.type === "string") return "Answer with the requested text for this workflow gate.";
	return "Answer this workflow gate using the requested structured values.";
}

function optionFromReply(options: readonly WorkflowGateOption[], trimmed: string): WorkflowGateOption | null {
	if (/^\d+$/.test(trimmed)) {
		const index = Number.parseInt(trimmed, 10) - 1;
		return options[index] ?? null;
	}
	for (const option of options) {
		if (option.label === trimmed || String(option.value) === trimmed) return option;
	}
	return null;
}

function answerFromOption(gate: PendingWorkflowGate, option: WorkflowGateOption): WorkflowGateAnswer {
	if (isSelectedArraySchema(gate.schema)) return { selected: [String(option.value)] };
	const singlePropertyAnswer = singleRequiredPropertyAnswer(gate.schema, option.value);
	if (singlePropertyAnswer !== null) return singlePropertyAnswer;
	return option.value;
}

function isSelectedArraySchema(schema: WorkflowGateSchema): boolean {
	return schema.type === "object" && schema.properties?.selected?.type === "array";
}

function singleRequiredPropertyAnswer(
	schema: WorkflowGateSchema,
	value: WorkflowGateAnswer,
): WorkflowGateAnswer | null {
	if (schema.type !== "object" || schema.required?.length !== 1) return null;
	const key = schema.required[0];
	if (key === undefined || schema.properties?.[key] === undefined) return null;
	const answer = { [key]: value };
	return validateWorkflowGateAnswer(schema, answer).length === 0 ? answer : null;
}

function primitiveAnswerFromReply(schema: WorkflowGateSchema, trimmed: string): WorkflowGateAnswer {
	if (schema.type === "boolean") return trimmed === "true" ? true : trimmed === "false" ? false : trimmed;
	if (schema.type === "number" || schema.type === "integer") {
		const numeric = Number(trimmed);
		return Number.isFinite(numeric) ? numeric : trimmed;
	}
	return trimmed;
}

function stringJsonField(record: JsonObject | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function stripLeadingChoiceNumber(label: string): string {
	return label.replace(/^\s*\d+[.)]\s+/, "");
}
