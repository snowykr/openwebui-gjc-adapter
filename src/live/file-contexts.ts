import type { RegisteredProject } from "../projects/registry";
import { type OpenWebUIFileReference, openWebUIFileReferences } from "./chat-content";
import { appendResolvedOpenWebUIFileContext, type ResolvedOpenWebUIFileContext } from "./chat-file-context-format";
import type { OpenAIChatCompletionRequest } from "./openai-types";

export interface LiveGatewayFileContextResolverInput {
	readonly reference: OpenWebUIFileReference;
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly userMessageId: string;
}

export type LiveGatewayFileContextResolver = (
	input: LiveGatewayFileContextResolverInput,
) => Promise<ResolvedOpenWebUIFileContext | undefined> | ResolvedOpenWebUIFileContext | undefined;

export async function appendResolvedFileContexts(input: {
	readonly prompt: string;
	readonly messages: OpenAIChatCompletionRequest["messages"];
	readonly files?: OpenAIChatCompletionRequest["files"];
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly resolver?: LiveGatewayFileContextResolver;
}): Promise<string> {
	if (input.resolver === undefined) return input.prompt;
	const resolved: ResolvedOpenWebUIFileContext[] = [];
	for (const reference of openWebUIFileReferences(input.messages, input.files ?? [])) {
		const file = await input.resolver({
			reference,
			project: input.project,
			chatId: input.chatId,
			userMessageId: input.userMessageId,
		});
		if (file !== undefined) {
			resolved.push({
				id: file.id,
				filename: file.filename ?? reference.name,
				...(file.localPath === undefined ? {} : { localPath: file.localPath }),
				...(file.content === undefined ? {} : { content: file.content }),
			});
		}
	}
	return appendResolvedOpenWebUIFileContext(input.prompt, resolved);
}
