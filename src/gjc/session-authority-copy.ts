import type { ProvisionalSessionOperation, SessionAuthorityRecord, SessionOperationResult } from "./session-authority-types";

export function copyOperationResult(result: SessionOperationResult): SessionOperationResult {
	return {
		...result,
		events: [...result.events],
		mapping: {
			...result.mapping,
			...(result.mapping.attachment === undefined ? {} : { attachment: { ...result.mapping.attachment, descriptorStat: { ...result.mapping.attachment.descriptorStat } } }),
		},
		...(result.correlation === undefined ? {} : { correlation: { ...result.correlation } }),
	};
}

export function copy(record: SessionAuthorityRecord): SessionAuthorityRecord {
	return {
		...record,
		header: { ...record.header },
		events: record.events === undefined ? undefined : [...record.events],
		observations: record.observations === undefined ? undefined : { ...record.observations },
		...(record.attachment === undefined ? {} : { attachment: { ...record.attachment, descriptorStat: { ...record.attachment.descriptorStat } } }),
		journal: record.journal.map(operation => ({ ...operation, ...(operation.result === undefined ? {} : { result: copyOperationResult(operation.result) }) })),
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
