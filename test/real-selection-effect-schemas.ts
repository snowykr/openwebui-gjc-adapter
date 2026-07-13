import { SUPPORTED_MESSAGE_EVENT_TYPES } from "../src/contracts";
import { parseCanonicalModelId } from "../src/live/models";

type Observation =
	| { readonly type: "project_lookup" }
	| { readonly type: "event"; readonly input: Record<string, unknown> }
	| { readonly type: "message"; readonly input: Record<string, unknown> };

export type OutboxOperation = {
	readonly operationId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
	readonly chatId: string;
	readonly kind: "event" | "session_mapping";
	readonly state: "pending" | "applying" | "applied" | "failed" | "reconcile";
	readonly payloadHash: string;
	readonly attempts: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastError?: string;
};

export function parseObservations(bytes: string): readonly Observation[] {
	return bytes
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => parseObservation(JSON.parse(line)));
}

export function parseOutbox(bytes: string): readonly OutboxOperation[] {
	const value: unknown = JSON.parse(bytes);
	const operations = isRecord(value) ? Reflect.get(value, "operations") : undefined;
	if (!Array.isArray(operations) || !operations.every(isOutboxOperation)) throw new TypeError("invalid outbox");
	return operations.map(operation => ({
		operationId: String(Reflect.get(operation, "operationId")),
		ownerUserId: String(Reflect.get(operation, "ownerUserId")),
		projectId: String(Reflect.get(operation, "projectId")),
		chatId: String(Reflect.get(operation, "chatId")),
		kind: Reflect.get(operation, "kind") === "event" ? "event" : "session_mapping",
		state: parseOutboxState(operation),
		payloadHash: String(Reflect.get(operation, "payloadHash")),
		attempts: Number(Reflect.get(operation, "attempts")),
		createdAt: String(Reflect.get(operation, "createdAt")),
		updatedAt: String(Reflect.get(operation, "updatedAt")),
		...(typeof Reflect.get(operation, "lastError") === "string"
			? { lastError: String(Reflect.get(operation, "lastError")) }
			: {}),
	}));
}

export function eventModels(observations: readonly Observation[], chatId?: string): readonly string[] {
	return observations.flatMap(observation => {
		if (observation.type !== "event") return [];
		if (chatId !== undefined && Reflect.get(observation.input, "chatId") !== chatId) return [];
		const events = Reflect.get(observation.input, "events");
		if (!Array.isArray(events)) throw new TypeError("invalid event delivery");
		return events.flatMap(event => {
			if (!isRecord(event) || Reflect.get(event, "type") !== "status") return [];
			const data = isRecord(event) ? Reflect.get(event, "data") : undefined;
			const adapter = isRecord(data) ? Reflect.get(data, "gjc_adapter") : undefined;
			const model = isRecord(adapter) ? Reflect.get(adapter, "model") : undefined;
			return typeof model === "string" ? [model] : [];
		});
	});
}

function parseObservation(value: unknown): Observation {
	if (!isRecord(value)) throw new TypeError("invalid observation");
	const type = Reflect.get(value, "type");
	if (type === "project_lookup") return { type };
	const input = Reflect.get(value, "input");
	if ((type !== "event" && type !== "message") || !isDeliveryInput(input, type)) {
		throw new TypeError("invalid delivery observation");
	}
	return { type, input };
}

function isDeliveryInput(value: unknown, type: "event" | "message"): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	if (
		!["chatId", "messageId", "ownerUserId", "projectId"].every(field => typeof Reflect.get(value, field) === "string")
	)
		return false;
	if (type === "message") return typeof Reflect.get(value, "content") === "string";
	const events = Reflect.get(value, "events");
	return Array.isArray(events) && events.length > 0 && events.every(isObservedEvent);
}

function isObservedEvent(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const type = Reflect.get(value, "type");
	if (!SUPPORTED_MESSAGE_EVENT_TYPES.some(supported => supported === type)) return false;
	const data = Reflect.get(value, "data");
	if (!isRecord(data) || !adapterModelIsCanonical(data)) return false;
	if (type === "status") return isStatusData(data);
	if (type === "files") return isFilesData(data);
	return true;
}

function isStatusData(value: unknown): boolean {
	if (
		!isRecord(value) ||
		typeof Reflect.get(value, "description") !== "string" ||
		typeof Reflect.get(value, "done") !== "boolean"
	)
		return false;
	const hidden = Reflect.get(value, "hidden");
	if (hidden !== undefined && typeof hidden !== "boolean") return false;
	return true;
}

function isFilesData(value: unknown): boolean {
	const files = isRecord(value) ? Reflect.get(value, "files") : undefined;
	return Array.isArray(files) && files.every(isFileData);
}

function isFileData(value: unknown): boolean {
	if (!isRecord(value) || typeof Reflect.get(value, "name") !== "string") return false;
	for (const field of ["id", "url", "mimeType"]) {
		const fieldValue = Reflect.get(value, field);
		if (fieldValue !== undefined && typeof fieldValue !== "string") return false;
	}
	const size = Reflect.get(value, "size");
	if (size !== undefined && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) return false;
	const metadata = Reflect.get(value, "metadata");
	return metadata === undefined || isRecord(metadata);
}

function adapterModelIsCanonical(data: Record<string, unknown>): boolean {
	const adapter = Reflect.get(data, "gjc_adapter");
	if (adapter === undefined) return true;
	if (!isRecord(adapter)) return false;
	const model = Reflect.get(adapter, "model");
	return model === undefined || parseCanonicalModelId(model) !== null;
}

function isOutboxOperation(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const kind = Reflect.get(value, "kind");
	const state = Reflect.get(value, "state");
	const attempts = Reflect.get(value, "attempts");
	const createdAt = Reflect.get(value, "createdAt");
	const updatedAt = Reflect.get(value, "updatedAt");
	const lastError = Reflect.get(value, "lastError");
	return (
		typeof Reflect.get(value, "operationId") === "string" &&
		typeof Reflect.get(value, "ownerUserId") === "string" &&
		typeof Reflect.get(value, "projectId") === "string" &&
		typeof Reflect.get(value, "chatId") === "string" &&
		(kind === "event" || kind === "session_mapping") &&
		(state === "pending" ||
			state === "applying" ||
			state === "applied" ||
			state === "failed" ||
			state === "reconcile") &&
		typeof Reflect.get(value, "payloadHash") === "string" &&
		Number.isSafeInteger(attempts) &&
		Number(attempts) >= 0 &&
		isTimestamp(createdAt) &&
		isTimestamp(updatedAt) &&
		(lastError === undefined || typeof lastError === "string")
	);
}

function parseOutboxState(operation: Record<string, unknown>): OutboxOperation["state"] {
	const state = Reflect.get(operation, "state");
	if (
		state === "pending" ||
		state === "applying" ||
		state === "applied" ||
		state === "failed" ||
		state === "reconcile"
	) {
		return state;
	}
	throw new TypeError("invalid outbox state");
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
