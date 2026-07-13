import type { NormalizedModelSelection } from "../src/contracts";
import type { OpenAIErrorResponse } from "../src/live/chat-response-format";
import { decodeStrictModelCatalog, formatCanonicalModelId, parseCanonicalModelId } from "../src/live/models";
import { isSseChoice } from "./real-selection-openai-schemas";
import { parseRpcOutput, parseRpcRequest, type RpcPayload } from "./real-selection-rpc-schemas";

export { parseRpcRequest } from "./real-selection-rpc-schemas";

type MappingDocument = Record<string, unknown> & { readonly mappings: readonly Record<string, unknown>[] };
type TranscriptEntry = { readonly direction: "request" | "response" | "frame"; readonly payload: RpcPayload };

import type { OpenAIChatCompletionResponse, OpenAIModelListResponse } from "../src/live/openai-types";

export function parseModelList(value: unknown): OpenAIModelListResponse {
	if (!isRecord(value) || Reflect.get(value, "object") !== "list") throw new TypeError("invalid model list");
	const data = Reflect.get(value, "data");
	if (!Array.isArray(data) || !data.every(isModelEntry)) throw new TypeError("invalid model entries");
	return { object: "list", data: data.map(entry => ({ ...entry })) };
}

export function parseCompletion(value: unknown): OpenAIChatCompletionResponse {
	if (!isRecord(value) || Reflect.get(value, "object") !== "chat.completion") {
		throw new TypeError("invalid completion");
	}
	const id = Reflect.get(value, "id");
	const created = Reflect.get(value, "created");
	const model = Reflect.get(value, "model");
	const choices = Reflect.get(value, "choices");
	if (
		typeof id !== "string" ||
		typeof created !== "number" ||
		typeof model !== "string" ||
		parseCanonicalModelId(model) === null ||
		!Array.isArray(choices)
	) {
		throw new TypeError("invalid completion fields");
	}
	const parsedChoices = choices.map(parseChoice);
	return { id, object: "chat.completion", created, model, choices: parsedChoices };
}

export function parseError(value: unknown): OpenAIErrorResponse {
	if (!isRecord(value)) throw new TypeError("invalid error response");
	const error = Reflect.get(value, "error");
	if (!isRecord(error)) throw new TypeError("invalid error payload");
	const message = Reflect.get(error, "message");
	const type = Reflect.get(error, "type");
	const code = Reflect.get(error, "code");
	if (typeof message !== "string" || typeof type !== "string" || typeof code !== "string") {
		throw new TypeError("invalid error fields");
	}
	return { error: { message, type, code } };
}

function parseChoice(value: unknown): OpenAIChatCompletionResponse["choices"][number] {
	if (!isRecord(value) || typeof Reflect.get(value, "index") !== "number") throw new TypeError("invalid choice");
	const message = Reflect.get(value, "message");
	if (!isRecord(message) || Reflect.get(message, "role") !== "assistant") throw new TypeError("invalid message");
	const content = Reflect.get(message, "content");
	if (typeof content !== "string") throw new TypeError("invalid message content");
	const finishReason = Reflect.get(value, "finish_reason");
	if (finishReason !== "stop") throw new TypeError("invalid finish reason");
	return {
		index: Number(Reflect.get(value, "index")),
		message: { role: "assistant", content },
		finish_reason: "stop",
	};
}

export function parseSseModels(value: string): readonly string[] {
	const frames = value.split("\n\n").filter(frame => frame.length > 0);
	if (frames.length < 2 || frames.at(-1) !== "data: [DONE]") throw new TypeError("invalid SSE stream");
	return frames.slice(0, -1).map(frame => {
		if (!frame.startsWith("data: ")) throw new TypeError("invalid SSE frame");
		const parsed: unknown = JSON.parse(frame.slice(6));
		const id = isRecord(parsed) ? Reflect.get(parsed, "id") : undefined;
		const created = isRecord(parsed) ? Reflect.get(parsed, "created") : undefined;
		const model = isRecord(parsed) ? Reflect.get(parsed, "model") : undefined;
		const choices = isRecord(parsed) ? Reflect.get(parsed, "choices") : undefined;
		if (
			!isRecord(parsed) ||
			Reflect.get(parsed, "object") !== "chat.completion.chunk" ||
			typeof id !== "string" ||
			typeof created !== "number" ||
			!Number.isFinite(created) ||
			typeof model !== "string" ||
			parseCanonicalModelId(model) === null ||
			!Array.isArray(choices) ||
			choices.length === 0 ||
			!choices.every(isSseChoice)
		) {
			throw new TypeError("invalid SSE chunk");
		}
		return model;
	});
}

export function parseMappingDocument(value: unknown, chatIdToUnbind?: string): MappingDocument {
	if (!isRecord(value)) throw new TypeError("invalid mapping document");
	const mappings = Reflect.get(value, "mappings");
	if (!Array.isArray(mappings) || !mappings.every(isMappingEntry)) throw new TypeError("invalid mappings");
	return {
		...value,
		mappings: mappings.map(mapping => {
			const copy = { ...mapping };
			if (Reflect.get(copy, "chatId") === chatIdToUnbind) Reflect.deleteProperty(copy, "modelSelection");
			return copy;
		}),
	};
}

