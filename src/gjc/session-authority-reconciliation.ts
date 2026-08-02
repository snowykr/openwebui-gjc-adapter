import { copy } from "./session-authority-copy";
import type { ProvisionalSessionOperation, SessionAuthorityRecord } from "./session-authority-types";
import { provisionalKey } from "./session-operation-codec";

export function reconcileSessionAuthority(
	records: Map<string, SessionAuthorityRecord>,
	provisional: Map<string, ProvisionalSessionOperation>,
): readonly SessionAuthorityRecord[] {
	const reconciled: SessionAuthorityRecord[] = [];
	for (const record of records.values()) {
		const journal = record.journal.map(operation =>
			operation.state === "pending"
				? { ...operation, state: "uncertain" as const, detail: operation.detail ?? "restart before completion" }
				: operation,
		);
		const reassignment =
			record.reassignment?.state === "pending"
				? {
						...record.reassignment,
						state: "rolled_back" as const,
						completedAt: new Date().toISOString(),
					}
				: record.reassignment;
		const changed =
			journal.some((operation, index) => operation !== record.journal[index]) ||
			reassignment !== record.reassignment;
		if (!changed) continue;
		const next = {
			...record,
			journal,
			...(reassignment === undefined ? {} : { reassignment }),
		};
		records.set(record.chatId, next);
		reconciled.push(copy(next));
	}
	for (const operation of provisional.values()) {
		if (operation.state !== "pending") continue;
		provisional.set(provisionalKey(operation.chatId, operation.ingressId ?? operation.id), {
			...operation,
			state: "uncertain",
			detail: operation.detail ?? "restart before completion",
		});
	}
	return reconciled;
}
