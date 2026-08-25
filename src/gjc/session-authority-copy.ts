import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityRecord,
	SessionAuthorityTombstone,
	SessionOperation,
	SessionOperationResult,
} from "./session-authority-types";
import type { GjcTurnEvent, ManagedTurnAuthority } from "./turn-runner";

/** Managed V3 successor proof. Unlike the legacy successor shape, this record
 * carries only the durable tenant/session authority and has no endpoint or
 * attachment state. */
export interface ManagedAcknowledgedSuccessor {
	readonly sessionId: string;
	readonly managedAuthority: ManagedTurnAuthority;
}

export type ManagedSessionOperation = Omit<SessionOperation, "acknowledgedSuccessor"> & {
	readonly acknowledgedSuccessor?: ManagedAcknowledgedSuccessor;
};

export function copyManagedAuthority(authority: ManagedTurnAuthority): ManagedTurnAuthority {
	const v3Authority = authority as ManagedTurnAuthority & { readonly authorityEpoch?: string };
	return {
		principalId: authority.principalId,
		projectId: authority.projectId,
		canonicalWorkspace: authority.canonicalWorkspace,
		chatId: authority.chatId,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
		requestKey: authority.requestKey,
		...(v3Authority.authorityEpoch === undefined ? {} : { authorityEpoch: v3Authority.authorityEpoch }),
	};
}

export function copyOperationResult(result: SessionOperationResult): SessionOperationResult {
	return {
		...result,
		...(result.managedAuthority === undefined
			? {}
			: { managedAuthority: copyManagedAuthority(result.managedAuthority) }),
		...(result.events === undefined ? {} : { events: copyEvents(result.events) }),
		mapping: {
			...result.mapping,
			...(result.mapping.modelSelection === undefined
				? {}
				: { modelSelection: { ...result.mapping.modelSelection } }),
			...(result.mapping.attachment === undefined
				? {}
				: {
						attachment: {
							...result.mapping.attachment,
							descriptorStat: { ...result.mapping.attachment.descriptorStat },
						},
					}),
		},
		...(result.correlation === undefined ? {} : { correlation: { ...result.correlation } }),
	};
}

export function copyEvents(events: readonly GjcTurnEvent[]): GjcTurnEvent[] {
	return events.map(event => ({
		...event,
		...(event.payload === undefined ? {} : { payload: structuredClone(event.payload) }),
	}));
}

export function copy(record: SessionAuthorityRecord): SessionAuthorityRecord {
	return {
		...record,
		header: { ...record.header },
		events: record.events === undefined ? undefined : copyEvents(record.events),
		...(record.modelSelection === undefined ? {} : { modelSelection: { ...record.modelSelection } }),
		observations: record.observations === undefined ? undefined : structuredClone(record.observations),
		...(record.attachment === undefined
			? {}
			: { attachment: { ...record.attachment, descriptorStat: { ...record.attachment.descriptorStat } } }),
		...(record.managedAuthority === undefined
			? {}
			: { managedAuthority: copyManagedAuthority(record.managedAuthority) }),
		journal: record.journal.map(operation => copyOperation(operation)),
		...(record.reassignment === undefined
			? {}
			: {
					reassignment: {
						...record.reassignment,
						...(record.reassignment.target === undefined ? {} : { target: { ...record.reassignment.target } }),
						...(record.reassignment.sourceTombstone === undefined
							? {}
							: { sourceTombstone: copyTombstone(record.reassignment.sourceTombstone) }),
						...(record.reassignment.priorTombstone === undefined
							? {}
							: { priorTombstone: copyTombstone(record.reassignment.priorTombstone) }),
					},
				}),
	};
}
export function copyOperation(operation: SessionOperation): SessionOperation;
export function copyOperation(operation: ManagedSessionOperation): ManagedSessionOperation;
export function copyOperation(operation: SessionOperation | ManagedSessionOperation) {
	return {
		...operation,
		...(operation.result === undefined ? {} : { result: copyOperationResult(operation.result) }),
		...(operation.acknowledgedSuccessor === undefined
			? {}
			: { acknowledgedSuccessor: copyAcknowledgedSuccessor(operation.acknowledgedSuccessor) }),
	};
}

export function copyProvisionalOperation(operation: ProvisionalSessionOperation): ProvisionalSessionOperation {
	return {
		...operation,
		...(operation.attachment === undefined
			? {}
			: {
					attachment: {
						...operation.attachment,
						descriptorStat: { ...operation.attachment.descriptorStat },
					},
				}),
		...(operation.managedAuthority === undefined
			? {}
			: { managedAuthority: copyManagedAuthority(operation.managedAuthority) }),
	};
}

export function copyAcknowledgedSuccessor(successor: AcknowledgedSuccessor): AcknowledgedSuccessor;
export function copyAcknowledgedSuccessor(successor: ManagedAcknowledgedSuccessor): ManagedAcknowledgedSuccessor;
export function copyAcknowledgedSuccessor(
	successor: AcknowledgedSuccessor | ManagedAcknowledgedSuccessor,
): AcknowledgedSuccessor | ManagedAcknowledgedSuccessor;
export function copyAcknowledgedSuccessor(
	successor: AcknowledgedSuccessor | ManagedAcknowledgedSuccessor,
): AcknowledgedSuccessor | ManagedAcknowledgedSuccessor {
	if ("managedAuthority" in successor) {
		return {
			sessionId: successor.sessionId,
			managedAuthority: copyManagedAuthority(successor.managedAuthority),
		};
	}
	return {
		...successor,
		attachment: { ...successor.attachment, descriptorStat: { ...successor.attachment.descriptorStat } },
	};
}

export function copyTombstone(tombstone: SessionAuthorityTombstone): SessionAuthorityTombstone {
	return {
		...tombstone,
		header: { ...tombstone.header },
		events: tombstone.events === undefined ? undefined : copyEvents(tombstone.events),
		...(tombstone.modelSelection === undefined ? {} : { modelSelection: { ...tombstone.modelSelection } }),
		observations: tombstone.observations === undefined ? undefined : structuredClone(tombstone.observations),
		...(tombstone.attachment === undefined
			? {}
			: { attachment: { ...tombstone.attachment, descriptorStat: { ...tombstone.attachment.descriptorStat } } }),
		...(tombstone.managedAuthority === undefined
			? {}
			: { managedAuthority: copyManagedAuthority(tombstone.managedAuthority) }),
		journal: tombstone.journal.map(operation => copyOperation(operation)),
		...(tombstone.prior === undefined ? {} : { prior: copyTombstone(tombstone.prior) }),
	};
}
