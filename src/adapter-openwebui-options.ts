import type { AdapterConfig } from "./config";
import type { LiveGatewayEventSink, LiveGatewayMessageSink } from "./live/chat-completions";
import type { LiveGatewayFileContextResolver } from "./live/file-contexts";
import {
	buildOpenWebUIAuthStartupDiagnostic,
	createOpenWebUIPrincipalContext,
	type OpenWebUIOwnerContext,
	type OpenWebUIPrincipal,
} from "./openwebui/auth";
import {
	createOpenWebUIFileContextResolver,
	createOpenWebUIPrincipalFileContextResolver,
} from "./openwebui/file-context-resolver";
import type {
	OpenWebUIPrincipalClient,
	OpenWebUIPrincipalClientFactory,
	RuntimeAdminClientFactory,
} from "./openwebui/http-client";
import { OpenWebUIBootstrapClient, OpenWebUIHttpClient, OpenWebUIPrincipalScopeError } from "./openwebui/http-client";

import { OpenWebUIPromptHintClient } from "./openwebui/prompt-hints";
import type { UserWorkspaceRegistry } from "./security/user-workspace";
export function buildOpenWebUIClient(config: AdapterConfig): OpenWebUIHttpClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIHttpClient({ baseUrl: config.openWebUIBaseUrl, apiToken: config.openWebUIApiToken });
}
export function buildOpenWebUIBootstrapClient(config: AdapterConfig): OpenWebUIBootstrapClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIBootstrapClient({
		baseUrl: config.openWebUIBaseUrl,
		apiToken: config.openWebUIApiToken,
		...(config.ownerUserId === undefined ? {} : { ownerUserId: config.ownerUserId }),
	});
}

export function buildOpenWebUIPrincipalCapabilityFactory(
	config: AdapterConfig,
): OpenWebUIPrincipalClientFactory | undefined {
	return buildOpenWebUIBootstrapClient(config)?.principalClientFactory;
}

export function buildOpenWebUIRuntimeAdminClientFactory(config: AdapterConfig): RuntimeAdminClientFactory | undefined {
	if (config.openWebUIApiToken === undefined || config.ownerUserId === undefined) return undefined;
	return buildOpenWebUIBootstrapClient(config)?.runtimeAdminClientFactory;
}
export function buildOpenWebUIPrincipalClient(
	config: AdapterConfig,
	userId: string,
): OpenWebUIPrincipalClient | undefined {
	const principalUserId = requirePrincipalUserId(userId);
	const bootstrap = buildOpenWebUIBootstrapClient(config);
	return bootstrap?.principalClientFactory.forPrincipal({
		userId: principalUserId,
		role: "user",
	});
}
export function buildOpenWebUIPrincipalClientFactory(
	config: AdapterConfig,
	workspaceRegistry?: Pick<UserWorkspaceRegistry, "open">,
): ((ownerUserId: string, correlationId: string) => Promise<OpenWebUIPrincipalClient>) | undefined {
	const capabilityFactory = buildOpenWebUIPrincipalCapabilityFactory(config);
	if (capabilityFactory === undefined) return undefined;
	return async (ownerUserId, correlationId) => {
		const userId = requirePrincipalUserId(ownerUserId);
		const principal: OpenWebUIPrincipal =
			config.ownerUserId === userId ? { userId, role: "admin" } : { userId, role: "user" };
		const workspace = principal.role === "user" ? await workspaceRegistry?.open(userId) : undefined;
		if (principal.role === "user" && workspace === undefined)
			throw new OpenWebUIPrincipalScopeError("OpenWebUI normal principal requires a durable workspace.");
		return capabilityFactory.create(
			principal,
			createOpenWebUIPrincipalContext({
				principal,
				correlationId,
				...(workspace === undefined ? {} : { workspace: { safeKey: workspace.safeKey, root: workspace.root } }),
			}),
		);
	};
}

function requirePrincipalUserId(userId: string): string {
	if (typeof userId !== "string" || userId.trim().length === 0) {
		throw new OpenWebUIPrincipalScopeError("OpenWebUI principal requires a non-empty user ID.");
	}
	return userId;
}

