import type { JsonValue, WorkflowGateSchema } from "./workflow-gate-types";

export function jsonValueFromReply(trimmed: string): JsonValue | undefined {
	if (!isJsonReply(trimmed)) return undefined;
	try {
		return jsonValueFromUnknown(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

export function jsonValueFromUnknown(value: unknown): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) return jsonArrayFromUnknown(value);
	if (isUnknownRecord(value)) return jsonObjectFromUnknown(value);
	return undefined;
}

export function jsonObjectFromUnknown(value: unknown): { readonly [key: string]: JsonValue } | undefined {
	if (!isUnknownRecord(value)) return undefined;
	const object: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
	for (const [key, rawValue] of Object.entries(value)) {
		if (isUnsafeObjectKey(key)) continue;
		const jsonValue = jsonValueFromUnknown(rawValue);
		if (jsonValue !== undefined) object[key] = jsonValue;
	}
	return object;
}

export function schemaFromUnknown(value: unknown): WorkflowGateSchema | undefined {
	if (!isUnknownRecord(value)) return undefined;
	const type = workflowSchemaTypeFromUnknown(value.type);
	const enumValues = jsonArrayFromUnknown(value.enum);
	const constValue = jsonValueFromUnknown(value.const);
	const title = stringFromUnknown(value.title);
	const description = stringFromUnknown(value.description);
	const minLength = nonNegativeIntegerFromUnknown(value.minLength);
	const maxLength = nonNegativeIntegerFromUnknown(value.maxLength);
	const pattern = stringFromUnknown(value.pattern);
	const minimum = finiteNumberFromUnknown(value.minimum);
	const maximum = finiteNumberFromUnknown(value.maximum);
	const required = stringArrayFromUnknown(value.required);
	const additionalProperties = additionalPropertiesFromUnknown(value.additionalProperties);
	const minItems = nonNegativeIntegerFromUnknown(value.minItems);
	const maxItems = nonNegativeIntegerFromUnknown(value.maxItems);
	const uniqueItems = booleanFromUnknown(value.uniqueItems);
	const items = schemaFromUnknown(value.items);
	const anyOf = schemaArrayFromUnknown(value.anyOf);
	const oneOf = schemaArrayFromUnknown(value.oneOf);
	const properties = schemaRecordFromUnknown(value.properties);
	return {
		...(type === undefined ? {} : { type }),
		...(enumValues === undefined ? {} : { enum: enumValues }),
		...(constValue === undefined ? {} : { const: constValue }),
		...(title === undefined ? {} : { title }),
		...(description === undefined ? {} : { description }),
		...(minLength === undefined ? {} : { minLength }),
		...(maxLength === undefined ? {} : { maxLength }),
		...(pattern === undefined ? {} : { pattern }),
		...(minimum === undefined ? {} : { minimum }),
		...(maximum === undefined ? {} : { maximum }),
		...(required === undefined ? {} : { required }),
		...(additionalProperties === undefined ? {} : { additionalProperties }),
		...(minItems === undefined ? {} : { minItems }),
		...(maxItems === undefined ? {} : { maxItems }),
		...(uniqueItems === undefined ? {} : { uniqueItems }),
		...(items === undefined ? {} : { items }),
		...(anyOf === undefined ? {} : { anyOf }),
		...(oneOf === undefined ? {} : { oneOf }),
		...(properties === undefined ? {} : { properties }),
	};
}

function schemaRecordFromUnknown(value: unknown): Record<string, WorkflowGateSchema> | undefined {
	if (!isUnknownRecord(value)) return undefined;
	const properties: Record<string, WorkflowGateSchema> = Object.create(null) as Record<string, WorkflowGateSchema>;
	for (const [key, rawSchema] of Object.entries(value)) {
		if (isUnsafeObjectKey(key)) continue;
		const schema = schemaFromUnknown(rawSchema);
		if (schema !== undefined) properties[key] = schema;
	}
	return Object.keys(properties).length === 0 ? undefined : properties;
}

function schemaArrayFromUnknown(value: unknown): readonly WorkflowGateSchema[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const schemas = value.map(schemaFromUnknown).filter(schema => schema !== undefined);
	return schemas.length === 0 ? undefined : schemas;
}

function jsonArrayFromUnknown(value: unknown): readonly JsonValue[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value.map(jsonValueFromUnknown).filter(item => item !== undefined);
	return values.length === value.length ? values : undefined;
}

function additionalPropertiesFromUnknown(value: unknown): boolean | WorkflowGateSchema | undefined {
	const booleanValue = booleanFromUnknown(value);
	if (booleanValue !== undefined) return booleanValue;
	return schemaFromUnknown(value);
}

function isJsonReply(trimmed: string): boolean {
	return (
		trimmed.startsWith("{") ||
		trimmed.startsWith("[") ||
		trimmed === "true" ||
		trimmed === "false" ||
		trimmed === "null"
	);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanFromUnknown(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function finiteNumberFromUnknown(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeIntegerFromUnknown(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringArrayFromUnknown(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function workflowSchemaTypeFromUnknown(value: unknown): WorkflowGateSchema["type"] | undefined {
	if (
		value === "string" ||
		value === "boolean" ||
		value === "number" ||
		value === "integer" ||
		value === "object" ||
		value === "array" ||
		value === "null"
	) {
		return value;
	}
	return undefined;
}

function isUnsafeObjectKey(key: string): boolean {
	return key === "__proto__" || key === "prototype" || key === "constructor";
}
