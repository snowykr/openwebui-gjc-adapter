import { createHash } from "node:crypto";
import type { ManagedTurnAuthority } from "../gjc/turn-runner";
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

export function lifecycleControlRequestKey(
	authority: ManagedTurnAuthority,
	operation: "session.fork" | "session.create",
	ingressId: string,
	payloadHash: string,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				operation,
				principalId: authority.principalId,
				projectId: authority.projectId,
				canonicalWorkspace: authority.canonicalWorkspace,
				chatId: authority.chatId,
				sessionId: authority.sessionId,
				generation: authority.generation,
				leaseId: authority.leaseId,
				epoch: authority.epoch,
				ingressId,
				payloadHash,
			}),
		)
		.digest("hex");
}
