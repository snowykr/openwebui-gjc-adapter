export type OpenWebUIMessageEventType = "status" | "files" | "source" | "citation";

export interface OpenWebUIEvent<TType extends OpenWebUIMessageEventType, TData> {
	type: TType;
	data: TData;
}

export interface OpenWebUIStatusData {
	description: string;
	done: boolean;
	hidden?: boolean;
	gjc_adapter?: Record<string, unknown>;
}

export interface OpenWebUIFileData {
	id?: string;
	name: string;
	url?: string;
	mimeType?: string;
	size?: number;
	metadata?: Record<string, unknown>;
}

export type OpenWebUICitationObject = Record<string, unknown> & {
	source?: unknown;
	document?: unknown;
	metadata?: Record<string, unknown>;
};

export type OpenWebUISourceData = OpenWebUICitationObject;
export type OpenWebUICitationData = OpenWebUICitationObject;

export type OpenWebUIStatusEvent = OpenWebUIEvent<"status", OpenWebUIStatusData>;
export type OpenWebUIFilesEvent = OpenWebUIEvent<"files", { files: readonly OpenWebUIFileData[] }>;
export type OpenWebUISourceEvent = OpenWebUIEvent<"source", OpenWebUISourceData>;
export type OpenWebUICitationEvent = OpenWebUIEvent<"citation", OpenWebUICitationData>;
export type OpenWebUIMessageEvent =
	| OpenWebUIStatusEvent
	| OpenWebUIFilesEvent
	| OpenWebUISourceEvent
	| OpenWebUICitationEvent;

const SUPPORTED_MESSAGE_EVENT_TYPES: readonly OpenWebUIMessageEventType[] = ["status", "files", "source", "citation"];

export function assertSupportedMessageEventType(type: string): asserts type is OpenWebUIMessageEventType {
	if (!SUPPORTED_MESSAGE_EVENT_TYPES.includes(type as OpenWebUIMessageEventType)) {
		throw new Error(`Unsupported OpenWebUI message event type: ${type}`);
	}
}

export function buildOpenWebUIStatusEvent(data: OpenWebUIStatusData): OpenWebUIStatusEvent {
	return { type: "status", data };
}

export function buildOpenWebUIFilesEvent(files: readonly OpenWebUIFileData[]): OpenWebUIFilesEvent {
	return { type: "files", data: { files } };
}

export function buildOpenWebUISourceEvent(data: OpenWebUISourceData): OpenWebUISourceEvent {
	assertSingleCitationObject(data, "source");
	return { type: "source", data };
}

export function buildOpenWebUICitationEvent(data: OpenWebUICitationData): OpenWebUICitationEvent {
	assertSingleCitationObject(data, "citation");
	return { type: "citation", data };
}

function assertSingleCitationObject(value: OpenWebUICitationObject, type: "source" | "citation"): void {
	if (Array.isArray(value)) {
		throw new Error(`OpenWebUI ${type} event data must be one object, not an array`);
	}
}
