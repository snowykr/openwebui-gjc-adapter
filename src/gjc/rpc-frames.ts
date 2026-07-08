export type RawRpcFrame = Record<string, unknown>;

export type RpcFrameKind =
	| "ready"
	| "response"
	| "event"
	| "workflow_gate"
	| "extension_ui_request"
	| "extension_error"
	| "host_tool"
	| "host_uri"
	| "unknown";

export interface RpcFrameDiagnostic {
	readonly severity: "info" | "warn";
	readonly message: string;
	readonly rawRef?: string;
}

interface ClassifiedRpcFrameBase<TKind extends RpcFrameKind> {
	readonly kind: TKind;
	readonly seq?: number;
	readonly frameId?: string;
	readonly rawRef?: string;
}

export interface ReadyRpcFrame extends ClassifiedRpcFrameBase<"ready"> {
	readonly payload: RawRpcFrame;
}

export interface ResponseRpcFrame extends ClassifiedRpcFrameBase<"response"> {
	readonly id: string | number;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly payload: RawRpcFrame;
}

export interface EventRpcFrame extends ClassifiedRpcFrameBase<"event"> {
	readonly eventType: string;
	readonly event: unknown;
	readonly payload: RawRpcFrame;
}

export interface WorkflowGateRpcFrame extends ClassifiedRpcFrameBase<"workflow_gate"> {
	readonly gateId?: string;
	readonly payload: RawRpcFrame;
}

export interface ExtensionUiRequestRpcFrame extends ClassifiedRpcFrameBase<"extension_ui_request"> {
	readonly id?: string | number;
	readonly method?: string;
	readonly payload: RawRpcFrame;
}

export interface ExtensionErrorRpcFrame extends ClassifiedRpcFrameBase<"extension_error"> {
	readonly id?: string | number;
	readonly error: unknown;
	readonly payload: RawRpcFrame;
}

export interface HostToolRpcFrame extends ClassifiedRpcFrameBase<"host_tool"> {
	readonly rpcType: "host_tool_call" | "host_tool_cancel" | "host_tool_result" | "host_tool_update";
	readonly id?: string | number;
	readonly payload: RawRpcFrame;
}

export interface HostUriRpcFrame extends ClassifiedRpcFrameBase<"host_uri"> {
	readonly rpcType: "host_uri_request" | "host_uri_cancel" | "host_uri_result";
	readonly id?: string | number;
	readonly payload: RawRpcFrame;
}

export interface UnknownRpcFrame extends ClassifiedRpcFrameBase<"unknown"> {
	readonly diagnostic: RpcFrameDiagnostic;
}

export type ClassifiedRpcFrame =
	| ReadyRpcFrame
	| ResponseRpcFrame
	| EventRpcFrame
	| WorkflowGateRpcFrame
	| ExtensionUiRequestRpcFrame
	| ExtensionErrorRpcFrame
	| HostToolRpcFrame
	| HostUriRpcFrame
	| UnknownRpcFrame;

const HOST_TOOL_TYPES: readonly HostToolRpcFrame["rpcType"][] = [
	"host_tool_call",
	"host_tool_cancel",
	"host_tool_result",
	"host_tool_update",
];
const HOST_URI_TYPES: readonly HostUriRpcFrame["rpcType"][] = [
	"host_uri_request",
	"host_uri_cancel",
	"host_uri_result",
];

export function classifyRpcFrame(frame: RawRpcFrame, seqFallback?: number): ClassifiedRpcFrame {
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
		return { kind: "host_tool", ...metadata, rpcType: type, id: idValue(frame.id), payload: frame };
	}

	if (isHostUriType(type)) {
		return { kind: "host_uri", ...metadata, rpcType: type, id: idValue(frame.id), payload: frame };
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
			message: type ? `Unsupported RPC frame type: ${bounded(type)}` : "Unsupported RPC frame without string type",
			...(metadata.rawRef ? { rawRef: metadata.rawRef } : {}),
		},
	};
}

function frameMetadata(
	frame: RawRpcFrame,
	seqFallback: number | undefined,
): Omit<ClassifiedRpcFrameBase<RpcFrameKind>, "kind"> {
	const seq = numberValue(frame.seq) ?? seqFallback;
	const frameId = stringValue(frame.frame_id) ?? stringValue(frame.frameId);
	return {
		...(seq === undefined ? {} : { seq }),
		...(frameId === undefined ? {} : { frameId, rawRef: frameId }),
	};
}

function isResponseFrame(frame: RawRpcFrame, type: string | undefined): boolean {
	return (
		(type === "response" || type === undefined) &&
		(typeof frame.id === "string" || typeof frame.id === "number") &&
		("result" in frame || "data" in frame || "error" in frame)
	);
}

function isHostToolType(type: string | undefined): type is HostToolRpcFrame["rpcType"] {
	return HOST_TOOL_TYPES.includes(type as HostToolRpcFrame["rpcType"]);
}

function isHostUriType(type: string | undefined): type is HostUriRpcFrame["rpcType"] {
	return HOST_URI_TYPES.includes(type as HostUriRpcFrame["rpcType"]);
}

function recordValue(value: unknown): RawRpcFrame | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RawRpcFrame) : undefined;
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
