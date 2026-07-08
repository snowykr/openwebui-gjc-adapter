import type { OpenAIChatContentPart, OpenAIChatMessage } from "./openai-types";

export function latestUserText(messages: readonly OpenAIChatMessage[]): string | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		return messageContentText(message.content);
	}
	return null;
}

function messageContentText(content: OpenAIChatMessage["content"]): string | null {
	if (typeof content === "string") return content;
	if (content === null) return null;
	const text = content.map(partText).join("").trim();
	return text.length > 0 ? text : null;
}

function partText(part: OpenAIChatContentPart): string {
	return part.text;
}
