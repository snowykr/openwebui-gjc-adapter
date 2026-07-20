import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { NormalizedModelSelection } from "../contracts";
import { CliLifecycleBackend } from "../gjc/cli-lifecycle-backend";
import type {
	PublicSdkSessionAttachment,
	PublicSdkSessionPort,
	PublicSdkTurnOutcome,
} from "../gjc/public-sdk-contract";
import {
	PublicSdkSessionClient,
	samePublishedSdkEndpoint,
	withPublicSdkSessionMutationCoordinator,
} from "../gjc/public-sdk-session-port";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
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
	addressFor,
	attachmentFor,
	attachmentKey,
	discoverPublishedSdkEndpoint,
	readPublishedSdkEndpoint,
	requireCurrentPublishedSdkEndpoint,
	requireLifecycleAttachment,
	validateCachedAttachment,
	validatePersistedSessionIdentity,
	waitForSdkEndpoint,
} from "./gjc-routing-endpoints";
import type { PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import {
	attachmentProof,
	canRetainColdResumePane,
	isPositiveSafeInteger,
	runLifecycleTestBarrier,
	type SessionAttachment,
	turnResult,
} from "./gjc-routing-proof";
import { isModelSelectionApplyFailure } from "./gjc-routing-selection";
import { modelSelectionError } from "./model-selection-errors";

export async function startNewSession<T>(
	context: PublicSdkRunnerContext,
	input: GjcStartNewSessionInput,
	publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
	beforePrompt: (
		address: GjcSessionAddress & { readonly sessionFile: string },
		attachment: import("../gjc/session-authority").SessionAttachmentProof,
		lifecycle: GjcLifecycleTransaction,
	) => Promise<void>,
	onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
): Promise<T> {
	await mkdir(input.sessionRoot, { recursive: true });
	const backend = new CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: input.cwd,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	const lifecycleAttachment = requireLifecycleAttachment(await backend.create({ sessionRoot: input.sessionRoot }));
	const address = {
		...addressFor(input, lifecycleAttachment.sessionId),
		sessionFile: lifecycleAttachment.sessionPath,
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
			const proof = await currentAttachmentProof(published, attachment, lifecycle);
			try {
				await beforePrompt(address, proof, lifecycle);
				const result = await withMutationPort(context, attachment, lifecycle, port =>
					prompt(context, port, input.text, input.modelSelection),
				);
				const currentProof = await currentAttachmentProof(
					await requireCurrentPublishedSdkEndpoint(input.cwd, attachment.published!),
					attachment,
					lifecycle,
				);
				return publish(
					{
						...addressFor(input, attachment.sessionId),
						...turnResult(result.outcome, lifecycleAttachment.sessionPath, result.modelSelection, currentProof),
					},
					lifecycle,
				);
			} catch (error) {
				await onFailure?.(lifecycle, error);
				throw error;
			}
		},
		true,
	);
}

export async function switchSession(context: PublicSdkRunnerContext, input: GjcSwitchSessionInput): Promise<void> {
	await ensureAttachment(context, input, input.lifecycle);
}

