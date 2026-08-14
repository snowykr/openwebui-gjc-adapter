import { createHash } from "node:crypto";
import type { SessionMapping } from "../gjc/session-router";
import { pendingWorkflowGateFromEvent } from "../projection/workflow-gates";
import type { LiveGatewayRunnerInput } from "./chat-completions";

export function markWorkflowGateAccepted(
	events: NonNullable<SessionMapping["events"]>,
	gateId: string,
): readonly (typeof events)[number][] {
	return events.map(event => {
		if (event.type !== "workflow_gate") return event;
		if (pendingWorkflowGateFromEvent(event)?.gateId !== gateId) return event;
		return {
			...event,
			payload: {
				...(event.payload ?? {}),
				status: "accepted",
			},
		};
	});
}

export function workflowGateResponseIdempotencyKey(chatId: string, userMessageId: string): string {
	return `${chatId}:${userMessageId}`;
}

export interface WorkflowGateIdentity {
	readonly gateId: string;
	readonly commandId?: string;
	readonly turnId?: string;
	readonly sessionId?: string;
}

export function workflowGateOperationHash(turn: LiveGatewayRunnerInput, gate: WorkflowGateIdentity): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				chatId: turn.chatId,
				projectId: turn.project.id,
				parentId: turn.userMessageParentId,
				prompt: turn.prompt,
				gateId: gate.gateId,
				correlation: {
					commandId: gate.commandId,
					turnId: gate.turnId,
					sessionId: gate.sessionId,
				},
			}),
		)
		.digest("hex");
}
