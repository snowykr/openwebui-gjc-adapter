export const MIN_OPENWEBUI_VERSION = "0.10.0";

export const REQUIRED_OPENWEBUI_HEADER_NAMES = [
	"X-OpenWebUI-Chat-Id",
	"X-OpenWebUI-Message-Id",
	"X-OpenWebUI-User-Message-Id",
	"X-OpenWebUI-User-Message-Parent-Id",
	"X-OpenWebUI-Task",
] as const;

export type RequiredOpenWebUIHeaderName = (typeof REQUIRED_OPENWEBUI_HEADER_NAMES)[number];

export const SUPPORTED_MESSAGE_EVENT_TYPES = ["status", "files", "source", "citation"] as const;

export type SupportedMessageEventType = (typeof SUPPORTED_MESSAGE_EVENT_TYPES)[number];
