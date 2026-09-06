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
		address,
		async publishManaged<T>(candidate: ManagedGenerationProof, write: () => T): Promise<T> {
			validateManaged(candidate);
			return write();
		},
	};
}
