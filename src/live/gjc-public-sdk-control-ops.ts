import { resolve } from "node:path";
import { authorizeBranchRegenerateCandidate, resolveBranchRegenerateAction } from "../branches/regenerate";
import { discoverFreshGjcSessionFile, snapshotGjcSessionFiles } from "../gjc/session-loader";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import type { GjcControlResult, GjcLifecycleTransaction } from "../gjc/turn-runner";
import type { SessionMapping } from "../gjc/session-router";
import { OpenWebUIControlError } from "./chat-completions-types";
import type { LiveGatewayRunnerInput } from "./chat-completions";
import {
	attachmentKey,
	validatePersistedSessionIdentity,
	waitForSdkEndpoint,
} from "./gjc-routing-endpoints";
import { attachmentProof, turnResult, type SessionAttachment } from "./gjc-routing-proof";
import type { PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import { ensureAttachment, freshAttachmentProof, withMutationPort, withPort } from "./gjc-public-sdk-session-ops";

export async function runControl(context: PublicSdkRunnerContext, input: LiveGatewayRunnerInput, mapping: SessionMapping, lifecycle: GjcLifecycleTransaction): Promise<GjcControlResult> {
	const control = input.control;
	if (control === undefined) throw new Error("OpenWebUI control request was not supplied.");
	if (control.operation === "unsupported") throw new OpenWebUIControlError(control.surface);
	if (control.operation === "session.new" || control.operation === "session.resume" || control.operation === "session.switch") {
		return runSessionControl(context, input, mapping, lifecycle);
	}
	if (control.operation === "branch") return runBranchControl(context, input, mapping, lifecycle);
	const attachment = await ensureAttachment(context, mappedAddress(input, mapping), lifecycle);
	const idempotencyKey = `${input.chatId}:${input.userMessageId}`;
	if (control.operation === "abort") {
		await withMutationPort(context, attachment, lifecycle, port => port.abort(idempotencyKey, context.input.turnTimeoutMs));
		return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
	}
	if (control.operation === "steer") {
		await withMutationPort(context, attachment, lifecycle, port => port.steer(control.text ?? input.prompt, idempotencyKey, context.input.turnTimeoutMs));
		return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
	}
	if (control.operation === "follow_up" || control.operation === "abort_and_prompt") {
		const outcome = await withMutationPort(context, attachment, lifecycle, port => control.operation === "follow_up" ? port.followUp(control.text ?? input.prompt, idempotencyKey, context.input.turnTimeoutMs) : port.abortAndPrompt(control.text ?? input.prompt, idempotencyKey, context.input.turnTimeoutMs));
		return { result: turnResult(outcome, mapping.sessionFile, undefined, await freshAttachmentProof(input.project.cwd, attachment, lifecycle)) };
	}
	if (control.operation === "action_reply") {
		await withMutationPort(context, attachment, lifecycle, port => port.replyToAction(control.actionId, control.answer, idempotencyKey, context.input.turnTimeoutMs));
		return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
	}
	if (control.operation !== "workflow.plan_approve") throw new Error(`Unsupported OpenWebUI control surface: ${control.operation}.`);
	await withMutationPort(context, attachment, lifecycle, port => port.planApprove(control.input, idempotencyKey, context.input.turnTimeoutMs));
	return { attachment: await freshAttachmentProof(input.project.cwd, attachment, lifecycle) };
}

async function runSessionControl(context: PublicSdkRunnerContext, input: LiveGatewayRunnerInput, mapping: SessionMapping, lifecycle: GjcLifecycleTransaction): Promise<GjcControlResult> {
	const control = input.control;
	if (control === undefined || (control.operation !== "session.new" && control.operation !== "session.resume" && control.operation !== "session.switch")) {
		throw new Error("OpenWebUI session control request was not supplied.");
	}
	const sessionRoot = resolve(input.project.sessionRoot ?? `${input.project.cwd}/.gjc/sessions`);
	const attachment = await ensureAttachment(context, mappedAddress(input, mapping, sessionRoot), lifecycle);
	const isNewSession = control.operation === "session.new";
	const baseline = isNewSession ? await snapshotGjcSessionFiles(sessionRoot) : undefined;
	let sessionTarget: { readonly sessionId: string; readonly sessionFile: string } | undefined;
	if (control.operation !== "session.new") {
		const sessionFile = control.sessionFile;
		if (sessionFile === undefined) throw new SdkV3OperationError("endpoint_stale", "A persisted GJC session file is required for lifecycle target authority");
		sessionTarget = { sessionId: control.sessionId, sessionFile };
		await validatePersistedSessionIdentity({ cwd: resolve(input.project.cwd), sessionRoot, projectId: mapping.projectId, chatId: mapping.chatId, sessionId: sessionTarget.sessionId, sessionFile: sessionTarget.sessionFile });
	}
	const key = `${input.chatId}:${input.userMessageId}`;
	const successor = await withMutationPort(context, attachment, lifecycle, port => {
		if (control.operation === "session.new") return port.newSession({}, key, context.input.turnTimeoutMs);
		if (sessionTarget === undefined) throw new SdkV3OperationError("endpoint_stale", "A persisted GJC session file is required for lifecycle target authority");
		if (control.operation === "session.resume") return port.resumeSession({ sessionId: sessionTarget.sessionId, sessionPath: sessionTarget.sessionFile }, key, context.input.turnTimeoutMs);
		return port.switchSession({ sessionId: sessionTarget.sessionId, sessionPath: sessionTarget.sessionFile }, key, context.input.turnTimeoutMs);
	});
	if (successor.cwd !== resolve(input.project.cwd) || (isNewSession && successor.sessionId === attachment.sessionId) || (!isNewSession && successor.sessionId !== sessionTarget?.sessionId)) throw new SdkV3OperationError("endpoint_stale", "Lifecycle operation did not bind to the expected successor in the mapped workspace");
	const sessionFile = isNewSession ? (await discoverFreshGjcSessionFile(sessionRoot, baseline ?? new Set<string>(), successor.sessionId, input.project.cwd)).filePath : sessionTarget?.sessionFile;
	if (sessionFile === undefined) throw new SdkV3OperationError("endpoint_stale", "A persisted GJC session file is required for lifecycle target authority");
	await validatePersistedSessionIdentity({ cwd: input.project.cwd, sessionRoot, projectId: mapping.projectId, chatId: mapping.chatId, sessionId: successor.sessionId, sessionFile });
	const successorAttachment: SessionAttachment = { cwd: resolve(input.project.cwd), sessionRoot, projectId: mapping.projectId, sessionId: successor.sessionId, sessionPath: sessionFile, published: successor };
	const proof = attachmentProof(successor, successorAttachment);
	const address = { cwd: input.project.cwd, sessionRoot, projectId: mapping.projectId, chatId: mapping.chatId, sessionId: successor.sessionId, sessionFile, recoveryAttachment: proof };
	context.attachments.set(attachmentKey(address), successorAttachment);
	await lifecycle.handoff(address, proof);
	return { sessionId: successor.sessionId, sessionFile, attachment: proof };
}

async function runBranchControl(context: PublicSdkRunnerContext, input: LiveGatewayRunnerInput, mapping: SessionMapping, lifecycle: GjcLifecycleTransaction): Promise<GjcControlResult> {
	const decision = resolveBranchRegenerateAction({ ownerUserId: input.ownerUserId, project: input.project, chatId: input.chatId, messageId: input.messageId, mappings: { get: () => mapping }, messageMetadata: input.messageMetadata });
	if (decision.action === "uncertain") throw new OpenWebUIControlError(`branch_lineage_${decision.reason}`);
	const sessionRoot = resolve(input.project.sessionRoot ?? `${input.project.cwd}/.gjc/sessions`);
	const baseline = await snapshotGjcSessionFiles(sessionRoot);
	const attachment = await ensureAttachment(context, mappedAddress(input, mapping, sessionRoot), lifecycle);
	const branched = await withPort(context, attachment, lifecycle, async port => {
		const authorized = authorizeBranchRegenerateCandidate(decision, await port.branchCandidates(context.input.turnTimeoutMs));
		if (authorized.action === "uncertain") throw new OpenWebUIControlError(`branch_lineage_${authorized.reason}`);
		return port.branch({ entryId: authorized.gjcEntryId }, `${input.chatId}:${input.userMessageId}`, context.input.turnTimeoutMs);
	});
	if (branched.sessionId === attachment.sessionId) throw new OpenWebUIControlError("branch_successor_identity");
	const sessionFile = (await discoverFreshGjcSessionFile(sessionRoot, baseline, branched.sessionId, input.project.cwd)).filePath;
	const published = await waitForSdkEndpoint(input.project.cwd, branched.sessionId);
	const successorAttachment: SessionAttachment = { cwd: resolve(input.project.cwd), sessionRoot, projectId: mapping.projectId, sessionId: branched.sessionId, sessionPath: sessionFile, published };
	const proof = attachmentProof(published, successorAttachment);
	context.attachments.set(attachmentKey({ cwd: input.project.cwd, sessionRoot, projectId: mapping.projectId, chatId: mapping.chatId, sessionId: branched.sessionId }), successorAttachment);
	return { sessionId: branched.sessionId, sessionFile, attachment: proof };
}

function mappedAddress(input: LiveGatewayRunnerInput, mapping: SessionMapping, sessionRoot = input.project.sessionRoot ?? `${input.project.cwd}/.gjc/sessions`) {
	return { cwd: input.project.cwd, sessionRoot, projectId: mapping.projectId, recoveryAttachment: mapping.attachment, chatId: mapping.chatId, sessionId: mapping.sessionId, sessionFile: mapping.sessionFile };
}
