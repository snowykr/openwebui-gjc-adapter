import type { SessionAttachmentProof } from "../src/gjc/session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "../src/gjc/session-authority-v3";
import type {
	GjcLifecyclePublicationAddress,
	GjcLifecycleTransaction,
	ManagedGenerationProof,
	ManagedTurnAuthority,
} from "../src/gjc/turn-runner";

type ManagedTurnAuthorityV3 = ManagedTurnAuthority & {
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
};

export function managedPreparedAuthority(
	overrides: Partial<ManagedTurnAuthority> & {
		readonly authorityEpoch?: typeof SESSION_AUTHORITY_V3_EPOCH;
	} = {},
): ManagedTurnAuthorityV3 {
	return {
		principalId: "owner-test",
		projectId: "project",
		canonicalWorkspace: "/workspace/project",
		chatId: "chat-1",
		sessionId: "session-1",
		generation: 1,
		leaseId: "lease-1",
		epoch: "epoch-1",
		requestKey: "user-1",
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		...overrides,
	};
}

export function lifecycleFixture(
	address: GjcLifecyclePublicationAddress,
	managedAuthority?: ManagedTurnAuthority,
): GjcLifecycleTransaction {
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
	const expectedManagedAuthority: ManagedTurnAuthorityV3 = {
		...managedPreparedAuthority({
			projectId: address.projectId,
			canonicalWorkspace: address.cwd,
			chatId: address.chatId,
		}),
		sessionId: address.sessionId,
		generation: 1,
		...(managedAuthority === undefined ? {} : managedAuthority),
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	};
	const validateManaged = (candidate: ManagedGenerationProof) => {
		if (
			candidate.kind !== "managed-generation" ||
			candidate.sessionId !== expectedManagedAuthority.sessionId ||
			candidate.generation !== expectedManagedAuthority.generation ||
			candidate.leaseId !== expectedManagedAuthority.leaseId ||
			candidate.epoch !== expectedManagedAuthority.epoch
		)
			throw new Error("Lifecycle fixture rejected a mismatched managed generation proof.");
	};
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
		async publishManaged<T>(candidate: ManagedGenerationProof, write: () => T): Promise<T> {
			validateManaged(candidate);
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

export function attachmentProof<T extends { readonly cwd: string; readonly sessionId: string }>(
	address: T,
): SessionAttachmentProof {
	return {
		descriptorPath: `${address.cwd}/.gjc/state/sdk/${address.sessionId}.json`,
		descriptorStat: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
		payloadDigest: "0000000000000000000000000000000000000000000000000000000000000000",
		generation: 1,
		expectedSessionId: address.sessionId,
		expectedCwd: address.cwd,
	};
}
