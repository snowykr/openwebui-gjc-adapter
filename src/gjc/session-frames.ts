export type RawSessionFrame = Record<string, unknown>;

export type SessionFrameKind =
	| "ready"
	| "response"
	| "event"
	| "workflow_gate"
	| "extension_ui_request"
	| "extension_error"
	| "host_tool"
	| "host_uri"
	| "unknown";

export interface SessionFrameDiagnostic {
	readonly severity: "info" | "warn";
	readonly message: string;
	readonly rawRef?: string;
}

interface ClassifiedSessionFrameBase<TKind extends SessionFrameKind> {
	readonly kind: TKind;
	readonly seq?: number;
	readonly frameId?: string;
	readonly rawRef?: string;
}

export interface ReadySessionFrame extends ClassifiedSessionFrameBase<"ready"> {
	readonly payload: RawSessionFrame;
}

export interface ResponseSessionFrame extends ClassifiedSessionFrameBase<"response"> {
	readonly id: string | number;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly payload: RawSessionFrame;
}

export interface EventSessionFrame extends ClassifiedSessionFrameBase<"event"> {
	readonly eventType: string;
	readonly event: unknown;
	readonly payload: RawSessionFrame;
}

export interface WorkflowGateSessionFrame extends ClassifiedSessionFrameBase<"workflow_gate"> {
	readonly gateId?: string;
	readonly payload: RawSessionFrame;
}

export interface ExtensionUiRequestSessionFrame extends ClassifiedSessionFrameBase<"extension_ui_request"> {
	readonly id?: string | number;
	readonly method?: string;
	readonly payload: RawSessionFrame;
}

export interface ExtensionErrorSessionFrame extends ClassifiedSessionFrameBase<"extension_error"> {
	readonly id?: string | number;
	readonly error: unknown;
	readonly payload: RawSessionFrame;
}

export interface HostToolSessionFrame extends ClassifiedSessionFrameBase<"host_tool"> {
	readonly frameType: "host_tool_call" | "host_tool_cancel" | "host_tool_result" | "host_tool_update";
	readonly id?: string | number;
	readonly payload: RawSessionFrame;
}

export interface HostUriSessionFrame extends ClassifiedSessionFrameBase<"host_uri"> {
	readonly frameType: "host_uri_request" | "host_uri_cancel" | "host_uri_result";
	readonly id?: string | number;
	readonly payload: RawSessionFrame;
}

export interface UnknownSessionFrame extends ClassifiedSessionFrameBase<"unknown"> {
	readonly diagnostic: SessionFrameDiagnostic;
}

export type ClassifiedSessionFrame =
	| ReadySessionFrame
	| ResponseSessionFrame
	| EventSessionFrame
	| WorkflowGateSessionFrame
	| ExtensionUiRequestSessionFrame
	| ExtensionErrorSessionFrame
	| HostToolSessionFrame
	| HostUriSessionFrame
	| UnknownSessionFrame;

const HOST_TOOL_TYPES: readonly HostToolSessionFrame["frameType"][] = [
	"host_tool_call",
	"host_tool_cancel",
	"host_tool_result",
	"host_tool_update",
];
const HOST_URI_TYPES: readonly HostUriSessionFrame["frameType"][] = [
	"host_uri_request",
	"host_uri_cancel",
	"host_uri_result",
];

export function classifySessionFrame(frame: RawSessionFrame, seqFallback?: number): ClassifiedSessionFrame {
	const metadata = frameMetadata(frame, seqFallback);
	const type = stringValue(frame.type);

	if (type === "ready") return { kind: "ready", ...metadata, payload: frame };

	if (type === "event") {
		const payload = recordValue(frame.payload);
		const eventType = payload ? stringValue(payload.event_type) : undefined;
		if (payload && eventType && "event" in payload) {
			return { kind: "event", ...metadata, eventType, event: payload.event, payload: frame };
		}
	}

	if (type === "workflow_gate") {
		return { kind: "workflow_gate", ...metadata, gateId: stringValue(frame.gate_id), payload: frame };
	}

	if (type === "extension_ui_request") {
		return {
			kind: "extension_ui_request",
			...metadata,
			id: idValue(frame.id),
			method: stringValue(frame.method),
			payload: frame,
		};
	}

	if (type === "extension_error" || (type === "error" && ("extension" in frame || frame.source === "extension"))) {
		return {
			kind: "extension_error",
			...metadata,
			id: idValue(frame.id),
			error: frame.error ?? frame.message,
			payload: frame,
		};
	}

	if (isHostToolType(type)) {
		return { kind: "host_tool", ...metadata, frameType: type, id: idValue(frame.id), payload: frame };
	}

	if (isHostUriType(type)) {
		return { kind: "host_uri", ...metadata, frameType: type, id: idValue(frame.id), payload: frame };
	}

	if (isResponseFrame(frame, type)) {
		return {
			kind: "response",
			...metadata,
			id: frame.id as string | number,
			result: frame.result ?? frame.data,
			error: frame.error,
			payload: frame,
		};
	}

	return {
		kind: "unknown",
		...metadata,
		diagnostic: {
			severity: type ? "warn" : "info",
			message: type ? `Unsupported frame type: ${bounded(type)}` : "Unsupported frame without string type",
			...(metadata.rawRef ? { rawRef: metadata.rawRef } : {}),
		},
	};
}

function frameMetadata(
	frame: RawSessionFrame,
	seqFallback: number | undefined,
): Omit<ClassifiedSessionFrameBase<SessionFrameKind>, "kind"> {
	const seq = numberValue(frame.seq) ?? seqFallback;
	const frameId = stringValue(frame.frame_id) ?? stringValue(frame.frameId);
	return {
		...(seq === undefined ? {} : { seq }),
		...(frameId === undefined ? {} : { frameId, rawRef: frameId }),
	};
}

function isResponseFrame(frame: RawSessionFrame, type: string | undefined): boolean {
	return (
		(type === "response" || type === undefined) &&
		(typeof frame.id === "string" || typeof frame.id === "number") &&
		("result" in frame || "data" in frame || "error" in frame)
	);
}

function isHostToolType(type: string | undefined): type is HostToolSessionFrame["frameType"] {
	return HOST_TOOL_TYPES.includes(type as HostToolSessionFrame["frameType"]);
}

function isHostUriType(type: string | undefined): type is HostUriSessionFrame["frameType"] {
	return HOST_URI_TYPES.includes(type as HostUriSessionFrame["frameType"]);
}

function recordValue(value: unknown): RawSessionFrame | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RawSessionFrame) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idValue(value: unknown): string | number | undefined {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function bounded(value: string): string {
	return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}
