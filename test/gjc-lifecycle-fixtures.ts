import type { SessionAttachmentProof } from "../src/gjc/session-authority";
import type { GjcLifecyclePublicationAddress, GjcLifecycleTransaction } from "../src/gjc/turn-runner";

export function lifecycleFixture(address: GjcLifecyclePublicationAddress): GjcLifecycleTransaction {
	const validate = (candidate: SessionAttachmentProof, candidateAddress: GjcLifecyclePublicationAddress) => {
		const expected = attachmentProof(candidateAddress);
		if (
			candidate.descriptorPath !== expected.descriptorPath ||
			candidate.descriptorStat.dev !== expected.descriptorStat.dev ||
			candidate.descriptorStat.ino !== expected.descriptorStat.ino ||
			candidate.descriptorStat.size !== expected.descriptorStat.size ||
			candidate.descriptorStat.mtimeMs !== expected.descriptorStat.mtimeMs ||
			candidate.payloadDigest !== expected.payloadDigest ||
			candidate.generation !== expected.generation ||
			candidate.expectedSessionId !== expected.expectedSessionId ||
			candidate.expectedCwd !== expected.expectedCwd
		)
			throw new Error("Lifecycle fixture rejected a mismatched proof or address.");
	};
	const owner = {};
	let activeAddress = address;
	return {
		owner,
		get address() {
			return activeAddress;
		},
		assertClosePreflight(): never {
			throw new Error("Lifecycle fixture has no active close attachment.");
		},
		async publish<T>(candidate: SessionAttachmentProof, write: () => T): Promise<T> {
			validate(candidate, activeAddress);
			return write();
		},
		async publishClosed<T>(candidate: SessionAttachmentProof, write: () => T): Promise<T> {
			validate(candidate, activeAddress);
			return write();
		},
		async handoff(successor: GjcLifecyclePublicationAddress, candidate: SessionAttachmentProof): Promise<void> {
			validate(candidate, successor);
			activeAddress = successor;
		},
	};
}

export function attachmentProof<T extends { readonly cwd: string; readonly sessionId: string }>(address: T): SessionAttachmentProof {
	return {
		descriptorPath: `${address.cwd}/.gjc/state/sdk/${address.sessionId}.json`,
		descriptorStat: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
		payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
		generation: 1,
		expectedSessionId: address.sessionId,
		expectedCwd: address.cwd,
	};
}
