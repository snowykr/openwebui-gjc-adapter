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
import type { GjcLifecycleTransaction, GjcSessionAddress } from "../gjc/turn-runner";
import {
	attachmentFor,
	attachmentKey,
	discoverPublishedSdkEndpoint,
	readPublishedSdkEndpoint,
	requireCurrentPublishedSdkEndpoint,
	requireLifecycleAttachment,
	validateCachedAttachment,
	validatePersistedSessionIdentity,
	verifyPublishedEndpointAttachment,
	waitForSdkEndpoint,
} from "./gjc-routing-endpoints";
import { cleanupColdResumeFailure, type PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import {
	attachmentProof,
	canRetainColdResumePane,
	isPositiveSafeInteger,
	runLifecycleTestBarrier,
	type SessionAttachment,
} from "./gjc-routing-proof";
import { isModelSelectionApplyFailure } from "./gjc-routing-selection";
import { modelSelectionError } from "./model-selection-errors";

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
		await verifyPublishedEndpointAttachment(context, published, lifecycle);
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
	if (resumed.sessionId !== input.sessionId)
		return cleanupColdResumeFailure(
			new Error(
				`Resumed GJC session identity ${resumed.sessionId} does not match persisted mapping ${input.sessionId}`,
			),
			() => backend.fallbackBeforeCloseAcknowledgement(resumed),
		);
	try {
		const publishedAfterResume = await waitForSdkEndpoint(input.cwd, input.sessionId);
		await runLifecycleTestBarrier(context.input.testBarrierHook, "post_cli_pre_bind", publishedAfterResume);
		const attachment = attachmentFor(input, {
			...resumed,
			published: await requireCurrentPublishedSdkEndpoint(input.cwd, publishedAfterResume),
			...(canRetainColdResumePane(resumed, publishedAfterResume) ? {} : { pane: undefined }),
		});
		context.attachments.set(key, attachment);
		return attachment;
	} catch (error) {
		return cleanupColdResumeFailure(error, () => backend.fallbackBeforeCloseAcknowledgement(resumed));
	}
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
	await verifyPublishedEndpointAttachment(context, published, lifecycle);
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
