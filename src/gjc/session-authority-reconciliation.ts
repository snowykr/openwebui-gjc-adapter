import { type ManagedLifecycleEvidence, transitionManagedLifecycleEvidence } from "./managed-lifecycle-evidence";
import { copy } from "./session-authority-copy";
import type { ProvisionalSessionOperation, SessionAuthorityRecord } from "./session-authority-types";
import { provisionalKey } from "./session-operation-codec";

export function reconcileSessionAuthority(
	records: Map<string, SessionAuthorityRecord>,
	provisional: Map<string, ProvisionalSessionOperation>,
	dirtyRecords?: Set<string>,
	dirtyProvisional?: Set<string>,
	copyResults = true,
	observedAt = Date.now(),
): readonly SessionAuthorityRecord[] {
	const reconciled: SessionAuthorityRecord[] = [];
	for (const record of records.values()) {
		const journal = record.journal.map(operation =>
			operation.state === "pending"
				? {
						...operation,
						state: "uncertain" as const,
						detail: operation.detail ?? "restart before completion",
						...(operation.lifecycle === undefined
							? {}
							: { lifecycle: interruptedLifecycle(operation.lifecycle) }),
					}
				: operation,
		);
		const reassignment =
			record.reassignment?.state === "pending"
				? {
						...record.reassignment,
						state: "rolled_back" as const,
						completedAt: new Date(Math.max(observedAt, Date.parse(record.reassignment.startedAt))).toISOString(),
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
		dirtyRecords?.add(record.chatId);
		// When the caller discards the result (e.g. the boot path that will
		// immediately persist or compact), skip the deep copy: copy(next)
		// recursively clones the record's event payloads, which for a 1 GiB-class
		// legacy authority can exhaust memory before the boot compaction runs.
		if (copyResults) reconciled.push(copy(next));
	}
	for (const operation of provisional.values()) {
		if (operation.state !== "pending") continue;
		const key = provisionalKey(operation.chatId, operation.ingressId ?? operation.id);
		provisional.set(key, {
			...operation,
			state: "uncertain",
			detail: operation.detail ?? "restart before completion",
			...(operation.lifecycle === undefined ? {} : { lifecycle: interruptedLifecycle(operation.lifecycle) }),
		});
		dirtyProvisional?.add(key);
	}
	return reconciled;
}

function interruptedLifecycle(evidence: ManagedLifecycleEvidence): ManagedLifecycleEvidence {
	// A prompt interruption does not revoke an already proven generation. Prepared
	// intent also proves no invocation began; neither requires an invented edge.
	if (evidence.state === "invoking" || evidence.state === "acknowledged_unproven" || evidence.state === "closing")
		return transitionManagedLifecycleEvidence(evidence, "uncertain", {}, evidence.recordedAt);
	if (evidence.state === "cleanup_pending")
		return transitionManagedLifecycleEvidence(evidence, "cleanup_uncertain", {}, evidence.recordedAt);
	return evidence;
}
