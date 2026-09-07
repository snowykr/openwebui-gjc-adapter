import { copyManagedLateLifecycleAcknowledgement, copyManagedLifecycleEvidence } from "./managed-lifecycle-evidence";
import type {
	AcknowledgedSuccessor,
	EndpointSessionAttachmentProof,
	ProvisionalSessionOperation,
	SessionAuthorityBinding,
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
	readonly acknowledgedSuccessor?: Exclude<
		AcknowledgedSuccessor,
		{ readonly attachment: EndpointSessionAttachmentProof }
	>;
};

export function copySessionAuthorityBinding(value: SessionAuthorityBinding): SessionAuthorityBinding {
	if (value.historicalBinding !== undefined) {
		if (value.managedAuthority !== undefined) throw new Error("Session authority bindings are mutually exclusive.");
		return {
			historicalBinding: { ...value.historicalBinding, provenance: { ...value.historicalBinding.provenance } },
		};
	}
	return value.managedAuthority === undefined
		? {}
		: { managedAuthority: copyManagedAuthority(value.managedAuthority) };
}

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
	const { managedAuthority: _managedAuthority, historicalBinding: _historicalBinding, ...fields } = result;
	return {
		...fields,
		...copySessionAuthorityBinding(result),
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
		...(result.gate === undefined ? {} : { gate: { ...result.gate } }),
	};
}

export function copyEvents(events: readonly GjcTurnEvent[]): GjcTurnEvent[] {
	return events.map(event => ({
		...event,
		...(event.payload === undefined ? {} : { payload: structuredClone(event.payload) }),
	}));
}

export function copy(record: SessionAuthorityRecord): SessionAuthorityRecord {
	const { managedAuthority: _managedAuthority, historicalBinding: _historicalBinding, ...fields } = record;
	return {
		...fields,
		...copySessionAuthorityBinding(record),
		header: { ...record.header },
		events: record.events === undefined ? undefined : copyEvents(record.events),
		...(record.modelSelection === undefined ? {} : { modelSelection: { ...record.modelSelection } }),
		observations: record.observations === undefined ? undefined : structuredClone(record.observations),
		...(record.attachment === undefined
			? {}
			: { attachment: { ...record.attachment, descriptorStat: { ...record.attachment.descriptorStat } } }),
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
export function copyOperation(operation: ManagedSessionOperation): ManagedSessionOperation;
export function copyOperation(operation: SessionOperation): SessionOperation;
export function copyOperation(operation: SessionOperation | ManagedSessionOperation) {
	return {
		...operation,
		...(operation.lifecycle === undefined ? {} : { lifecycle: copyManagedLifecycleEvidence(operation.lifecycle) }),
		...(operation.lateLifecycleAcknowledgement === undefined
			? {}
			: {
					lateLifecycleAcknowledgement: copyManagedLateLifecycleAcknowledgement(
						operation.lateLifecycleAcknowledgement,
					),
				}),
		...(operation.result === undefined ? {} : { result: copyOperationResult(operation.result) }),
		...(operation.acknowledgedSuccessor === undefined
			? {}
			: { acknowledgedSuccessor: copyAcknowledgedSuccessor(operation.acknowledgedSuccessor) }),
	};
}

export function copyProvisionalOperation(operation: ProvisionalSessionOperation): ProvisionalSessionOperation {
	const { managedAuthority: _managedAuthority, historicalBinding: _historicalBinding, ...fields } = operation;
	return {
		...fields,
		...copyOperation(fields),
		...copySessionAuthorityBinding(operation),
		...(operation.cleanup === undefined
			? {}
			: { cleanup: { ...operation.cleanup, lifecycle: copyManagedLifecycleEvidence(operation.cleanup.lifecycle) } }),
		...(operation.lateCreateAcknowledgement === undefined
			? {}
			: {
					lateCreateAcknowledgement: {
						...operation.lateCreateAcknowledgement,
						acknowledged: { ...operation.lateCreateAcknowledgement.acknowledged },
					},
				}),
		...(operation.attachment === undefined
			? {}
			: {
					attachment: {
						...operation.attachment,
						descriptorStat: { ...operation.attachment.descriptorStat },
					},
				}),
	};
}

export function copyAcknowledgedSuccessor(successor: ManagedAcknowledgedSuccessor): ManagedAcknowledgedSuccessor;
export function copyAcknowledgedSuccessor(
	successor: NonNullable<ManagedSessionOperation["acknowledgedSuccessor"]>,
): NonNullable<ManagedSessionOperation["acknowledgedSuccessor"]>;
export function copyAcknowledgedSuccessor(successor: AcknowledgedSuccessor): AcknowledgedSuccessor;
export function copyAcknowledgedSuccessor(
	successor: AcknowledgedSuccessor | ManagedAcknowledgedSuccessor,
): AcknowledgedSuccessor | ManagedAcknowledgedSuccessor;
export function copyAcknowledgedSuccessor(
	successor: AcknowledgedSuccessor | ManagedAcknowledgedSuccessor,
): AcknowledgedSuccessor | ManagedAcknowledgedSuccessor {
	if ("historicalBinding" in successor && successor.historicalBinding !== undefined) {
		if (successor.managedAuthority !== undefined)
			throw new Error("Session authority bindings are mutually exclusive.");
		return {
			sessionId: successor.sessionId,
			historicalBinding: {
				...successor.historicalBinding,
				provenance: { ...successor.historicalBinding.provenance },
			},
		};
	}
	if ("managedAuthority" in successor) {
		if (successor.managedAuthority === undefined) throw new Error("Acknowledged successor lacks managed authority.");
		return {
			sessionId: successor.sessionId,
			managedAuthority: copyManagedAuthority(successor.managedAuthority),
		};
	}
	if ("attachment" in successor)
		return {
			...successor,
			attachment: { ...successor.attachment, descriptorStat: { ...successor.attachment.descriptorStat } },
		};
	throw new Error("Acknowledged successor lacks authority evidence.");
}

export function copyTombstone(tombstone: SessionAuthorityTombstone): SessionAuthorityTombstone {
	const { managedAuthority: _managedAuthority, historicalBinding: _historicalBinding, ...fields } = tombstone;
	return {
		...fields,
		...copySessionAuthorityBinding(tombstone),
		header: { ...tombstone.header },
		events: tombstone.events === undefined ? undefined : copyEvents(tombstone.events),
		...(tombstone.modelSelection === undefined ? {} : { modelSelection: { ...tombstone.modelSelection } }),
		observations: tombstone.observations === undefined ? undefined : structuredClone(tombstone.observations),
		...(tombstone.attachment === undefined
			? {}
			: { attachment: { ...tombstone.attachment, descriptorStat: { ...tombstone.attachment.descriptorStat } } }),
		journal: tombstone.journal.map(operation => copyOperation(operation)),
		...(tombstone.prior === undefined ? {} : { prior: copyTombstone(tombstone.prior) }),
	};
}
