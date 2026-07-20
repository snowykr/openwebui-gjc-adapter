import { resolve } from "node:path";
import type { ProvisionalSessionOperation, SessionAttachmentProof } from "./session-authority";
import { validateSessionFile } from "./session-file";
import { discoverFreshGjcSessionFile } from "./session-loader";
import { resolveEffectiveGjcSessionRoot } from "./session-root";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-turn-router-contract";
import { getProjectSessionRoot } from "./turn-runner";

export async function recoverInitialMappedSession(input: RouteGjcTurnInput, hash: string): Promise<RouteGjcTurnResult> {
	const operation = input.mappings.provisionalOperation(input.chatId, input.userMessageId);
	if (operation?.detail !== hash && input.modelSelection === undefined)
		throw new Error(`GJC operation ${input.userMessageId} conflicts with a different ingress payload.`);
	if (!recoverable(operation, input, hash) || input.modelSelection !== undefined)
		throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`);
	try {
		const sessionRoot = resolveEffectiveGjcSessionRoot(
			input.project.cwd,
			getProjectSessionRoot(input.project),
			input.runner.resolveSessionRoot,
		);
		const transcript = await discoverFreshGjcSessionFile(
			sessionRoot,
			new Set<string>(),
			operation.sessionId,
			resolve(input.project.cwd),
		);
		const result = transcriptResult(transcript.entries, input.text);
		if (result === undefined || input.runner.withLifecyclePublication === undefined)
			throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`);
		return await input.runner.withLifecyclePublication(
			{
				cwd: input.project.cwd,
				sessionRoot,
				projectId: input.project.id,
				chatId: input.chatId,
				sessionId: operation.sessionId,
				sessionFile: transcript.filePath,
				recoveryAttachment: operation.attachment,
			},
			async lifecycle => {
				const state = await input.runner.getState({
					cwd: input.project.cwd,
					sessionRoot,
					projectId: input.project.id,
					chatId: input.chatId,
					sessionId: operation.sessionId,
					sessionFile: transcript.filePath,
					recoveryAttachment: operation.attachment,
					lifecycle,
				});
				if (!current(state.attachment, operation.sessionId, input.project.cwd))
					throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`);
				const assistantText =
					input.projectAssistantText?.({
						text: result.text,
						events: result.events,
						sessionFile: transcript.filePath,
						activeLeaf: result.id,
						rawFrameCursor: state.rawFrameCursor,
						eventCursor: state.eventCursor,
						attachment: state.attachment,
					}) ?? result.text;
				const mapping = await lifecycle.publish(state.attachment, () => {
					input.mappings.transitionProvisionalOperation(input.chatId, input.userMessageId, "pending");
					const published = input.mappings.publishProvisionalOperation(
						{
							id: operation.id,
							kind: operation.kind,
							ingressId: operation.ingressId,
							chatId: operation.chatId,
							projectId: operation.projectId,
							detail: operation.detail,
						},
						{
							chatId: input.chatId,
							projectId: input.project.id,
							sessionId: operation.sessionId,
							sessionFile: validateSessionFile(input.project, transcript.filePath, sessionRoot),
							activeLeaf: result.id,
							rawFrameCursor: state.rawFrameCursor,
							eventCursor: state.eventCursor,
							operationId: input.userMessageId,
							assistantText,
							events: result.events,
							attachment: state.attachment,
						},
					);
					input.afterPublish?.({ assistantText, events: result.events, mapping: published });
					return published;
				});
				return { assistantText, events: result.events, mapping };
			},
		);
	} catch (cause) {
		try {
			input.mappings.transitionProvisionalOperation(
				input.chatId,
				input.userMessageId,
				"uncertain",
				operation.detail,
			);
		} catch (transitionCause) {
			throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`, {
				cause: new AggregateError([cause, transitionCause], "Failed to retain uncertain create recovery state."),
			});
		}
		throw new Error(`GJC operation ${input.userMessageId} requires reconciliation.`, { cause });
	}
}

function recoverable(
	operation: ProvisionalSessionOperation | undefined,
	input: RouteGjcTurnInput,
	hash: string,
): operation is ProvisionalSessionOperation & {
	readonly sessionId: string;
	readonly attachment: SessionAttachmentProof;
} {
	return (
		operation?.state === "uncertain" &&
		operation.kind === "create" &&
		operation.id === input.userMessageId &&
		operation.ingressId === input.userMessageId &&
		operation.chatId === input.chatId &&
		operation.projectId === input.project.id &&
		operation.detail === hash &&
		operation.sessionId !== undefined &&
		operation.attachment !== undefined &&
		operation.attachment.expectedSessionId === operation.sessionId &&
		operation.attachment.expectedCwd === resolve(input.project.cwd)
	);
}
function current(
	proof: SessionAttachmentProof | undefined,
	sessionId: string,
	cwd: string,
): proof is SessionAttachmentProof {
	return proof !== undefined && proof.expectedSessionId === sessionId && proof.expectedCwd === resolve(cwd);
}
function transcriptResult(
	entries: readonly import("@gajae-code/coding-agent").SessionEntry[],
	text: string,
):
	| {
			readonly id: string;
			readonly text: string;
			readonly events: readonly { readonly type: string; readonly id: string; readonly text: string }[];
	  }
	| undefined {
	if (new Set(entries.map(entry => entry.id)).size !== entries.length) return undefined;
	const messages = entries.filter(
			(entry): entry is Extract<typeof entry, { readonly type: "message" }> => entry.type === "message",
		),
		users = messages.filter(entry => entry.message.role === "user" && messageText(entry.message) === text);
	if (users.length !== 1) return undefined;
	const byId = new Map(entries.map(entry => [entry.id, entry])),
		assistants = messages.filter(
			entry => entry.message.role === "assistant" && descendsFrom(entry.id, users[0]!.id, byId),
		);
	if (assistants.length !== 1) return undefined;
	const assistant = assistants[0]!,
		assistantText = messageText(assistant.message);
	return assistantText === undefined
		? undefined
		: {
				id: assistant.id,
				text: assistantText,
				events: [{ type: "assistant", id: assistant.id, text: assistantText }],
			};
}
function descendsFrom(
	id: string,
	ancestorId: string,
	entries: ReadonlyMap<string, import("@gajae-code/coding-agent").SessionEntry>,
): boolean {
	const seen = new Set<string>();
	for (
		let cursor = entries.get(id)?.parentId ?? null;
		cursor !== null;
		cursor = entries.get(cursor)?.parentId ?? null
	) {
		if (cursor === ancestorId) return true;
		if (seen.has(cursor)) return false;
		seen.add(cursor);
	}
	return false;
}
function messageText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content) || !content.every(part => typeof part === "object" && part !== null)) return undefined;
	const text = content
		.filter(
			(part): part is { readonly type: "text"; readonly text: string } =>
				part.type === "text" && typeof part.text === "string",
		)
		.map(part => part.text)
		.join("");
	return text.length === 0 && content.length > 0 ? undefined : text;
}
