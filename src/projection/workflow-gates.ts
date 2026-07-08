export type WorkflowGateStatus = "pending" | "accepted" | "rejected";

export interface PendingWorkflowGate {
	readonly gateId: string;
	readonly schemaHash: string;
	readonly idempotencyKey: string;
	readonly boundUserMessageId: string | null;
	readonly status: WorkflowGateStatus;
	readonly schema: WorkflowGateSchema;
}

export type WorkflowGateSchema =
	| {
			readonly type?: "object";
			readonly required?: readonly string[];
			readonly properties?: Record<string, WorkflowGatePropertySchema>;
			readonly enum?: readonly JsonValue[];
	  }
	| WorkflowGatePropertySchema;

export interface WorkflowGatePropertySchema {
	readonly type?: "string" | "boolean" | "number" | "integer" | "object";
	readonly enum?: readonly JsonValue[];
	readonly required?: readonly string[];
	readonly properties?: Record<string, WorkflowGatePropertySchema>;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type WorkflowGateAnswer = JsonValue;

export type WorkflowGateResolution =
	| { readonly status: "accepted"; readonly gate: PendingWorkflowGate }
	| {
			readonly status: "rejected";
			readonly reason: "no_pending_gate" | "ambiguous_pending_gate" | "invalid_answer";
			readonly gate?: PendingWorkflowGate;
			readonly errors?: readonly string[];
	  };

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
	return [
		"### GJC workflow gate pending",
		"",
		prompt,
		"",
		`Gate ID: ${gate.gateId}`,
		`Schema hash: ${gate.schemaHash}`,
		"",
		"Reply with the requested approval, rejection, or answer to continue this GJC session.",
	].join("\n");
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

function validateWorkflowGateAnswer(schema: WorkflowGateSchema, answer: WorkflowGateAnswer): readonly string[] {
	return validateSchema(schema, answer, "answer");
}

function validateSchema(schema: WorkflowGateSchema, value: WorkflowGateAnswer, path: string): readonly string[] {
	const errors: string[] = [];
	if (schema.enum !== undefined && !schema.enum.some(option => jsonEquals(option, value))) {
		errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
	}

	if (schema.type === undefined) {
		if ("required" in schema || "properties" in schema) validateObjectSchema(schema, value, path, errors);
		return errors;
	}

	switch (schema.type) {
		case "string":
			if (typeof value !== "string" || value.length === 0) errors.push(`${path} must be a non-empty string`);
			break;
		case "boolean":
			if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path} must be a finite number`);
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path} must be an integer`);
			break;
		case "object":
			validateObjectSchema(schema, value, path, errors);
			break;
	}

	return errors;
}

function validateObjectSchema(
	schema: WorkflowGateSchema,
	value: WorkflowGateAnswer,
	path: string,
	errors: string[],
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}

	for (const key of schema.required ?? []) {
		if (!(key in value)) {
			errors.push(`${path}.${key} is required`);
			continue;
		}
		const property = schema.properties?.[key];
		if (property !== undefined)
			errors.push(...validateSchema(property, value[key] as WorkflowGateAnswer, `${path}.${key}`));
	}

	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		if ((schema.required ?? []).includes(key) || !(key in value)) continue;
		errors.push(...validateSchema(property, value[key] as WorkflowGateAnswer, `${path}.${key}`));
	}
}

function gatePrompt(gate: PendingWorkflowGate): string {
	const schema = gate.schema;
	if (schema.enum !== undefined) return `Choose one of: ${schema.enum.map(String).join(", ")}`;
	if (schema.type === "boolean") return "Answer true/false for this approval gate.";
	if (schema.type === "string") return "Answer with the requested text for this workflow gate.";
	return "Answer this workflow gate using the requested structured values.";
}

function isRecord(value: WorkflowGateAnswer): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
