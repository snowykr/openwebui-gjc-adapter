import { createHash } from "node:crypto";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import type { GjcControlResult, GjcLifecycleTransaction } from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "./chat-completions";

export async function publishControlMapping(
	mappings: SessionMappingStore,
	lifecycle: GjcLifecycleTransaction,
	turn: LiveGatewayRunnerInput,
	existing: SessionMapping,
	applied: GjcControlResult,
	hash: string,
	afterPublish: (mapping: SessionMapping) => void,
): Promise<SessionMapping> {
	const proof = applied.result?.attachment ?? applied.attachment;
	if (proof === undefined) throw new Error("GJC control did not return a validated current attachment.");
	return lifecycle.publish(proof, () => {
		const published = mappings.completeOperationWithMapping(
			turn.chatId,
			turn.userMessageId,
			hash,
			{
				...existing,
				...(applied.sessionId === undefined ? {} : { sessionId: applied.sessionId }),
				...(applied.sessionFile === undefined ? {} : { sessionFile: applied.sessionFile }),
				operationId: turn.userMessageId,
				assistantText: applied.result?.text ?? existing.assistantText ?? "",
				attachment: proof,
				...(applied.result === undefined
					? {}
					: {
							rawFrameCursor: applied.result.rawFrameCursor,
							eventCursor: applied.result.eventCursor,
							events: applied.result.events,
						}),
			},
			"control",
		);
		afterPublish(published);
		return published;
	});
}

export function controlOperationKind(
	operation: NonNullable<LiveGatewayRunnerInput["control"]>["operation"],
): "branch" | "reply" | "gate" | "prompt" {
	if (operation === "branch") return "branch";
	if (operation === "action_reply") return "reply";
	if (operation === "workflow.plan_approve") return "gate";
	return "prompt";
}

export function controlOperationHash(turn: LiveGatewayRunnerInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				chatId: turn.chatId,
				projectId: turn.project.id,
				parentId: turn.userMessageParentId,
				prompt: turn.prompt,
				control: turn.control,
			}),
		)
		.digest("hex");
}
