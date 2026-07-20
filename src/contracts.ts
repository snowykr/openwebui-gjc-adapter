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

export const GJC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type GjcThinkingLevel = (typeof GJC_THINKING_LEVELS)[number];

export type NormalizedModelSelection = {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: GjcThinkingLevel;
};

export const GJC_RUNTIME_LOCATION_ENV = {
	configDirName: "GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME",
	codingAgentDir: "GJC_OPENWEBUI_GJC_CODING_AGENT_DIR",
} as const;

export type GjcRuntimeLocations = {
	readonly home: string;
	readonly configDomain: string;
	readonly agentDir: string;
	readonly readerWorkspace: string;
	readonly readerSessionRoot: string;
	readonly protectedProjectPaths: readonly [string, string, string, string];
	readonly childEnvironment: Readonly<{
		HOME: string;
		GJC_CONFIG_DIR: string;
		GJC_CODING_AGENT_DIR: string;
	}>;
};
