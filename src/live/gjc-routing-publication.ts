import { createHash } from "node:crypto";
import type { LiveGatewayRunnerInput } from "./chat-completions";

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
