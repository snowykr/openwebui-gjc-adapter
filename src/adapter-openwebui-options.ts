import type { AdapterConfig } from "./config";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import { buildOpenWebUIAuthStartupDiagnostic, type OpenWebUIOwnerContext } from "./openwebui/auth";
import { OpenWebUIHttpClient } from "./openwebui/client";
import { createOpenWebUIFileContextResolver } from "./openwebui/file-context-resolver";
import { OpenWebUIPromptHintClient } from "./openwebui/prompt-hints";

export function buildOpenWebUIClient(config: AdapterConfig): OpenWebUIHttpClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIHttpClient({ baseUrl: config.openWebUIBaseUrl, apiToken: config.openWebUIApiToken });
}

export function buildOpenWebUIPromptHintClient(config: AdapterConfig): OpenWebUIPromptHintClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIPromptHintClient({ baseUrl: config.openWebUIBaseUrl, apiToken: config.openWebUIApiToken });
}

export function buildOpenWebUIEventSink(client: OpenWebUIHttpClient | undefined): LiveGatewayEventSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		for (const event of input.events)
			await client.postMessageEvent({ chatId: input.chatId, messageId: input.messageId, event });
	};
}

export function buildOpenWebUIMessageSink(client: OpenWebUIHttpClient | undefined): LiveGatewayMessageSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		await client.updateMessageContent({ chatId: input.chatId, messageId: input.messageId, content: input.content });
	};
}

export function buildOpenWebUIFileContextResolver(
	client: OpenWebUIHttpClient | undefined,
): LiveGatewayFileContextResolver | undefined {
	return client === undefined ? undefined : createOpenWebUIFileContextResolver(client);
}

export function buildOwnerContext(config: AdapterConfig): OpenWebUIOwnerContext {
	return { ownerUserId: config.ownerUserId ?? "", singleOwnerLocalMode: false };
}

export function buildOpenWebUIAuthDiagnostic(config: AdapterConfig) {
	return buildOpenWebUIAuthStartupDiagnostic(config);
}
