import { OPENWEBUI_HEADER_DESCRIPTORS, type OpenWebUIHeaderName } from "../contracts";
export interface OpenWebUIHeaderValues {
	chatId: string;
	messageId: string;
	userMessageId: string;
	userMessageParentId: string | null;
	userId: string | null;
	task: string | null;
	isBackgroundTask: boolean;
}

export type OpenWebUIHeaderErrorCode = "missing" | "empty" | "placeholder";

export interface OpenWebUIHeaderError {
	name: OpenWebUIHeaderName;
	code: OpenWebUIHeaderErrorCode;
	message: string;
}

export type OpenWebUIHeaderParseResult =
	| ({ ok: true; errors: readonly [] } & OpenWebUIHeaderValues)
	| ({ ok: false; errors: readonly OpenWebUIHeaderError[] } & OpenWebUIHeaderValues);

export type OpenWebUIHeaderInput = Headers | Record<string, string | readonly string[] | null | undefined>;

export type { OpenWebUIHeaderName } from "../contracts";

const REQUIRED_NORMAL_CHAT_HEADERS = OPENWEBUI_HEADER_DESCRIPTORS.filter(
	descriptor => descriptor.requiredFor === "normal-chat",
).map(descriptor => descriptor.name);
const TASK_HEADER = OPENWEBUI_HEADER_DESCRIPTORS.find(descriptor => descriptor.requiredFor === "background-task")
	?.name as OpenWebUIHeaderName;
const OPTIONAL_USER_HEADER = OPENWEBUI_HEADER_DESCRIPTORS.find(descriptor => descriptor.requiredFor === "optional")
	?.name as OpenWebUIHeaderName;
const PLACEHOLDER_PATTERN = /^\{\{[A-Z0-9_]+\}\}$/;

type HeaderValueField = keyof MutableHeaderValues;

const FIELD_BY_HEADER = Object.fromEntries(
	OPENWEBUI_HEADER_DESCRIPTORS.map(descriptor => [descriptor.name, descriptor.field]),
) as Record<OpenWebUIHeaderName, HeaderValueField>;

interface HeaderLookup {
	get(name: OpenWebUIHeaderName): string | null;
	has(name: OpenWebUIHeaderName): boolean;
}

interface MutableHeaderValues {
	chatId: string | null;
	messageId: string | null;
	userMessageId: string | null;
	userMessageParentId: string | null;
	userId: string | null;
	task: string | null;
}

export function parseOpenWebUIHeaders(input: OpenWebUIHeaderInput): OpenWebUIHeaderParseResult {
	const headers = toHeaderLookup(input);
	const task = readHeaderValue(headers, TASK_HEADER);
	const isBackgroundTask = task !== null;
	const values: MutableHeaderValues = {
		chatId: readHeaderValue(headers, OPENWEBUI_HEADER_DESCRIPTORS[0].name),
		messageId: readHeaderValue(headers, OPENWEBUI_HEADER_DESCRIPTORS[1].name),
		userMessageId: readHeaderValue(headers, OPENWEBUI_HEADER_DESCRIPTORS[2].name),
		userMessageParentId: readHeaderValue(headers, OPENWEBUI_HEADER_DESCRIPTORS[3].name),
		userId: readHeaderValue(headers, OPTIONAL_USER_HEADER),
		task,
	};
	const errors: OpenWebUIHeaderError[] = [];

	if (!isBackgroundTask) {
		for (const name of REQUIRED_NORMAL_CHAT_HEADERS) {
			const value = values[FIELD_BY_HEADER[name]];
			if (!headers.has(name)) {
				errors.push(buildHeaderError(name, "missing"));
			} else if (value === null && name !== OPENWEBUI_HEADER_DESCRIPTORS[3].name) {
				errors.push(buildHeaderError(name, "empty"));
			}
		}
	}

	for (const name of [...REQUIRED_NORMAL_CHAT_HEADERS, TASK_HEADER, OPTIONAL_USER_HEADER]) {
		const value = values[FIELD_BY_HEADER[name]];
		if (value !== null && PLACEHOLDER_PATTERN.test(value)) {
			errors.push(buildHeaderError(name, "placeholder"));
		}
	}

	const parsedValues: OpenWebUIHeaderValues = {
		chatId: values.chatId ?? "",
		messageId: values.messageId ?? "",
		userMessageId: values.userMessageId ?? "",
		userMessageParentId: values.userMessageParentId,
		userId: values.userId,
		task: values.task,
		isBackgroundTask,
	};

	if (errors.length > 0) {
		return { ok: false, ...parsedValues, errors };
	}

	return { ok: true, ...parsedValues, errors: [] };
}

function toHeaderLookup(input: OpenWebUIHeaderInput): HeaderLookup {
	if (input instanceof Headers) {
		return {
			get: name => input.get(name),
			has: name => input.has(name),
		};
	}

	const normalized = new Map<string, string | readonly string[] | null | undefined>();
	for (const [name, value] of Object.entries(input)) {
		normalized.set(name.toLowerCase(), value);
	}

	return {
		get(name) {
			const value = normalized.get(name.toLowerCase());
			if (Array.isArray(value)) return value.join(", ");
			if (typeof value === "string") return value;
			return null;
		},
		has(name) {
			return normalized.has(name.toLowerCase());
		},
	};
}

function readHeaderValue(headers: HeaderLookup, name: OpenWebUIHeaderName): string | null {
	const value = headers.get(name)?.trim();
	return value ? value : null;
}

function buildHeaderError(name: OpenWebUIHeaderName, code: OpenWebUIHeaderErrorCode): OpenWebUIHeaderError {
	return {
		name,
		code,
		message: `${name} is ${code === "placeholder" ? "an unresolved placeholder" : code}`,
	};
}
