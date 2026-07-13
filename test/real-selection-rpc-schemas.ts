import type { NormalizedModelSelection } from "../src/contracts";
import { decodeStrictModelCatalog, formatCanonicalModelId } from "../src/live/models";

export type RpcPayload = Record<string, unknown> & { readonly type: string };
export type RpcRequest = RpcPayload & { readonly id: string };

const COMMANDS = [
	"get_available_models",
	"get_state",
	"set_default_model_selection",
	"new_session",
	"switch_session",
	"prompt",
	"workflow_gate_response",
	"get_last_assistant_text",
] as const;
type Command = (typeof COMMANDS)[number];

export function parseRpcRequest(value: unknown): RpcRequest {
	if (!isRecord(value)) throw new TypeError("invalid RPC request");
	const id = Reflect.get(value, "id");
	const type = Reflect.get(value, "type");
	if (typeof id !== "string" || !isCommand(type)) throw new TypeError("invalid RPC request fields");
	if (type === "set_default_model_selection") parseSelection(value);
	if (type === "prompt" && typeof Reflect.get(value, "message") !== "string")
		throw new TypeError("invalid prompt request");
	if (type === "switch_session" && typeof Reflect.get(value, "sessionPath") !== "string") {
		throw new TypeError("invalid switch session request");
	}
	if (
		type === "workflow_gate_response" &&
		(typeof Reflect.get(value, "gate_id") !== "string" || !Reflect.has(value, "answer"))
	) {
		throw new TypeError("invalid gate response request");
	}
	return { ...value, id, type };
}

export function parseRpcOutput(value: Record<string, unknown>): void {
	if (Reflect.get(value, "type") === "workflow_gate") return parseGate(value);
	const id = Reflect.get(value, "id");
	const command = Reflect.get(value, "command");
	const success = Reflect.get(value, "success");
	if (Reflect.get(value, "type") !== "response" || typeof id !== "string" || !isCommand(command)) {
		throw new TypeError("invalid RPC response");
	}
	if (typeof success !== "boolean") throw new TypeError("invalid RPC response");
	if (!success) {
		const error = Reflect.get(value, "error");
		if (!isRecord(error) || typeof Reflect.get(error, "message") !== "string")
			throw new TypeError("invalid RPC failure");
		return;
	}
	validateSuccess(command, Reflect.get(value, "data"));
}

function validateSuccess(command: Command, data: unknown): void {
	if (command === "prompt") return;
	if (!isRecord(data)) throw new TypeError("invalid RPC response data");
	if (command === "get_available_models") {
		if (decodeStrictModelCatalog(Reflect.get(data, "models")) === null) throw new TypeError("invalid model response");
		return;
	}
	if (command === "get_state") {
		const model = Reflect.get(data, "model");
		const level = Reflect.get(data, "thinkingLevel");
		if (
			!isRecord(model) ||
			typeof Reflect.get(model, "provider") !== "string" ||
			typeof Reflect.get(model, "id") !== "string" ||
			(level !== "off" && level !== "low" && level !== "medium") ||
			typeof Reflect.get(data, "sessionId") !== "string" ||
			!Number.isSafeInteger(Reflect.get(data, "messageCount")) ||
			Number(Reflect.get(data, "messageCount")) < 0
		)
			throw new TypeError("invalid state response");
		parseSelection({
			provider: Reflect.get(model, "provider"),
			modelId: Reflect.get(model, "id"),
			thinkingLevel: level,
		});
		return;
	}
	if (command === "set_default_model_selection") return void parseSelection(data);
	if (command === "new_session" || command === "switch_session") {
		if (typeof Reflect.get(data, "cancelled") !== "boolean") throw new TypeError("invalid session response");
		return;
	}
	if (command === "get_last_assistant_text") {
		const text = Reflect.get(data, "text");
		if (text !== null && typeof text !== "string") throw new TypeError("invalid assistant response");
		return;
	}
	validateGateResolution(data);
}

