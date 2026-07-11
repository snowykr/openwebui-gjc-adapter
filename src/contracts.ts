export const MIN_OPENWEBUI_VERSION = "0.10.0";

export const OPENWEBUI_HEADER_DESCRIPTORS = [
	{ name: "X-OpenWebUI-Chat-Id", field: "chatId", requiredFor: "normal-chat" },
	{ name: "X-OpenWebUI-Message-Id", field: "messageId", requiredFor: "normal-chat" },
	{ name: "X-OpenWebUI-User-Message-Id", field: "userMessageId", requiredFor: "normal-chat" },
	{ name: "X-OpenWebUI-User-Message-Parent-Id", field: "userMessageParentId", requiredFor: "normal-chat" },
	{ name: "X-OpenWebUI-Task", field: "task", requiredFor: "background-task" },
	{ name: "X-OpenWebUI-User-Id", field: "userId", requiredFor: "optional" },
] as const;

export type OpenWebUIHeaderDescriptor = (typeof OPENWEBUI_HEADER_DESCRIPTORS)[number];
export type OpenWebUIHeaderName = OpenWebUIHeaderDescriptor["name"];

export const REQUIRED_OPENWEBUI_HEADER_NAMES = OPENWEBUI_HEADER_DESCRIPTORS.filter(
	descriptor => descriptor.requiredFor === "normal-chat" || descriptor.requiredFor === "background-task",
).map(descriptor => descriptor.name);

export type RequiredOpenWebUIHeaderName = Extract<
	OpenWebUIHeaderDescriptor,
	{ readonly requiredFor: "normal-chat" | "background-task" }
>["name"];

export const SUPPORTED_MESSAGE_EVENT_TYPES = ["status", "files", "source", "citation"] as const;

export type SupportedMessageEventType = (typeof SUPPORTED_MESSAGE_EVENT_TYPES)[number];