export function buildOpenWebUIPromptHintClient(config: AdapterConfig): OpenWebUIPromptHintClient | undefined {
	if (config.openWebUIApiToken === undefined) return undefined;
	return new OpenWebUIPromptHintClient({
		baseUrl: config.openWebUIBaseUrl,
		apiToken: config.openWebUIApiToken,
		installationId: config.installationId,
	});
}

export function buildOpenWebUIEventSink(client: OpenWebUIHttpClient | undefined): LiveGatewayEventSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		for (const event of input.events)
			await client.postMessageEvent({ chatId: input.chatId, messageId: input.messageId, event });
	};
}
export function buildOpenWebUIPrincipalEventSink(
	client: OpenWebUIPrincipalClient | undefined,
): LiveGatewayEventSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		if (input.ownerUserId !== client.userId) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal event owner does not match the bound user.");
		}
		const proof = await client.requireChatProof(input.chatId);
		for (const event of input.events) {
			await client.postMessageEvent({
				chatId: input.chatId,
				messageId: input.messageId,
				event,
				proof,
			});
		}
	};
}
export function buildOpenWebUIPrincipalEventSinkFactory(
	config: AdapterConfig,
	workspaceRegistry?: Pick<UserWorkspaceRegistry, "open">,
): LiveGatewayEventSink | undefined {
	const clientFactory = buildOpenWebUIPrincipalClientFactory(config, workspaceRegistry);
	if (clientFactory === undefined) return undefined;
	return async input => {
		const sink = buildOpenWebUIPrincipalEventSink(
			await clientFactory(input.ownerUserId, `event:${input.chatId}:${input.messageId}`),
		);
		if (sink === undefined)
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal event delivery is unavailable.");
		await sink(input);
	};
}

export function buildOpenWebUIPrincipalMessageSink(
	client: OpenWebUIPrincipalClient | undefined,
): LiveGatewayMessageSink | undefined {
	if (client === undefined) return undefined;
	return async input => {
		if (input.ownerUserId !== client.userId) {
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal message owner does not match the bound user.");
		}
		const proof = await client.requireChatProof(input.chatId);
		await client.updateMessageContent({
			chatId: input.chatId,
			messageId: input.messageId,
			content: input.content,
			proof,
		});
	};
}
export function buildOpenWebUIPrincipalMessageSinkFactory(
	config: AdapterConfig,
	workspaceRegistry?: Pick<UserWorkspaceRegistry, "open">,
): LiveGatewayMessageSink | undefined {
	const clientFactory = buildOpenWebUIPrincipalClientFactory(config, workspaceRegistry);
	if (clientFactory === undefined) return undefined;
	return async input => {
		const sink = buildOpenWebUIPrincipalMessageSink(
			await clientFactory(input.ownerUserId, `message:${input.chatId}:${input.messageId}`),
		);
		if (sink === undefined)
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal message delivery is unavailable.");
		await sink(input);
	};
}

export function buildOpenWebUIPrincipalFileContextResolver(
	client: OpenWebUIPrincipalClient | undefined,
): LiveGatewayFileContextResolver | undefined {
	return client === undefined ? undefined : createOpenWebUIPrincipalFileContextResolver(client);
}
export function buildOpenWebUIPrincipalFileContextResolverFactory(
	config: AdapterConfig,
	workspaceRegistry?: Pick<UserWorkspaceRegistry, "open">,
): LiveGatewayFileContextResolver | undefined {
	const clientFactory = buildOpenWebUIPrincipalClientFactory(config, workspaceRegistry);
	if (clientFactory === undefined) return undefined;
	return async input => {
		const resolver = buildOpenWebUIPrincipalFileContextResolver(
			await clientFactory(input.ownerUserId, `file:${input.chatId}:${input.userMessageId}`),
		);
		if (resolver === undefined)
			throw new OpenWebUIPrincipalScopeError("OpenWebUI principal file resolution is unavailable.");
		return await resolver(input);
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