export async function getState(context: PublicSdkRunnerContext, input: GjcSessionStateInput): Promise<GjcSessionState> {
	const attachment = await ensureAttachment(context, input, input.lifecycle);
	await withPort(context, attachment, input.lifecycle, port => port.getState(context.input.turnTimeoutMs));
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
export async function ensureAttachment(
	context: PublicSdkRunnerContext,
	input: GjcSessionAddress & {
		readonly sessionFile?: string;
		readonly recoveryAttachment?: import("../gjc/session-authority").SessionAttachmentProof;
	},
	lifecycle: GjcLifecycleTransaction,
): Promise<SessionAttachment> {
	const key = attachmentKey(input);
	const known = context.attachments.get(key);
	if (known?.published !== undefined) return refreshKnownAttachment(context, input, lifecycle, key, known);
	if (known !== undefined) context.attachments.delete(key);
	if (input.sessionFile === undefined)
		throw new Error("A persisted GJC session file is required to resume a public SDK session.");
	await validatePersistedSessionIdentity({ ...input, sessionFile: input.sessionFile });
	const published = await discoverPublishedSdkEndpoint(input.cwd, input.sessionId);
	if (published !== undefined) {
		await verifyPublishedAttachment(context, published, lifecycle);
		const attachment = attachmentFor(input, {
			...(await recoverAttachment(context, { ...input, sessionFile: input.sessionFile, published })),
			published,
		});
		context.attachments.set(key, attachment);
		return attachment;
	}
	const backend = new CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: input.cwd,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	const resumed = requireLifecycleAttachment(await backend.coldResume({ existingSessionPath: input.sessionFile }));
	if (resumed.sessionId !== input.sessionId) {
		const cleanup = await backend.fallbackBeforeCloseAcknowledgement(resumed);
		const detail = cleanup.status === "closed" ? "" : `; owned pane cleanup is ${cleanup.status}: ${cleanup.message}`;
		throw new Error(
			`Resumed GJC session identity ${resumed.sessionId} does not match persisted mapping ${input.sessionId}${detail}`,
		);
	}
	const publishedAfterResume = await waitForSdkEndpoint(input.cwd, input.sessionId);
	await runLifecycleTestBarrier(context.input.testBarrierHook, "post_cli_pre_bind", publishedAfterResume);
	const attachment = attachmentFor(input, {
		...resumed,
		published: await requireCurrentPublishedSdkEndpoint(input.cwd, publishedAfterResume),
		...(canRetainColdResumePane(resumed, publishedAfterResume) ? {} : { pane: undefined }),
	});
	context.attachments.set(key, attachment);
	return attachment;
}

async function refreshKnownAttachment(
	context: PublicSdkRunnerContext,
	input: GjcSessionAddress & {
		readonly sessionFile?: string;
		readonly recoveryAttachment?: import("../gjc/session-authority").SessionAttachmentProof;
	},
	lifecycle: GjcLifecycleTransaction,
	key: string,
	known: SessionAttachment,
): Promise<SessionAttachment> {
	await validateCachedAttachment(known, input);
	const published = await readPublishedSdkEndpoint(input.cwd, input.sessionId);
	if (published !== undefined && samePublishedSdkEndpoint(known.published!, published)) {
		await currentAttachmentProof(published, known, lifecycle);
		return known;
	}
	context.attachments.delete(key);
	if (input.sessionFile === undefined || published === undefined)
		throw new SdkV3OperationError("endpoint_stale", "Cached GJC endpoint disappeared during lifecycle transaction");
	await verifyPublishedAttachment(context, published, lifecycle);
	const replacement = attachmentFor(input, {
		...(await recoverAttachment(context, { ...input, sessionFile: input.sessionFile, published })),
		published,
		pane: undefined,
	});
	context.attachments.set(key, replacement);
	return replacement;
}

export async function freshAttachmentProof(
	cwd: string,
	attachment: SessionAttachment,
	lifecycle: GjcLifecycleTransaction,
): Promise<import("../gjc/session-authority").SessionAttachmentProof> {
	return currentAttachmentProof(
		await requireCurrentPublishedSdkEndpoint(cwd, attachment.published!),
		attachment,
		lifecycle,
	);
}

export async function currentAttachmentProof(
	published: PublicSdkSessionAttachment,
	attachment: SessionAttachment,
	lifecycle: GjcLifecycleTransaction,
): Promise<import("../gjc/session-authority").SessionAttachmentProof> {
	if (resolve(lifecycle.address.cwd) !== published.cwd || lifecycle.address.sessionId !== published.sessionId)
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Active lifecycle address does not match the published GJC endpoint",
		);
	if (attachment.published !== undefined && !samePublishedSdkEndpoint(attachment.published, published))
		throw new SdkV3OperationError("endpoint_stale", "Published GJC endpoint changed during lifecycle transaction");
	if (
		attachment.pane !== undefined &&
		isPositiveSafeInteger(published.endpoint.pid) &&
		published.endpoint.pid !== attachment.pane.panePid
	)
		return attachmentProof(published, { ...attachment, pane: undefined });
	return attachmentProof(published, attachment);
}

