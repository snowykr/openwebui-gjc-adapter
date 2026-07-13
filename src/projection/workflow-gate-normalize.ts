import { jsonObjectFromUnknown, jsonValueFromUnknown, schemaFromUnknown } from "./workflow-gate-schema";
import type { PendingWorkflowGate, WorkflowGateOption, WorkflowGateStatus } from "./workflow-gate-types";

export function pendingWorkflowGateFromEvent(event: {
	readonly id?: string;
	readonly payload?: Readonly<Record<string, unknown>>;
}): PendingWorkflowGate | null {
	const payload = event.payload;
	if (payload === undefined) return null;
	const gateId = stringField(payload, "gateId") ?? stringField(payload, "gate_id") ?? event.id;
	if (gateId === undefined) return null;
	const schemaHash = stringField(payload, "schemaHash") ?? stringField(payload, "schema_hash") ?? "unknown";
	const stage = stringField(payload, "stage");
	const kind = stringField(payload, "kind");
	const options = optionsFromUnknown(payload.options);
	const context = jsonObjectFromUnknown(payload.context);
	const createdAt = stringField(payload, "createdAt") ?? stringField(payload, "created_at");
	const required = booleanField(payload, "required");
	const commandId = stringField(payload, "commandId");
	const turnId = stringField(payload, "turnId");
	const sessionId = stringField(payload, "sessionId");
	const hasCompleteCorrelation = commandId !== undefined && turnId !== undefined && sessionId !== undefined;
	return {
		gateId,
		...(stage === undefined ? {} : { stage }),
		...(kind === undefined ? {} : { kind }),
		schemaHash,
		idempotencyKey:
			stringField(payload, "idempotencyKey") ?? stringField(payload, "idempotency_key") ?? `${gateId}:${schemaHash}`,
		boundUserMessageId: null,
		status: workflowGateStatusFromUnknown(payload.status) ?? "pending",
		schema: schemaFromUnknown(payload.schema) ?? { type: "string" },
		...(options === undefined ? {} : { options }),
		...(context === undefined ? {} : { context }),
		...(createdAt === undefined ? {} : { createdAt }),
		...(required === undefined ? {} : { required }),
		...(hasCompleteCorrelation ? { commandId, turnId, sessionId } : {}),
	};
}

function optionsFromUnknown(value: unknown): readonly WorkflowGateOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const options: WorkflowGateOption[] = [];
	for (const item of value) {
		if (!isUnknownRecord(item)) continue;
		const label = stringField(item, "label");
		const optionValue = jsonValueFromUnknown(item.value);
		if (label === undefined || optionValue === undefined) continue;
		const description = stringField(item, "description");
		options.push({
			label,
			value: optionValue,
			...(description === undefined ? {} : { description }),
		});
	}
	return options.length === 0 ? undefined : options;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function booleanField(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function workflowGateStatusFromUnknown(value: unknown): WorkflowGateStatus | undefined {
	return value === "pending" || value === "accepted" || value === "rejected" ? value : undefined;
}
