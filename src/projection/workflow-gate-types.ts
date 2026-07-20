export type WorkflowGateStatus = "pending" | "accepted" | "rejected";
export type WorkflowGateStage = "deep-interview" | "ralplan" | "ultragoal" | string;
export type WorkflowGateKind = "question" | "approval" | "execution" | string;

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type WorkflowGateAnswer = JsonValue;

export interface WorkflowGateSchema {
	readonly type?: "string" | "boolean" | "number" | "integer" | "object" | "array" | "null";
	readonly enum?: readonly JsonValue[];
	readonly const?: JsonValue;
	readonly title?: string;
	readonly description?: string;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly required?: readonly string[];
	readonly properties?: Record<string, WorkflowGateSchema>;
	readonly additionalProperties?: boolean | WorkflowGateSchema;
	readonly items?: WorkflowGateSchema;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly uniqueItems?: boolean;
	readonly anyOf?: readonly WorkflowGateSchema[];
	readonly oneOf?: readonly WorkflowGateSchema[];
}

export type WorkflowGatePropertySchema = WorkflowGateSchema;

export interface WorkflowGateOption {
	readonly value: JsonValue;
	readonly label: string;
	readonly description?: string;
}

export interface PendingWorkflowGate {
	readonly gateId: string;
	readonly stage?: WorkflowGateStage;
	readonly kind?: WorkflowGateKind;
	readonly schemaHash: string;
	readonly idempotencyKey: string;
	readonly boundUserMessageId: string | null;
	readonly status: WorkflowGateStatus;
	readonly schema: WorkflowGateSchema;
	readonly options?: readonly WorkflowGateOption[];
	readonly context?: JsonObject;
	readonly createdAt?: string;
	readonly required?: boolean;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly sessionId?: string;
}

export type WorkflowGateResolution =
	| { readonly status: "accepted"; readonly gate: PendingWorkflowGate }
	| {
			readonly status: "rejected";
			readonly reason: "no_pending_gate" | "ambiguous_pending_gate" | "invalid_answer";
			readonly gate?: PendingWorkflowGate;
			readonly errors?: readonly string[];
	  };

export type WorkflowGateReplyResolution =
	| { readonly ok: true; readonly answer: WorkflowGateAnswer }
	| { readonly ok: false; readonly reason: "invalid_answer"; readonly errors: readonly string[] };
