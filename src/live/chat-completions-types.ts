import type { OpenWebUIOwnerContext } from "../openwebui/auth";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import type { OpenWebUIMessageEvent } from "../openwebui/events";
import type { OpenWebUIHeaderInput } from "../openwebui/headers";
import type { RegisteredProject } from "../projects/registry";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./chat-delivery";
import type { OpenAIErrorResponse } from "./chat-response-format";
import type { LiveGatewayFileContextResolver } from "./file-contexts";
import type { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from "./openai-types";

export interface LiveGatewayRunnerInput {
	readonly project: RegisteredProject;
	readonly prompt: string;
	readonly chatId: string;
	readonly messageId: string;
	readonly userMessageId: string;
	readonly userMessageParentId: string | null;
	readonly continued: boolean;
}

export type LiveGatewayRunnerResult =
	| { readonly content: string; readonly chunks?: undefined; readonly events?: readonly OpenWebUIMessageEvent[] }
	| {
			readonly content?: undefined;
			readonly chunks: AsyncIterable<string> | Iterable<string>;
			readonly events?: readonly OpenWebUIMessageEvent[];
	  };

export interface LiveGatewayRunner {
	run(input: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> | LiveGatewayRunnerResult;
}

export class LiveGatewayUnavailableError extends Error {
	readonly code = "live_runner_unavailable";
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
	| { readonly ok: false; readonly status: 400 | 401 | 404 | 503; readonly body: OpenAIErrorResponse };

export interface HandleChatCompletionsInput {
	readonly request: OpenAIChatCompletionRequest;
	readonly headers: OpenWebUIHeaderInput;
	readonly projects: readonly RegisteredProject[];
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
}
