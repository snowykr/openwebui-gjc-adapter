import type { JsonValue, WorkflowGateAnswer, WorkflowGateSchema } from "./workflow-gate-types";

export {
	jsonObjectFromUnknown,
	jsonValueFromReply,
	jsonValueFromUnknown,
	schemaFromUnknown,
} from "./workflow-gate-schema-parse";

export function validateWorkflowGateAnswer(schema: WorkflowGateSchema, answer: WorkflowGateAnswer): readonly string[] {
	return validateSchema(schema, answer, "answer");
}

function validateSchema(schema: WorkflowGateSchema, value: WorkflowGateAnswer, path: string): readonly string[] {
	if (schema.anyOf !== undefined) return validateCompositeSchema(schema.anyOf, value, path, "any");
	if (schema.oneOf !== undefined) return validateCompositeSchema(schema.oneOf, value, path, "one");

	const errors: string[] = [];
	if (schema.const !== undefined && !jsonEquals(schema.const, value)) {
		errors.push(`${path} must equal ${String(schema.const)}`);
	}
	if (schema.enum !== undefined && !schema.enum.some(option => jsonEquals(option, value))) {
		errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
	}

	if (schema.type === undefined) {
		if (schema.required !== undefined || schema.properties !== undefined)
			validateObjectSchema(schema, value, path, errors);
		return errors;
	}

	switch (schema.type) {
		case "string":
			validateStringSchema(schema, value, path, errors);
			break;
		case "null":
			if (value !== null) errors.push(`${path} must be null`);
			break;
		case "boolean":
			if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) {
				errors.push(`${path} must be a finite number`);
				break;
			}
			validateNumericRange(schema, value, path, errors);
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) {
				errors.push(`${path} must be an integer`);
				break;
			}
			validateNumericRange(schema, value, path, errors);
			break;
		case "object":
			validateObjectSchema(schema, value, path, errors);
			break;
		case "array":
			validateArraySchema(schema, value, path, errors);
			break;
	}

	return errors;
}

function validateStringSchema(
	schema: WorkflowGateSchema,
	value: WorkflowGateAnswer,
	path: string,
	errors: string[],
): void {
	if (typeof value !== "string" || value.length === 0) {
		errors.push(`${path} must be a non-empty string`);
		return;
	}
	if (schema.minLength !== undefined && value.length < schema.minLength) {
		errors.push(`${path} must contain at least ${schema.minLength} character(s)`);
	}
	if (schema.maxLength !== undefined && value.length > schema.maxLength) {
		errors.push(`${path} must contain at most ${schema.maxLength} character(s)`);
	}
	if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
		errors.push(`${path} must match pattern ${schema.pattern}`);
	}
}

function validateCompositeSchema(
	schemas: readonly WorkflowGateSchema[],
	value: WorkflowGateAnswer,
	path: string,
	mode: "any" | "one",
): readonly string[] {
	let matchCount = 0;
	for (const candidate of schemas) {
		if (validateSchema(candidate, value, path).length === 0) matchCount++;
	}
	if (mode === "any" && matchCount > 0) return [];
	if (mode === "one" && matchCount === 1) return [];
	return [`${path} does not match ${mode === "any" ? "any" : "exactly one"} allowed workflow gate answer shape`];
}

function validateObjectSchema(
	schema: WorkflowGateSchema,
	value: WorkflowGateAnswer,
	path: string,
	errors: string[],
): void {
	if (!isJsonObject(value)) {
		errors.push(`${path} must be an object`);
		return;
	}

	for (const key of schema.required ?? []) {
		if (!Object.hasOwn(value, key)) {
			errors.push(`${path}.${key} is required`);
			continue;
		}
		const property = schema.properties?.[key];
		if (property !== undefined) errors.push(...validateSchema(property, value[key] ?? null, `${path}.${key}`));
	}

	for (const [key, property] of Object.entries(schema.properties ?? {})) {
		if ((schema.required ?? []).includes(key) || !Object.hasOwn(value, key)) continue;
		errors.push(...validateSchema(property, value[key] ?? null, `${path}.${key}`));
	}

	if (schema.additionalProperties === false) {
		for (const key of Object.keys(value)) {
			if (schema.properties?.[key] === undefined) errors.push(`${path}.${key} is not allowed`);
		}
	} else if (isSchemaValue(schema.additionalProperties)) {
		for (const key of Object.keys(value)) {
			if (schema.properties?.[key] !== undefined) continue;
			errors.push(...validateSchema(schema.additionalProperties, value[key] ?? null, `${path}.${key}`));
		}
	}
}

function validateNumericRange(schema: WorkflowGateSchema, value: number, path: string, errors: string[]): void {
	if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
	if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
}

function validateArraySchema(
	schema: WorkflowGateSchema,
	value: WorkflowGateAnswer,
	path: string,
	errors: string[],
): void {
	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array`);
		return;
	}
	if (schema.minItems !== undefined && value.length < schema.minItems) {
		errors.push(`${path} must contain at least ${schema.minItems} item(s)`);
	}
	if (schema.maxItems !== undefined && value.length > schema.maxItems) {
		errors.push(`${path} must contain at most ${schema.maxItems} item(s)`);
	}
	if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) {
		errors.push(`${path} must contain unique items`);
	}
	if (schema.items !== undefined) {
		for (const [index, item] of value.entries()) {
			errors.push(...validateSchema(schema.items, item, `${path}[${index}]`));
		}
	}
}

function isJsonObject(value: WorkflowGateAnswer): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaValue(value: WorkflowGateSchema["additionalProperties"]): value is WorkflowGateSchema {
	return typeof value === "object" && value !== null;
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
