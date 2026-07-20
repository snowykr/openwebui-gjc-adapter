import type { LiveChatCompletionsResult, LiveGatewayRunnerResult } from "./chat-completions-types";
import { deliverContentAfterChunks, deliverFinalAssistantContent, type LiveGatewayMessageSink } from "./chat-delivery";
import { buildCompletion, encodeChatCompletionSse } from "./chat-response-format";

export async function deliverChatCompletion(input: {
	readonly stream: boolean;
	readonly runnerResult: LiveGatewayRunnerResult;
	readonly id: string;
	readonly created: number;
	readonly model: string;
	readonly messageSink?: LiveGatewayMessageSink;
	readonly chatId: string;
	readonly messageId: string;
	readonly ownerUserId: string;
	readonly projectId: string;
}): Promise<LiveChatCompletionsResult> {
	const { runnerResult } = input;
	if (input.stream) {
		const chunks = runnerResult.chunks ?? [runnerResult.content];
		return {
			ok: true,
			status: 200,
			stream: encodeChatCompletionSse({
				id: input.id,
				created: input.created,
				model: input.model,
				chunks: deliverContentAfterChunks({
					chunks,
					messageSink: input.messageSink,
					chatId: input.chatId,
					messageId: input.messageId,
					ownerUserId: input.ownerUserId,
					projectId: input.projectId,
				}),
			}),
		};
	}

	const content = runnerResult.content ?? (await collectChunks(runnerResult.chunks));
	await deliverFinalAssistantContent({
		messageSink: input.messageSink,
		chatId: input.chatId,
		messageId: input.messageId,
		ownerUserId: input.ownerUserId,
		projectId: input.projectId,
		content,
	});
	return {
		ok: true,
		status: 200,
		body: buildCompletion({ id: input.id, created: input.created, model: input.model, content }),
	};
}

async function collectChunks(chunks: AsyncIterable<string> | Iterable<string>): Promise<string> {
	let content = "";
	for await (const chunk of chunks) content += chunk;
	return content;
}
