import { GJC_THINKING_LEVELS, type NormalizedModelSelection } from "../contracts";
import type { GjcRpcRunnerTransportEvent, GjcRpcTransportState } from "./rpc-runner";

export type SdkRecord = Readonly<Record<string, unknown>>;

export interface SdkEndpoint {
	readonly url: string;
	readonly token: string;
}

export interface SdkSessionAuthority {
	readonly sessionId: string;
	readonly cwd: string;
	readonly endpoint: SdkEndpoint;
}

export interface SdkSavedSession {
	readonly sessionId: string;
	readonly path: string;
}

export interface SdkExpectedSessionAuthority {
	readonly cwd: string;
	readonly sessionId?: string;
}

export class SdkV3ProtocolError extends Error {
	constructor(
		readonly boundary: string,
		message: string,
	) {
		super(`GJC SDK v3 ${boundary}: ${message}`);
		this.name = "SdkV3ProtocolError";
	}
}

export class SdkV3OperationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SdkV3OperationError";
	}
}

export function parseRecord(value: unknown, boundary: string): SdkRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SdkV3ProtocolError(boundary, "expected an object");
	}
	return Object.fromEntries(Object.entries(value));
}

export function parseJsonRecord(value: string, boundary: string): SdkRecord {
	try {
		return parseRecord(JSON.parse(value), boundary);
	} catch (error) {
		if (error instanceof SdkV3ProtocolError) throw error;
		if (error instanceof SyntaxError) throw new SdkV3ProtocolError(boundary, "malformed JSON");
		throw error;
	}
}

export function requiredString(record: SdkRecord, field: string, boundary: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new SdkV3ProtocolError(boundary, `${field} must be a non-empty string`);
	}
	return value;
}

export function parseOperationResult(frame: SdkRecord, boundary: string): unknown {
	if (frame.ok === false) {
		const error = parseRecord(frame.error, `${boundary}.error`);
		throw new SdkV3OperationError(
			requiredString(error, "code", `${boundary}.error`),
			requiredString(error, "message", `${boundary}.error`),
		);
	}
	if (frame.ok !== true) throw new SdkV3ProtocolError(boundary, "ok must be a boolean");
	return frame.result;
}

export function parseSessionAuthority(
	value: unknown,
	boundary: string,
	expected: SdkExpectedSessionAuthority,
): SdkSessionAuthority {
	const result = parseRecord(value, boundary);
	const endpoint = parseRecord(result.endpoint, `${boundary}.endpoint`);
	const sessionId = requiredString(result, "sessionId", boundary);
	const cwd = requiredString(result, "cwd", boundary);
	if (cwd !== expected.cwd) throw new SdkV3ProtocolError(boundary, "cwd does not match the requested lifecycle scope");
	if (expected.sessionId !== undefined && sessionId !== expected.sessionId) {
		throw new SdkV3ProtocolError(boundary, "sessionId does not match the requested lifecycle scope");
	}
	const url = parseLocalEndpointUrl(requiredString(endpoint, "url", `${boundary}.endpoint`), boundary);
	return {
		sessionId,
		cwd,
		endpoint: {
			url,
			token: requiredString(endpoint, "token", `${boundary}.endpoint`),
		},
	};
}

export function parseResolvedSession(value: unknown, expectedSessionId: string): SdkSavedSession {
	const result = parseRecord(value, "session.list result");
	const saved = parseRecord(result.savedSession, "session.list result.savedSession");
	const sessionId = requiredString(saved, "id", "session.list result.savedSession");
	if (sessionId !== expectedSessionId) {
		throw new SdkV3ProtocolError(
			"session.list result.savedSession",
			"session id does not match the requested session",
		);
	}
	return {
		sessionId,
		path: requiredString(saved, "path", "session.list result.savedSession"),
	};
}

export function parseQueryPage(
	frame: SdkRecord,
	boundary: string,
): {
	readonly items: readonly unknown[];
	readonly cursor?: string;
} {
	parseOperationResult(frame, boundary);
	const page = parseRecord(frame.page, `${boundary}.page`);
	if (!Array.isArray(page.items)) throw new SdkV3ProtocolError(`${boundary}.page`, "items must be an array");
	if (page.complete === true) return { items: page.items };
	return {
		items: page.items,
		cursor: requiredString(page, "continuationCursor", `${boundary}.page`),
	};
}

export function parseSelection(value: unknown): NormalizedModelSelection {
	const result = parseRecord(value, "model.set result");
	const thinkingLevel = requiredString(result, "thinkingLevel", "model.set result");
	if (!isThinkingLevel(thinkingLevel)) {
		throw new SdkV3ProtocolError("model.set result", "thinkingLevel is unsupported");
	}
	return {
		provider: requiredString(result, "provider", "model.set result"),
		modelId: requiredString(result, "modelId", "model.set result"),
		thinkingLevel,
	};
}

export function ensureCapabilityCatalog(items: readonly unknown[]): readonly unknown[] {
	for (const [index, item] of items.entries()) {
		const model = parseRecord(item, `models.list/current[${index}]`);
		requiredString(model, "provider", `models.list/current[${index}]`);
		requiredString(model, "id", `models.list/current[${index}]`);
	}
	return items;
}

export function parseState(
	metadataValue: unknown,
	configValue: unknown,
	authority: Pick<SdkSessionAuthority, "sessionId" | "cwd">,
): GjcRpcTransportState {
	const metadata = parseRecord(metadataValue, "session.metadata result");
	const sessionId = requiredString(metadata, "sessionId", "session.metadata result");
	const cwd = requiredString(metadata, "cwd", "session.metadata result");
	if (sessionId !== authority.sessionId || cwd !== authority.cwd) {
		throw new SdkV3ProtocolError("session.metadata result", "session authority does not match lifecycle authority");
	}
	const config = parseRecord(configValue, "config.list/get result");
	const model = requiredString(config, "model", "config.list/get result");
	const separator = model.indexOf("/");
	if (separator < 1 || separator === model.length - 1) {
		throw new SdkV3ProtocolError("config.list/get result", "model must be provider/id");
	}
	return {
		sessionId: authority.sessionId,
		model: { provider: model.slice(0, separator), id: model.slice(separator + 1) },
		thinkingLevel: config.thinking,
	};
}

function parseLocalEndpointUrl(value: string, boundary: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SdkV3ProtocolError(`${boundary}.endpoint`, "url must be a valid URL");
	}
	if (
		url.protocol !== "ws:" ||
		url.hostname !== "127.0.0.1" ||
		url.port.length === 0 ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.search.length > 0 ||
		url.hash.length > 0 ||
		url.pathname !== "/"
	) {
		throw new SdkV3ProtocolError(
			`${boundary}.endpoint`,
			"url must be an uncredentialed ws://127.0.0.1:<port> endpoint",
		);
	}
	return value;
}

export function parseLastAssistant(items: readonly unknown[]): string | null {
	const value = items.at(-1);
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	const record = parseRecord(value, "session.last_assistant result");
	const text = record.text ?? record.content;
	if (text === null || text === undefined) return null;
	if (typeof text !== "string") throw new SdkV3ProtocolError("session.last_assistant result", "text must be a string");
	return text;
}

export function asTransportEvent(value: unknown, boundary = "event"): GjcRpcRunnerTransportEvent {
	const record = parseRecord(value, boundary);
	return { ...record, type: requiredString(record, "type", boundary) };
}

function isThinkingLevel(value: string): value is NormalizedModelSelection["thinkingLevel"] {
	return GJC_THINKING_LEVELS.some(level => level === value);
}
