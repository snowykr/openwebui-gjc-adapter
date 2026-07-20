import { resolve } from "node:path";
import { authorizeBranchRegenerateCandidate, resolveBranchRegenerateAction } from "../branches/regenerate";
import { CliLifecycleBackend } from "../gjc/cli-lifecycle-backend";
import type { PublicSdkSessionAttachment } from "../gjc/public-sdk-contract";
import type {
	AcknowledgedSuccessor,
	EndpointSessionAttachmentProof,
	SessionAttachmentProof,
} from "../gjc/session-authority-types";
import { discoverFreshGjcSessionFile, snapshotGjcSessionFiles } from "../gjc/session-loader";
import type { SessionMapping } from "../gjc/session-router";
import type { GjcControlResult, GjcLifecycleTransaction } from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "./chat-completions";
import { OpenWebUIControlError } from "./chat-completions-types";
import { ensureAttachment, withPort } from "./gjc-public-sdk-session-ops";
import { attachmentKey, waitForSdkEndpoint } from "./gjc-routing-endpoints";
import type { PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import { attachmentProof, isPositiveSafeInteger, type SessionAttachment } from "./gjc-routing-proof";

export async function successorAttachmentProof(
	context: PublicSdkRunnerContext,
	source: SessionAttachment,
	successor: PublicSdkSessionAttachment,
): Promise<SessionAttachmentProof> {
	const pane = source.pane;
	if (
		source.cwd === undefined ||
		pane === undefined ||
		pane.socketName === undefined ||
		!isPositiveSafeInteger(pane.panePid) ||
		!isPositiveSafeInteger(successor.endpoint.pid) ||
		pane.panePid !== successor.endpoint.pid
	)
		return attachmentProof(successor, {});
	const backend = new CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: source.cwd,
		tmuxSocket: pane.socketName,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	const ready = await backend.readiness({ ...source, pane });
	return attachmentProof(successor, ready.status === "closed" ? { pane } : {});
}
export function retainedSuccessorPane(
	source: SessionAttachment,
	proof: SessionAttachmentProof,
): SessionAttachment["pane"] | undefined {
	const pane = source.pane;
	if (
		pane === undefined ||
		pane.socketName === undefined ||
		!isPositiveSafeInteger(pane.panePid) ||
		proof.tmuxSocket !== pane.socketName ||
		proof.tmuxPane !== pane.target ||
		proof.tmuxPanePid !== pane.panePid ||
		proof.tmuxOwnershipTag !== pane.ownershipTag
	)
		return undefined;
	return pane;
}
export function endpointSuccessorProof(proof: SessionAttachmentProof): EndpointSessionAttachmentProof {
	const { descriptorPath, descriptorStat, payloadDigest, generation, expectedSessionId, expectedCwd } = proof;
	return { descriptorPath, descriptorStat, payloadDigest, generation, expectedSessionId, expectedCwd };
}

export async function handoffAcknowledgedNewSessionSuccessor(
	lifecycle: GjcLifecycleTransaction,
	input: {
		readonly cwd: string;
		readonly sessionRoot: string;
		readonly chatId: string;
	},
	mapping: Pick<SessionMapping, "projectId">,
	successor: PublicSdkSessionAttachment,
	proof: SessionAttachmentProof,
): Promise<SessionAttachmentProof> {
	await lifecycle.handoff(
		{
			cwd: input.cwd,
			sessionRoot: input.sessionRoot,
			projectId: mapping.projectId,
			chatId: input.chatId,
			sessionId: successor.sessionId,
			recoveryAttachment: proof,
		},
		proof,
	);
	return proof;
}

export async function discoverSuccessorSessionFile(
	sessionRoot: string,
	baseline: ReadonlySet<string>,
	sessionId: string,
	cwd: string,
): Promise<string> {
	return (await discoverFreshGjcSessionFile(sessionRoot, baseline, sessionId, cwd)).filePath;
}

export async function runBranchControl(
	context: PublicSdkRunnerContext,
	input: LiveGatewayRunnerInput,
	mapping: SessionMapping,
	lifecycle: GjcLifecycleTransaction,
	onAcknowledgedSuccessor?: (successor: AcknowledgedSuccessor) => Promise<void> | void,
): Promise<GjcControlResult> {
	const decision = resolveBranchRegenerateAction({
		ownerUserId: input.ownerUserId,
		project: input.project,
		chatId: input.chatId,
		messageId: input.messageId,
		mappings: { get: () => mapping },
		messageMetadata: input.messageMetadata,
	});
	if (decision.action === "uncertain") throw new OpenWebUIControlError(`branch_lineage_${decision.reason}`);
	const sessionRoot = resolve(input.project.sessionRoot ?? `${input.project.cwd}/.gjc/sessions`);
	const baseline = await snapshotGjcSessionFiles(sessionRoot);
	const attachment = await ensureAttachment(
		context,
		{
			cwd: input.project.cwd,
			sessionRoot,
			projectId: mapping.projectId,
			recoveryAttachment: mapping.attachment,
			chatId: mapping.chatId,
			sessionId: mapping.sessionId,
			sessionFile: mapping.sessionFile,
		},
		lifecycle,
	);
	const branched = await withPort(context, attachment, lifecycle, async port => {
		const authorized = authorizeBranchRegenerateCandidate(
			decision,
			await port.branchCandidates(context.input.turnTimeoutMs),
		);
		if (authorized.action === "uncertain") throw new OpenWebUIControlError(`branch_lineage_${authorized.reason}`);
		return port.branch(
			{ entryId: authorized.gjcEntryId },
			`${input.chatId}:${input.userMessageId}`,
			context.input.turnTimeoutMs,
			async successor => {
				await onAcknowledgedSuccessor?.({
					sessionId: successor.sessionId,
					attachment: endpointSuccessorProof(attachmentProof(successor, {})),
				});
			},
		);
	});
	if (branched.sessionId === attachment.sessionId) throw new OpenWebUIControlError("branch_successor_identity");
	const published = await waitForSdkEndpoint(input.project.cwd, branched.sessionId);
	const acknowledgedAttachment = await successorAttachmentProof(context, attachment, published);
	const sessionFile = await discoverSuccessorSessionFile(sessionRoot, baseline, branched.sessionId, input.project.cwd);
	const retainedPane = retainedSuccessorPane(attachment, acknowledgedAttachment);
	const successorAttachment: SessionAttachment = {
		cwd: resolve(input.project.cwd),
		sessionRoot,
		projectId: mapping.projectId,
		sessionId: branched.sessionId,
		sessionPath: sessionFile,
		published,
		...(retainedPane === undefined ? {} : { pane: retainedPane }),
	};
	const proof = acknowledgedAttachment;
	context.attachments.set(
		attachmentKey({
			cwd: input.project.cwd,
			sessionRoot,
			projectId: mapping.projectId,
			chatId: mapping.chatId,
			sessionId: branched.sessionId,
		}),
		successorAttachment,
	);
	return { sessionId: branched.sessionId, sessionFile, attachment: proof };
}
