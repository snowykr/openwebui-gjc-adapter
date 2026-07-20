import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import { GjcCloseReceipt } from "../gjc/turn-runner";
import type { GjcLifecycleTransaction } from "../gjc/turn-runner";
import { assertPublishedSdkAttachmentCurrent } from "../gjc/public-sdk-session-port";
import { withPublicSdkSessionMutationCoordinator } from "../gjc/public-sdk-session-port";
import { attachmentKey } from "./gjc-routing-endpoints";
import {
	runLifecycleTestBarrier,
	sameActiveAttachmentProof,
	sameCloseReceiptSnapshot,
	sameExactActiveCloseProof,
	sameLifecycleAddress,
	samePublishedAttachmentSnapshot,
} from "./gjc-routing-proof";
import type {
	LifecycleAddress,
	LifecycleEffect,
	PublicSdkRunnerContext,
} from "./gjc-routing-lifecycle";
import { ensureAttachment } from "./gjc-public-sdk-session-ops";

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
				throw new SdkV3OperationError("endpoint_stale", "Close preflight proof no longer matches the exact active owned attachment");
			}
			assertPublishedSdkAttachmentCurrent(attachment.published);
			const receipt = GjcCloseReceipt.fromPreflight(activeAddress, proof, attachment.published);
			context.closeReceipts.set(receipt, { attachment, owner, snapshot: receipt });
			return receipt;
		},
		publish: async (proof, write) => {
			const attachment = context.attachments.get(attachmentKey(activeAddress));
			if (attachment?.published === undefined || !sameActiveAttachmentProof(proof, attachment)) {
				throw new SdkV3OperationError("endpoint_stale", "Lifecycle publication proof no longer matches the active attachment");
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
		return effect(lifecycle);
	});
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
): asserts attachment is import("./gjc-routing-proof").SessionAttachment & { readonly published: NonNullable<import("./gjc-routing-proof").SessionAttachment["published"]> } {
	if (
		attachment?.published === undefined || issued === undefined || issued.owner !== owner ||
		issued.attachment !== attachment || !sameLifecycleAddress(receipt.address, address) ||
		!sameCloseReceiptSnapshot(receipt, issued.snapshot) || !sameExactActiveCloseProof(receipt.proof, attachment) ||
		!samePublishedAttachmentSnapshot(receipt.attachment, attachment.published)
	) {
		throw new SdkV3OperationError("endpoint_stale", "Close receipt no longer matches the exact active owned attachment");
	}
}
