import { dirname, resolve } from "node:path";
import {
	assertPublishedSdkAttachmentCurrent,
	withPublicSdkSessionMutationCoordinator,
} from "../gjc/public-sdk-session-port";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import type { GjcLifecycleTransaction } from "../gjc/turn-runner";
import { GjcCloseReceipt } from "../gjc/turn-runner";
import { ensureAttachment } from "./gjc-public-sdk-session-ops";
import { attachmentKey, readPublishedSdkEndpoint, validatePersistedSessionIdentity } from "./gjc-routing-endpoints";
import type { LifecycleAddress, LifecycleEffect, PublicSdkRunnerContext } from "./gjc-routing-lifecycle";
import {
	type SessionAttachment,
	sameActiveAttachmentProof,
	sameAttachmentProof,
	sameCloseReceiptSnapshot,
	sameExactActiveCloseProof,
	sameLifecycleAddress,
	samePublishedAttachmentSnapshot,
} from "./gjc-routing-proof";
import { runLifecycleTestBarrier } from "./gjc-routing-test-barrier";

export async function withLifecycle<T>(
	context: PublicSdkRunnerContext,
	address: LifecycleAddress,
	effect: LifecycleEffect<T>,
	ensureActiveAttachment: boolean,
): Promise<T> {
	const owner = {};
	let activeAddress = address;
	const lifecycle: GjcLifecycleTransaction = {
		owner,
		get address() {
			return activeAddress;
		},
		assertClosePreflight: proof => {
			const attachment = context.attachments.get(attachmentKey(activeAddress));
			if (attachment?.published === undefined || !sameExactActiveCloseProof(proof, attachment)) {
				throw new SdkV3OperationError(
					"endpoint_stale",
					"Close preflight proof no longer matches the exact active owned attachment",
				);
			}
			assertPublishedSdkAttachmentCurrent(attachment.published);
			const receipt = GjcCloseReceipt.fromPreflight(activeAddress, proof, attachment.published);
			context.closeReceipts.set(receipt, { attachment, owner, snapshot: receipt });
			return receipt;
		},
		publish: async (proof, write) => {
			const attachment = context.attachments.get(attachmentKey(activeAddress));
			if (attachment?.published === undefined || !sameActiveAttachmentProof(proof, attachment)) {
				throw new SdkV3OperationError(
					"endpoint_stale",
					"Lifecycle publication proof no longer matches the active attachment",
				);
			}
			assertPublishedSdkAttachmentCurrent(attachment.published);
			await runLifecycleTestBarrier(context.input.testBarrierHook, "pre_durable_publication", attachment.published);
			assertPublishedSdkAttachmentCurrent(attachment.published);
			return write();
		},
		publishClosed: async (receipt, write) => publishClosed(context, activeAddress, owner, receipt, write),
		handoff: async (successor, proof) => {
			const { waitForSdkEndpoint } = await import("./gjc-routing-endpoints");
			const published = await waitForSdkEndpoint(successor.cwd, successor.sessionId);
			assertPublishedSdkAttachmentCurrent(published);
			const { sameAttachmentProof } = await import("./gjc-routing-proof");
			if (!sameAttachmentProof(proof, published)) {
				throw new SdkV3OperationError("endpoint_stale", "Lifecycle successor proof changed before handoff");
			}
			activeAddress = successor;
		},
	};
	return withPublicSdkSessionMutationCoordinator(address, owner, async () => {
		if (ensureActiveAttachment) await ensureAttachment(context, address, lifecycle);
		else await reattachCloseOnly(context, address);
		return effect(lifecycle);
	});
}
async function reattachCloseOnly(context: PublicSdkRunnerContext, address: LifecycleAddress): Promise<void> {
	if (context.attachments.has(attachmentKey(address))) return;
	const proof = address.recoveryAttachment;
	if (
		address.sessionFile === undefined ||
		proof?.tmuxSocket === undefined ||
		proof.tmuxPane === undefined ||
		proof.tmuxPanePid === undefined ||
		proof.tmuxOwnershipTag === undefined
	)
		throw new SdkV3OperationError("endpoint_stale", "Close requires a persisted owned-pane attachment.");
	const sessionRoot = dirname(resolve(address.sessionFile));
	await validatePersistedSessionIdentity({ ...address, sessionRoot, sessionFile: address.sessionFile });
	const published = await readPublishedSdkEndpoint(address.cwd, address.sessionId);
	if (
		published === undefined ||
		!sameAttachmentProof(proof, published) ||
		published.endpoint.pid !== proof.tmuxPanePid
	)
		throw new SdkV3OperationError("endpoint_stale", "Close attachment descriptor or pane PID is not current.");
	const pane = {
		socketName: proof.tmuxSocket,
		target: proof.tmuxPane,
		panePid: proof.tmuxPanePid,
		ownershipTag: proof.tmuxOwnershipTag,
	};
	const backend = new (await import("../gjc/cli-lifecycle-backend")).CliLifecycleBackend({
		cliPath: context.input.cliPath,
		cwd: resolve(address.cwd),
		tmuxSocket: pane.socketName,
		childEnvironment: context.input.runtimeLocations.childEnvironment,
	});
	const candidate: SessionAttachment = {
		cwd: resolve(address.cwd),
		sessionRoot,
		projectId: address.projectId,
		sessionId: address.sessionId,
		sessionPath: address.sessionFile,
		pane,
		published,
	};
	if (published.endpoint.pid !== pane.panePid || (await backend.readiness({ ...candidate, pane })).status !== "closed")
		throw new SdkV3OperationError("endpoint_stale", "Close owned tmux pane authority could not be revalidated.");
	context.attachments.set(attachmentKey(address), candidate);
}

async function publishClosed<T>(
	context: PublicSdkRunnerContext,
	address: LifecycleAddress,
	owner: object,
	receipt: GjcCloseReceipt,
	write: () => T,
): Promise<T> {
	const key = attachmentKey(address);
	const issued = context.closeReceipts.get(receipt);
	const attachment = context.attachments.get(key);
	assertCurrentReceipt(address, owner, receipt, issued, attachment);
	await runLifecycleTestBarrier(context.input.testBarrierHook, "post_close_proof_pre_commit", attachment.published);
	assertCurrentReceipt(address, owner, receipt, issued, attachment);
	const result = write();
	assertCurrentReceipt(address, owner, receipt, issued, attachment);
	context.attachments.delete(key);
	context.closeReceipts.delete(receipt);
	return result;
}

function assertCurrentReceipt(
	address: LifecycleAddress,
	owner: object,
	receipt: GjcCloseReceipt,
	issued: import("./gjc-routing-lifecycle").CloseReceiptBinding | undefined,
	attachment: import("./gjc-routing-proof").SessionAttachment | undefined,
): asserts attachment is import("./gjc-routing-proof").SessionAttachment & {
	readonly published: NonNullable<import("./gjc-routing-proof").SessionAttachment["published"]>;
} {
	if (
		attachment?.published === undefined ||
		issued === undefined ||
		issued.owner !== owner ||
		issued.attachment !== attachment ||
		!sameLifecycleAddress(receipt.address, address) ||
		!sameCloseReceiptSnapshot(receipt, issued.snapshot) ||
		!sameExactActiveCloseProof(receipt.proof, attachment) ||
		!samePublishedAttachmentSnapshot(receipt.attachment, attachment.published)
	) {
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Close receipt no longer matches the exact active owned attachment",
		);
	}
}
