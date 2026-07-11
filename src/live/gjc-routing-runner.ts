import type { GjcTurnRunner } from "../gjc/rpc-runner";
import { routeGjcTurn, type SessionMappingStore } from "../gjc/session-router";
import { projectPendingWorkflowGateMessage } from "../projection/workflow-gates";
import type { OutboxStore } from "../state/outbox";
import type { LiveGatewayRunner, LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import {
	buildEventPayloadHash,
	buildSessionMappingPayloadHash,
	handleWorkflowGateReply,
	latestPendingWorkflowGate,
	projectTurnEvents,
} from "./workflow-gate-turns";

export interface CreateGjcRoutingLiveGatewayRunnerInput {
	readonly turnRunner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
	readonly outbox?: OutboxStore;
	readonly ownerUserId?: string;
}

export function createGjcRoutingLiveGatewayRunner(input: CreateGjcRoutingLiveGatewayRunnerInput): LiveGatewayRunner {
	return {
		async run(turn: LiveGatewayRunnerInput): Promise<LiveGatewayRunnerResult> {
			const gateReplyResult = await handleWorkflowGateReply(input, turn);
			if (gateReplyResult !== null) return gateReplyResult;

			const result = await routeGjcTurn({
				project: turn.project,
				chatId: turn.chatId,
				userMessageId: turn.userMessageId,
				parentId: turn.userMessageParentId ?? undefined,
				text: turn.prompt,
				runner: input.turnRunner,
				mappings: input.mappings,
			});

			input.outbox?.enqueue({
				operationId: result.mapping.operationId,
				ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
				projectId: result.mapping.projectId,
				chatId: result.mapping.chatId,
				kind: "session_mapping",
				payloadHash: buildSessionMappingPayloadHash(result.mapping),
			});

			const projectedEvents = projectTurnEvents(result.events);
			if (projectedEvents.length > 0) {
				input.outbox?.enqueue({
					operationId: `${result.mapping.operationId}:events`,
					ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
					projectId: result.mapping.projectId,
					chatId: result.mapping.chatId,
					kind: "event",
					payloadHash: buildEventPayloadHash(projectedEvents),
				});
			}

			const pendingGate = latestPendingWorkflowGate(result.events);
			if (pendingGate !== null) {
				const gateMessage = projectPendingWorkflowGateMessage(pendingGate);
				const mapping = input.mappings.upsert({
					...result.mapping,
					assistantText: gateMessage,
				});
				input.outbox?.enqueue({
					operationId: `${mapping.operationId}:workflow_gate`,
					ownerUserId: input.ownerUserId ?? "openwebui-gjc-adapter",
					projectId: mapping.projectId,
					chatId: mapping.chatId,
					kind: "session_mapping",
					payloadHash: buildSessionMappingPayloadHash(mapping),
				});
				return projectedEvents.length > 0
					? { content: gateMessage, events: projectedEvents }
					: { content: gateMessage };
			}

			return projectedEvents.length > 0
				? { content: result.assistantText, events: projectedEvents }
				: { content: result.assistantText };
		},
	};
}