function validateGateResolution(data: Record<string, unknown>): void {
	const status = Reflect.get(data, "status");
	const resolvedAt = Reflect.get(data, "resolved_at");
	if (
		typeof Reflect.get(data, "gate_id") !== "string" ||
		(status !== "accepted" && status !== "rejected") ||
		typeof Reflect.get(data, "answer_hash") !== "string" ||
		typeof resolvedAt !== "string" ||
		!Number.isFinite(Date.parse(resolvedAt))
	)
		throw new TypeError("invalid gate response");
	if (status === "rejected" && !isGateResolutionError(Reflect.get(data, "error"))) {
		throw new TypeError("invalid rejected gate response");
	}
}

function isGateResolutionError(value: unknown): boolean {
	if (!isRecord(value) || typeof Reflect.get(value, "code") !== "string") return false;
	const errors = Reflect.get(value, "errors");
	return (
		errors === undefined ||
		(Array.isArray(errors) &&
			errors.every(
				error =>
					isRecord(error) &&
					typeof Reflect.get(error, "path") === "string" &&
					typeof Reflect.get(error, "keyword") === "string" &&
					typeof Reflect.get(error, "message") === "string",
			))
	);
}

function parseSelection(value: Record<string, unknown>): NormalizedModelSelection {
	const provider = Reflect.get(value, "provider");
	const modelId = Reflect.get(value, "modelId");
	const thinkingLevel = Reflect.get(value, "thinkingLevel");
	if (
		typeof provider !== "string" ||
		typeof modelId !== "string" ||
		(thinkingLevel !== "off" && thinkingLevel !== "low" && thinkingLevel !== "medium")
	)
		throw new TypeError("invalid selection");
	const selection: NormalizedModelSelection = { provider, modelId, thinkingLevel };
	formatCanonicalModelId(selection);
	return selection;
}

function parseGate(value: Record<string, unknown>): void {
	const stage = Reflect.get(value, "stage");
	const kind = Reflect.get(value, "kind");
	const options = Reflect.get(value, "options");
	const context = Reflect.get(value, "context");
	const createdAt = Reflect.get(value, "created_at");
	if (
		typeof Reflect.get(value, "gate_id") !== "string" ||
		(stage !== "deep-interview" && stage !== "ralplan" && stage !== "ultragoal") ||
		(kind !== "question" && kind !== "approval" && kind !== "execution") ||
		typeof Reflect.get(value, "schema_hash") !== "string" ||
		!isRecord(Reflect.get(value, "schema")) ||
		!isGateOptions(options) ||
		!isGateContext(context) ||
		typeof createdAt !== "string" ||
		!Number.isFinite(Date.parse(createdAt)) ||
		Reflect.get(value, "required") !== true
	)
		throw new TypeError("invalid workflow gate frame");
}

function isGateContext(value: unknown): boolean {
	if (!isRecord(value)) return false;
	for (const field of ["title", "prompt", "summary", "language"]) {
		const fieldValue = Reflect.get(value, field);
		if (fieldValue !== undefined && typeof fieldValue !== "string") return false;
	}
	const stageState = Reflect.get(value, "stage_state");
	if (stageState !== undefined && !isRecord(stageState)) return false;
	const artifactRefs = Reflect.get(value, "artifact_refs");
	return (
		artifactRefs === undefined || (Array.isArray(artifactRefs) && artifactRefs.every(ref => typeof ref === "string"))
	);
}

function isGateOptions(value: unknown): boolean {
	return (
		value === undefined ||
		(Array.isArray(value) &&
			value.every(option => {
				if (!isRecord(option) || !Reflect.has(option, "value") || typeof Reflect.get(option, "label") !== "string")
					return false;
				const description = Reflect.get(option, "description");
				return description === undefined || typeof description === "string";
			}))
	);
}

function isCommand(value: unknown): value is Command {
	return typeof value === "string" && COMMANDS.some(command => command === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