async function recoverAttachment(
	context: PublicSdkRunnerContext,
	input: GjcSessionAddress & {
		readonly sessionFile: string;
		readonly recoveryAttachment?: import("../gjc/session-authority").SessionAttachmentProof;
		readonly published?: PublicSdkSessionAttachment;
	},
): Promise<Omit<SessionAttachment, "projectId">> {
	const base = {
		cwd: resolve(input.cwd),
		sessionRoot: resolve(input.sessionRoot),
		sessionId: input.sessionId,
		sessionPath: input.sessionFile,
	};
	const proof = input.recoveryAttachment;
	if (
		proof === undefined ||
		input.published === undefined ||
		proof.tmuxSocket === undefined ||
		proof.tmuxPane === undefined ||
		proof.tmuxPanePid === undefined ||
		proof.tmuxOwnershipTag === undefined
	)
		return base;
	const pane = {
		socketName: proof.tmuxSocket,
		target: proof.tmuxPane,
		panePid: proof.tmuxPanePid,
		ownershipTag: proof.tmuxOwnershipTag,
	};
	const backend = new CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: base.cwd,
		tmuxSocket: pane.socketName,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	return (await backend.readiness({ ...base, pane })).status === "closed" ? { ...base, pane } : base;
}

export async function withMutationPort<T>(
	context: PublicSdkRunnerContext,
	attachment: SessionAttachment,
	lifecycle: GjcLifecycleTransaction,
	operation: (port: PublicSdkSessionPort) => Promise<T>,
): Promise<T> {
	return withPort(context, attachment, lifecycle, async port => {
		const result = await operation(port);
		if (attachment.published === undefined)
			throw new SdkV3OperationError("endpoint_stale", "GJC session attachment has no retained published endpoint");
		await runLifecycleTestBarrier(context.input.testBarrierHook, "post_mutation_pre_proof", attachment.published);
		await requireCurrentPublishedSdkEndpoint(attachment.published.cwd, attachment.published);
		return result;
	});
}

export async function withPort<T>(
	context: PublicSdkRunnerContext,
	attachment: SessionAttachment,
	lifecycle: GjcLifecycleTransaction,
	operation: (port: PublicSdkSessionPort) => Promise<T>,
): Promise<T> {
	if (attachment.published === undefined)
		throw new SdkV3OperationError("endpoint_stale", "GJC session attachment has no retained published endpoint");
	const port = (context.input.sessionPortFactory ?? (() => new PublicSdkSessionClient()))();
	try {
		return await withPublicSdkSessionMutationCoordinator(attachment.published, lifecycle.owner, async () => {
			await port.attach(attachment.published!, context.input.turnTimeoutMs, lifecycle.owner);
			return operation(port);
		});
	} finally {
		port.detach();
	}
}

export async function prompt(
	context: PublicSdkRunnerContext,
	port: PublicSdkSessionPort,
	text: string,
	selection?: NormalizedModelSelection,
): Promise<{ readonly outcome: PublicSdkTurnOutcome; readonly modelSelection?: NormalizedModelSelection }> {
	let modelSelection = selection;
	if (selection !== undefined) {
		try {
			modelSelection = await port.setThinking(
				(await port.setModel(selection, undefined, context.input.turnTimeoutMs)).thinkingLevel,
				undefined,
				context.input.turnTimeoutMs,
			);
		} catch (error) {
			if (isModelSelectionApplyFailure(error)) throw modelSelectionError("model_selection_apply_failed");
			throw error;
		}
	}
	return { outcome: await port.prompt(text, context.input.turnTimeoutMs), modelSelection };
}

async function verifyPublishedAttachment(
	context: PublicSdkRunnerContext,
	attachment: PublicSdkSessionAttachment,
	lifecycle: GjcLifecycleTransaction,
): Promise<void> {
	const port = (context.input.sessionPortFactory ?? (() => new PublicSdkSessionClient()))();
	try {
		await port.attach(attachment, context.input.turnTimeoutMs, lifecycle.owner);
		await port.getState(context.input.turnTimeoutMs);
	} finally {
		port.detach();
	}
}