export function parseTranscriptEntry(value: unknown): TranscriptEntry {
	if (!isRecord(value)) throw new TypeError("invalid transcript entry");
	const direction = Reflect.get(value, "direction");
	const payload = Reflect.get(value, "payload");
	if ((direction !== "request" && direction !== "response" && direction !== "frame") || !isRecord(payload)) {
		throw new TypeError("invalid transcript fields");
	}
	if (typeof Reflect.get(payload, "type") !== "string") throw new TypeError("invalid transcript payload");
	if (direction === "request") parseRpcRequest(payload);
	else if (direction === "frame") parseEventFrame(payload);
	else parseRpcOutput(payload);
	return { direction, payload: { ...payload, type: String(Reflect.get(payload, "type")) } };
}

export function parseCoordinatorCatalog(value: unknown): readonly object[] {
	const models = isRecord(value) ? Reflect.get(value, "models") : undefined;
	if (!Array.isArray(models) || decodeStrictModelCatalog(models) === null) {
		throw new TypeError("invalid coordinator models");
	}
	return models.map(model => ({ ...model }));
}

export function parseCoordinatorSelection(value: unknown): NormalizedModelSelection {
	const nested = isRecord(value) ? Reflect.get(value, "selection") : undefined;
	const candidate = isRecord(nested) ? nested : value;
	if (!isRecord(candidate)) throw new TypeError("invalid coordinator selection");
	if (!isNormalizedSelection(candidate)) throw new TypeError("invalid coordinator selection fields");
	return {
		provider: candidate.provider,
		modelId: candidate.modelId,
		thinkingLevel: candidate.thinkingLevel,
	};
}

export function parseCoordinatorPrompt(value: unknown): {
	readonly ok: boolean;
	readonly gate: boolean;
	readonly message?: string;
} {
	if (!isRecord(value) || typeof Reflect.get(value, "ok") !== "boolean") throw new TypeError("invalid prompt result");
	const ok = Reflect.get(value, "ok") === true;
	const gateValue = Reflect.get(value, "gate");
	if (gateValue !== undefined && typeof gateValue !== "boolean") throw new TypeError("invalid prompt gate");
	const gate = gateValue === true;
	const message = Reflect.get(value, "message");
	if (!ok && typeof message !== "string") throw new TypeError("invalid prompt failure");
	return { ok, gate, ...(typeof message === "string" ? { message } : {}) };
}

export function parseCoordinatorAssistant(value: unknown): string {
	if (!isRecord(value) || typeof Reflect.get(value, "text") !== "string")
		throw new TypeError("invalid assistant result");
	return String(Reflect.get(value, "text"));
}

export function parseCoordinatorSequence(value: unknown): number {
	const sequence = isRecord(value) && Reflect.get(value, "ok") === true ? Reflect.get(value, "seq") : undefined;
	if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) throw new TypeError("invalid coordinator sequence");
	return Number(sequence);
}

function isModelEntry(value: unknown): value is OpenAIModelListResponse["data"][number] {
	return (
		isRecord(value) &&
		parseCanonicalModelId(Reflect.get(value, "id")) !== null &&
		Reflect.get(value, "object") === "model" &&
		typeof Reflect.get(value, "created") === "number" &&
		Reflect.get(value, "owned_by") === "gjc"
	);
}

function isMappingEntry(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const fieldsValid = ["chatId", "projectId", "sessionId", "operationId"].every(
		field => typeof Reflect.get(value, field) === "string",
	);
	const selection = Reflect.get(value, "modelSelection");
	return fieldsValid && (selection === undefined || isNormalizedSelection(selection));
}

function isNormalizedSelection(value: unknown): value is NormalizedModelSelection {
	if (!isRecord(value)) return false;
	const provider = Reflect.get(value, "provider");
	const modelId = Reflect.get(value, "modelId");
	const level = Reflect.get(value, "thinkingLevel");
	if (
		typeof provider !== "string" ||
		typeof modelId !== "string" ||
		(level !== "off" && level !== "low" && level !== "medium")
	)
		return false;
	try {
		formatCanonicalModelId({ provider, modelId, thinkingLevel: level });
		return true;
	} catch (error) {
		if (error instanceof TypeError) return false;
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventFrame(value: Record<string, unknown>): void {
	const payload = Reflect.get(value, "payload");
	const event = isRecord(payload) ? Reflect.get(payload, "event") : undefined;
	const eventType = isRecord(payload) ? Reflect.get(payload, "event_type") : undefined;
	if (
		Reflect.get(value, "type") !== "event" ||
		Reflect.get(value, "protocol_version") !== 2 ||
		typeof Reflect.get(value, "session_id") !== "string" ||
		!Number.isSafeInteger(Reflect.get(value, "seq")) ||
		Number(Reflect.get(value, "seq")) < 1 ||
		typeof Reflect.get(value, "frame_id") !== "string" ||
		!isRecord(payload) ||
		typeof eventType !== "string" ||
		!isRecord(event) ||
		Reflect.get(event, "type") !== eventType ||
		(eventType === "agent_end" &&
			(!Array.isArray(Reflect.get(event, "messages")) || typeof Reflect.get(event, "stopReason") !== "string"))
	)
		throw new TypeError("invalid RPC event frame");
}
