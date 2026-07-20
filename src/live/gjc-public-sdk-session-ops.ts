import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { CliLifecycleBackend } from "../gjc/cli-lifecycle-backend";
import { discoverFreshGjcSessionFile, snapshotGjcSessionFiles } from "../gjc/session-loader";
import type {
	GjcContinueSessionInput,
	GjcLifecycleTransaction,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
} from "../gjc/turn-runner";
import {
	currentAttachmentProof,
	ensureAttachment,
	freshAttachmentProof,
	prompt,
	withMutationPort,
	withPort,
} from "./gjc-public-sdk-session-attachment";
import {
	addressFor,
	attachmentFor,
	attachmentKey,
	requireCurrentPublishedSdkEndpoint,
	requireLifecycleAttachment,
	waitForSdkEndpoint,
} from "./gjc-routing-endpoints";
import type { PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import { runLifecycleTestBarrier, turnResult } from "./gjc-routing-proof";

export {
	currentAttachmentProof,
	ensureAttachment,
	freshAttachmentProof,
	prompt,
	withMutationPort,
	withPort,
} from "./gjc-public-sdk-session-attachment";

export async function startNewSession<T>(
	context: PublicSdkRunnerContext,
	input: GjcStartNewSessionInput,
	publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
	beforePrompt: (
		address: GjcSessionAddress,
		attachment: import("../gjc/session-authority").SessionAttachmentProof,
		lifecycle: GjcLifecycleTransaction,
	) => Promise<void>,
	onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
): Promise<T> {
	await mkdir(input.sessionRoot, { recursive: true });
	const baseline = await snapshotGjcSessionFiles(input.sessionRoot);
	const backend = new CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: input.cwd,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	const lifecycleAttachment = requireLifecycleAttachment(
		await backend.createEphemeral({ sessionRoot: input.sessionRoot }),
	);
	const address = {
		...addressFor(input, lifecycleAttachment.sessionId),
	};
	const initialPublished = await waitForSdkEndpoint(input.cwd, lifecycleAttachment.sessionId);
	await runLifecycleTestBarrier(context.input.testBarrierHook, "post_cli_pre_bind", initialPublished);
	const published = await requireCurrentPublishedSdkEndpoint(input.cwd, initialPublished);
	const attachment = attachmentFor(address, { ...lifecycleAttachment, published });
	context.attachments.set(attachmentKey(address), attachment);
	const { withLifecycle } = await import("./gjc-public-sdk-close");
	return withLifecycle(
		context,
		address,
		async lifecycle => {
			try {
				const provisionalProof = await currentAttachmentProof(published, attachment, lifecycle);
				requireExactProvisionalProof(provisionalProof);
				await beforePrompt(address, provisionalProof, lifecycle);
				const result = await withMutationPort(context, attachment, lifecycle, port =>
					prompt(context, port, input.text, input.modelSelection),
				);
				const transcript = await discoverFreshGjcSessionFile(
					input.sessionRoot,
					baseline,
					lifecycleAttachment.sessionId,
					resolve(input.cwd),
				);
				const addressWithSessionFile = { ...address, sessionFile: transcript.filePath };
				const durableAttachment = attachmentFor(addressWithSessionFile, {
					...lifecycleAttachment,
					sessionPath: transcript.filePath,
					published: await requireCurrentPublishedSdkEndpoint(input.cwd, attachment.published!),
				});
				context.attachments.set(attachmentKey(addressWithSessionFile), durableAttachment);
				const currentProof = await currentAttachmentProof(
					durableAttachment.published!,
					durableAttachment,
					lifecycle,
				);
				return publish(
					{
						...addressWithSessionFile,
						...turnResult(result.outcome, transcript.filePath, result.modelSelection, currentProof),
					},
					lifecycle,
				);
			} catch (error) {
				await onFailure?.(lifecycle, error);
				throw error;
			}
		},
		false,
	);
}

export async function switchSession(context: PublicSdkRunnerContext, input: GjcSwitchSessionInput): Promise<void> {
	await ensureAttachment(context, input, input.lifecycle);
}

export async function getState(context: PublicSdkRunnerContext, input: GjcSessionStateInput): Promise<GjcSessionState> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	const published = await requireCurrentPublishedSdkEndpoint(input.cwd, attachment.published!);
	return {
		...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
		rawFrameCursor: 0,
		eventCursor: 0,
		attachment: await currentAttachmentProof(published, attachment, input.lifecycle),
	};
}

export async function continueSession(
	context: PublicSdkRunnerContext,
	input: GjcContinueSessionInput,
): Promise<GjcTurnResult> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	const result = await withMutationPort(context, attachment, input.lifecycle, port =>
		prompt(context, port, input.text, input.modelSelection),
	);
	return turnResult(
		result.outcome,
		input.sessionFile,
		result.modelSelection,
		await freshAttachmentProof(input.cwd, attachment, input.lifecycle),
	);
}

export async function getAvailableModels(
	context: PublicSdkRunnerContext,
	input: GjcSessionStateInput,
): Promise<readonly unknown[]> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	return withPort(context, attachment, input.lifecycle, port => port.getAvailableModels(context.input.turnTimeoutMs));
}

export async function respondWorkflowGate(
	context: PublicSdkRunnerContext,
	input: import("../gjc/turn-runner").GjcRespondWorkflowGateInput,
): Promise<GjcTurnResult> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	const gate = {
		gateId: input.gateId,
		correlation: input.gateCorrelation ?? {
			sessionId: attachment.sessionId,
			commandId: input.operationId,
			turnId: input.operationId,
		},
		payload: {},
	};
	const outcome = await withMutationPort(context, attachment, input.lifecycle, port =>
		port.answerGate(gate, input.answer, input.idempotencyKey, context.input.turnTimeoutMs),
	);
	return turnResult(
		outcome,
		input.sessionFile,
		undefined,
		await freshAttachmentProof(input.cwd, attachment, input.lifecycle),
	);
}
function requireExactProvisionalProof(proof: import("../gjc/session-authority").SessionAttachmentProof): void {
	if (
		proof.tmuxSocket === undefined ||
		proof.tmuxPane === undefined ||
		proof.tmuxPanePid === undefined ||
		proof.tmuxOwnershipTag === undefined
	)
		throw new Error("New GJC session provisional authority requires an exact owned pane proof.");
}
