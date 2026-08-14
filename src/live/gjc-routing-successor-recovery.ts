import type { SessionOperation } from "../gjc/session-authority";
import { discoverFreshGjcSessionFile } from "../gjc/session-loader";
import type { SessionMapping, SessionMappingStore } from "../gjc/session-router";
import type { GjcLifecycleTransaction } from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput, LiveGatewayRunnerResult } from "./chat-completions";
import { readPublishedSdkEndpoint, validatePersistedSessionIdentity } from "./gjc-routing-endpoints";
import { sameAttachmentProof } from "./gjc-routing-proof";
import { withCanonicalModel } from "./gjc-routing-selection";

export interface RecoveredAcknowledgedSuccessor {
	readonly sessionFile: string;
	readonly attachment: NonNullable<SessionOperation["acknowledgedSuccessor"]>["attachment"];
}

export async function findRecoveredAcknowledgedSuccessor(
	turn: LiveGatewayRunnerInput,
	predecessor: SessionMapping,
	operation: SessionOperation,
	hash: string,
): Promise<RecoveredAcknowledgedSuccessor> {
	const successor = operation.acknowledgedSuccessor;
	if (successor === undefined || operation.kind !== "create" || operation.detail !== hash)
		throw new Error(`GJC operation ${turn.userMessageId} requires reconciliation.`);
	const sessionRoot = turn.project.sessionRoot ?? `${turn.project.cwd}/.gjc/sessions`;
	try {
		const published = await readPublishedSdkEndpoint(turn.project.cwd, successor.sessionId);
		if (published === undefined || !sameAttachmentProof(successor.attachment, published))
			throw new Error("stored endpoint proof does not match the current descriptor");
		const transcript = await discoverFreshGjcSessionFile(
			sessionRoot,
			new Set(),
			successor.sessionId,
			turn.project.cwd,
		);
		await validatePersistedSessionIdentity({
			cwd: turn.project.cwd,
			sessionRoot,
			projectId: predecessor.projectId,
			chatId: turn.chatId,
			sessionId: successor.sessionId,
			sessionFile: transcript.filePath,
		});
		return { sessionFile: transcript.filePath, attachment: successor.attachment };
	} catch {
		throw new Error(`GJC operation ${turn.userMessageId} requires reconciliation.`);
	}
}

export async function publishRecoveredAcknowledgedSuccessor(
	mappings: SessionMappingStore,
	turn: LiveGatewayRunnerInput,
	predecessor: SessionMapping,
	lifecycle: GjcLifecycleTransaction,
	hash: string,
	recovered: RecoveredAcknowledgedSuccessor,
): Promise<LiveGatewayRunnerResult & { readonly model?: string }> {
	const mapping = await lifecycle.publish(recovered.attachment, () =>
		mappings.completeOperationWithMapping(
			turn.chatId,
			turn.userMessageId,
			hash,
			{
				...predecessor,
				sessionId: lifecycle.address.sessionId,
				sessionFile: recovered.sessionFile,
				operationId: turn.userMessageId,
				attachment: recovered.attachment,
			},
			"control",
		),
	);
	return withCanonicalModel({ content: mapping.assistantText ?? "" }, mapping.modelSelection);
}
