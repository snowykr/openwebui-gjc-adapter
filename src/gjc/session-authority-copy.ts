import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityRecord,
	SessionOperation,
	SessionOperationResult,
} from "./session-authority-types";
import type { GjcTurnEvent } from "./turn-runner";

export function copyOperationResult(result: SessionOperationResult): SessionOperationResult {
	return {
		...result,
		events: copyEvents(result.events),
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
		journal: record.journal.map(copyOperation),
	};
}
export function copyOperation(operation: SessionOperation): SessionOperation {
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
	};
}

export function copyAcknowledgedSuccessor(successor: AcknowledgedSuccessor): AcknowledgedSuccessor {
	return {
		...successor,
		attachment: { ...successor.attachment, descriptorStat: { ...successor.attachment.descriptorStat } },
	};
}
