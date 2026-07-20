import type { PublicSdkSessionAttachment } from "../gjc/public-sdk-contract";
import type { GjcLifecycleTestBarrierEvidence, GjcLifecycleTestBarrierHook } from "../gjc/turn-runner";

export function lifecycleBarrierEvidence(attachment: PublicSdkSessionAttachment): GjcLifecycleTestBarrierEvidence {
	const authority = attachment.authority;
	return {
		cwd: attachment.cwd,
		sessionId: attachment.sessionId,
		...(authority === undefined
			? {}
			: { generation: authority.generation, digestPrefix: authority.payloadDigest.slice(0, 12) }),
	};
}

export async function runLifecycleTestBarrier(
	hook: GjcLifecycleTestBarrierHook | undefined,
	phase: Parameters<GjcLifecycleTestBarrierHook>[0],
	attachment: PublicSdkSessionAttachment,
): Promise<void> {
	await hook?.(phase, lifecycleBarrierEvidence(attachment));
}
