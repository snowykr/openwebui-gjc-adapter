import type { OpenWebUIOwnerContext } from "../openwebui/auth";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import type { OpenWebUIHeaderInput } from "../openwebui/headers";
import type { RegisteredProject } from "../projects/registry";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./chat-delivery";
import type { OpenAIErrorResponse } from "./chat-response-format";
import type { LiveGatewayFileContextResolver } from "./file-contexts";
import type { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "./openai-types";

export type OpenWebUIControl =
	| { readonly operation: "abort" | "steer" | "follow_up" | "abort_and_prompt"; readonly text?: string }
	| { readonly operation: "action_reply"; readonly actionId: string; readonly answer: unknown }
	| { readonly operation: "workflow.plan_approve"; readonly input: Readonly<Record<string, unknown>> }
	| { readonly operation: "branch" }
	/** Attached lifecycle operations remain on the public session controller. */
	| { readonly operation: "session.new" }
	| {
			readonly operation: "session.resume" | "session.switch";
			readonly sessionId: string;
			readonly sessionFile: string;
	  }
	| { readonly operation: "unsupported"; readonly surface: string };

export interface LiveGatewayRunnerInput {
	readonly project: RegisteredProject;
	readonly prompt: string;
	readonly chatId: string;
	readonly messageId: string;
	readonly userMessageId: string;
	readonly userMessageParentId: string | null;
	readonly continued: boolean;
	readonly requestedModelId?: string;
	/** Authenticated OpenWebUI owner bound by the request handler for branch controls. */
	readonly ownerUserId?: string;
	/** Message lineage supplied by OpenWebUI for the regenerated message. */
	readonly messageMetadata?: Readonly<Record<string, unknown>>;
	readonly control?: OpenWebUIControl;
	readonly onLiveEvents?: (events: readonly OpenWebUIMessageEvent[]) => Promise<void> | void;
}

export type LiveGatewayRunnerResult =
	| {
			readonly content: string;
			readonly chunks?: undefined;
			readonly events?: readonly OpenWebUIMessageEvent[];
			readonly model?: string;
	  }
	| {
			readonly content?: undefined;
			readonly chunks: AsyncIterable<string> | Iterable<string>;
			readonly events?: readonly OpenWebUIMessageEvent[];
			readonly model?: string;
	  };

export interface LiveGatewayRunner {
	stop?(): void | Promise<void>;
	run(input: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> | LiveGatewayRunnerResult;
}

export class LiveGatewayUnavailableError extends Error {
	readonly code = "live_runner_unavailable";
}

export class OpenWebUIControlError extends Error {
	readonly code = "unsupported_openwebui_control";

	constructor(surface: string) {
		super(`Unsupported or ambiguous OpenWebUI control surface: ${surface}.`);
		this.name = "OpenWebUIControlError";
	}
}
export class WorkflowGateReplyError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly errors: readonly string[],
	) {
		super(message);
		this.name = "WorkflowGateReplyError";
	}
}

export type LiveChatCompletionsResult =
	| { readonly ok: true; readonly status: 200; readonly body: OpenAIChatCompletionResponse }
	| { readonly ok: true; readonly status: 200; readonly stream: AsyncIterable<string> }
	| { readonly ok: false; readonly status: 400 | 401 | 404 | 409 | 503; readonly body: OpenAIErrorResponse };

export interface HandleChatCompletionsInput {
	readonly request: OpenAIChatCompletionRequest;
	readonly headers: OpenWebUIHeaderInput;
	readonly projects: readonly RegisteredProject[];
	readonly projectProvider?: () => readonly RegisteredProject[] | Promise<readonly RegisteredProject[]>;
	readonly owner: OpenWebUIOwnerContext;
	readonly runner: LiveGatewayRunner;
	readonly now?: Date;
	readonly idFactory?: () => string;
	readonly outbox?: unknown;
	readonly eventSink?: LiveGatewayEventSink;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly fileContextResolver?: LiveGatewayFileContextResolver;
	readonly projectContextRepository?: OpenWebUIProjectionRepository;
	readonly neutralWorkspace?: string;
	readonly modelReaderFactory?: import("./model-reader").ModelReaderFactory;
}
