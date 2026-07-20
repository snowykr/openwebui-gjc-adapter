import type { ProvisionalSessionOperation } from "./session-authority";
import { validateSessionFile } from "./session-file";
import { hashTurnIngress, normalizeModelSelection } from "./session-operation-codec";
import { resolveEffectiveGjcSessionRoot } from "./session-root";
import type { RouteGjcTurnInput, RouteGjcTurnResult } from "./session-turn-router-contract";
import { getProjectSessionRoot } from "./turn-runner";

export async function startNewMappedSession(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	const operation = provisionalOperation(input);
	const reserved = input.mappings.reserveProvisionalOperation(operation);
	if (reserved.state !== "pending") {
		throw new Error(
			reserved.state === "complete"
				? `GJC operation ${input.userMessageId} completed without a published session mapping.`
				: `GJC operation ${input.userMessageId} requires reconciliation.`,
		);
	}
	const sessionRoot = resolveEffectiveGjcSessionRoot(
		input.project.cwd,
		getProjectSessionRoot(input.project),
		input.runner.resolveSessionRoot,
	);
	let authorityCompleted = false;
	const markUncertain = () => {
		if (!authorityCompleted)
			input.mappings.transitionProvisionalOperation(
				input.chatId,
				input.userMessageId,
				"uncertain",
				operation.detail,
			);
	};
	try {
		return await input.runner.startNewSession(
			{
				cwd: input.project.cwd,
				sessionRoot,
				projectId: input.project.id,
				chatId: input.chatId,
				userMessageId: input.userMessageId,
				parentId: input.parentId,
				text: input.text,
				...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
			},
			async (result, lifecycle) => {
				const completedSelection =
					input.modelSelection === undefined ? undefined : normalizeModelSelection(result.modelSelection);
				if (input.modelSelection !== undefined && completedSelection === undefined)
					throw new TypeError("Missing selected GJC outcome");
				if (result.attachment === undefined)
					throw new Error("New GJC session did not return a validated current attachment.");
				const assistantText = input.projectAssistantText?.(result) ?? result.text;
				const mapping = await lifecycle.publish(result.attachment, () => {
					const published = input.mappings.publishProvisionalOperation(operation, {
						chatId: input.chatId,
						projectId: input.project.id,
						sessionId: result.sessionId,
						sessionFile: validateSessionFile(input.project, result.sessionFile, sessionRoot),
						activeLeaf: result.activeLeaf,
						rawFrameCursor: result.rawFrameCursor,
						eventCursor: result.eventCursor,
						operationId: input.userMessageId,
						assistantText,
						events: result.events,
						attachment: result.attachment,
						...(completedSelection === undefined ? {} : { modelSelection: completedSelection }),
					});
					authorityCompleted = true;
					input.afterPublish?.({ assistantText, events: result.events, mapping: published });
					return published;
				});
				return { assistantText, events: result.events, mapping };
			},
			async (address, attachment) => {
				input.mappings.attachProvisionalOperation(input.chatId, input.userMessageId, {
					sessionId: address.sessionId,
					attachment,
				});
			},
			async () => {
				markUncertain();
			},
		);
	} catch (error) {
		markUncertain();
		throw error;
	}
}
function provisionalOperation(
	input: RouteGjcTurnInput,
): Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt"> {
	return {
		id: input.userMessageId,
		kind: "create",
		ingressId: input.userMessageId,
		chatId: input.chatId,
		projectId: input.project.id,
		detail: hashTurnIngress({
			chatId: input.chatId,
			projectId: input.project.id,
			parentId: input.parentId,
			text: input.text,
			...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
		}),
	};
}
