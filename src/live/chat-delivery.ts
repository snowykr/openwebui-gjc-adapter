import type { OpenWebUIMessageEvent } from "../openwebui/events";

export interface LiveGatewayEventDeliveryInput {
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
	readonly events: readonly OpenWebUIMessageEvent[];
}

export type LiveGatewayEventSink = (input: LiveGatewayEventDeliveryInput) => Promise<void> | void;

export interface LiveGatewayMessageDeliveryInput {
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
	readonly content: string;
}

export type LiveGatewayMessageSink = (input: LiveGatewayMessageDeliveryInput) => Promise<void> | void;

export async function* deliverContentAfterChunks(input: {
	readonly chunks: AsyncIterable<string> | Iterable<string>;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
}): AsyncIterable<string> {
	let content = "";
	for await (const chunk of input.chunks) {
		content += chunk;
		yield chunk;
	}
	await deliverFinalAssistantContent({ ...input, content });
}

export async function deliverFinalAssistantContent(input: {
	readonly messageSink?: LiveGatewayMessageSink;
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
	readonly content: string;
}): Promise<void> {
	if (input.messageSink === undefined) return;
	await input.messageSink({
		chatId: input.chatId,
		messageId: input.messageId,
		ownerUserId: input.ownerUserId,
		projectId: input.projectId,
		content: input.content,
	});
}

export async function deliverRunnerEvents(input: {
	readonly eventSink?: LiveGatewayEventSink;
	readonly events?: readonly OpenWebUIMessageEvent[];
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
}): Promise<void> {
	if (input.eventSink === undefined || input.events === undefined || input.events.length === 0) return;
	await input.eventSink({
		chatId: input.chatId,
		messageId: input.messageId,
		ownerUserId: input.ownerUserId,
		projectId: input.projectId,
		events: input.events,
	});
}
