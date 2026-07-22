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
import { turnResult } from "./gjc-routing-proof";
import { runLifecycleTestBarrier } from "./gjc-routing-test-barrier";
import { projectSessionArtifactEvents } from "./gjc-session-artifact-events";

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
	let provisionalAuthorityPersisted = false;
	try {
		const address = {
			...addressFor(input, lifecycleAttachment.sessionId),
		};
		const initialPublished = await waitForSdkEndpoint(input.cwd, lifecycleAttachment.sessionId);
		await runLifecycleTestBarrier(context.input.testBarrierHook, "post_cli_pre_bind", initialPublished);
		const published = await requireCurrentPublishedSdkEndpoint(input.cwd, initialPublished);
		const attachment = attachmentFor(address, { ...lifecycleAttachment, published });
		context.attachments.set(attachmentKey(address), attachment);
		const { withLifecycle } = await import("./gjc-public-sdk-close");
		return await withLifecycle(
			context,
			address,
			async lifecycle => {
				try {
					const provisionalProof = await currentAttachmentProof(published, attachment, lifecycle);
					requireExactProvisionalProof(provisionalProof);
					await beforePrompt(address, provisionalProof, lifecycle);
					provisionalAuthorityPersisted = true;
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
							...turnResult(
								await withSessionArtifactEvents(result.outcome, transcript.filePath, input.text),
								transcript.filePath,
								result.modelSelection,
								currentProof,
							),
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
	} catch (error) {
		if (provisionalAuthorityPersisted) throw error;
		context.attachments.delete(attachmentKey(addressFor(input, lifecycleAttachment.sessionId)));
		try {
			const fallback = await backend.fallbackBeforeCloseAcknowledgement(lifecycleAttachment);
			if (fallback.status !== "closed") throw new Error(fallback.message);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "new GJC session pre-prompt cleanup is uncertain");
		}
		throw error;
	}
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
		await withSessionArtifactEvents(result.outcome, input.sessionFile, input.text),
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
async function withSessionArtifactEvents(
	outcome: import("../gjc/public-sdk-contract").PublicSdkTurnOutcome,
	sessionFile: string | undefined,
	promptText: string,
): Promise<import("../gjc/public-sdk-contract").PublicSdkTurnOutcome> {
	const artifactEvents = await projectSessionArtifactEvents(sessionFile, promptText);
	if (artifactEvents.length === 0) return outcome;
	return mergeSessionArtifactEvents(outcome, artifactEvents);
}

export function mergeSessionArtifactEvents(
	outcome: import("../gjc/public-sdk-contract").PublicSdkTurnOutcome,
	artifactEvents: readonly { readonly type: string; readonly payload?: Readonly<Record<string, unknown>> }[],
): import("../gjc/public-sdk-contract").PublicSdkTurnOutcome {
	const projected = artifactEvents.map(event => ({
		type: event.type,
		...(event.payload === undefined ? {} : event.payload),
	}));
	const terminalIndex = outcome.events.findIndex(event =>
		["agent_end", "agent_failed", "action_needed"].includes(String(event.type)),
	);
	const insertionIndex = terminalIndex === -1 ? outcome.events.length : terminalIndex;
	return {
		...outcome,
		events: [...outcome.events.slice(0, insertionIndex), ...projected, ...outcome.events.slice(insertionIndex)],
	};
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
