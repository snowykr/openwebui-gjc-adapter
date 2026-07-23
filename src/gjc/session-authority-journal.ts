import {
	copy,
	copyAcknowledgedSuccessor,
	copyOperation,
	copyOperationResult,
	copyProvisionalOperation,
} from "./session-authority-copy";
import {
	assertBeginableIdentity,
	assertPublishableIdentity,
	assertReservableIdentity,
} from "./session-authority-operation-identity";
import { requiresUncertainAcknowledgedSuccessorCompletionReconciliation } from "./session-authority-operation-validation";
import { reconcileSessionAuthority } from "./session-authority-reconciliation";
import { isAuthorityDocumentRelationallyValid } from "./session-authority-record-validation";
import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityInput,
	SessionAuthorityRecord,
	SessionOperation,
	SessionOperationResult,
	SessionOperationState,
} from "./session-authority-types";
import {
	createAuthorityIdentity,
	operationIdentifiers,
	operationResult,
	provisionalKey,
	updateAuthorityIdentity,
} from "./session-operation-codec";
export class SessionAuthorityJournal {
	readonly records = new Map<string, SessionAuthorityRecord>();
	readonly provisional = new Map<string, ProvisionalSessionOperation>();
	store(input: SessionAuthorityInput): SessionAuthorityRecord {
		const existing = this.records.get(input.chatId);
		if (existing !== undefined && existing.projectId !== input.projectId)
			throw new Error(`Session authority for chat ${input.chatId} is assigned to another project.`);
		const conflictingProject = [...this.provisional.values()].find(
			operation => operation.chatId === input.chatId && operation.projectId !== input.projectId,
		);
		if (conflictingProject !== undefined)
			throw new Error(`Session authority for chat ${input.chatId} is assigned to another project.`);
		const projectClaimId = JSON.stringify(["project-claim", input.chatId, input.projectId]);
		this.provisional.delete(provisionalKey(input.chatId, projectClaimId));
		const next = existing === undefined ? createAuthorityIdentity(input) : updateAuthorityIdentity(input, existing);
		this.records.set(next.chatId, next);
		return copy(next);
	}
	reassignProject(chatId: string, currentProjectId: string, nextProjectId: string): boolean {
		const existing = this.records.get(chatId);
		if (existing === undefined || existing.projectId !== currentProjectId) return false;
		this.records.delete(chatId);
		for (const [key, operation] of this.provisional) if (operation.chatId === chatId) this.provisional.delete(key);
		const claimId = JSON.stringify(["project-claim", chatId, nextProjectId]);
		this.provisional.set(provisionalKey(chatId, claimId), {
			chatId,
			projectId: nextProjectId,
			id: claimId,
			ingressId: claimId,
			kind: "create",
			state: "pending",
			startedAt: new Date().toISOString(),
			detail: "project reassignment claim",
		});
		return true;
	}
	require(chatId: string): SessionAuthorityRecord {
		const record = this.records.get(chatId);
		if (record === undefined) throw new Error(`Unknown session authority for chat ${chatId}.`);
		return record;
	}
	reserve(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		const ingressId = operation.ingressId ?? operation.id;
		const assignedProject = this.records.get(operation.chatId)?.projectId;
		if (assignedProject !== undefined && assignedProject !== operation.projectId)
			throw new Error(`Session authority for chat ${operation.chatId} is assigned to another project.`);
		const conflictingProject = [...this.provisional.values()].find(
			candidate => candidate.chatId === operation.chatId && candidate.projectId !== operation.projectId,
		);
		if (conflictingProject !== undefined)
			throw new Error(`Session authority for chat ${operation.chatId} is assigned to another project.`);
		const key = provisionalKey(operation.chatId, ingressId),
			prior = this.provisional.get(key);
		if (prior !== undefined) {
			if (
				prior.kind !== operation.kind ||
				prior.projectId !== operation.projectId ||
				prior.detail !== operation.detail
			)
				throw new Error(`Session ingress ${ingressId} conflicts with an existing provisional operation.`);
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		}
		assertReservableIdentity(operation, this.records.get(operation.chatId)?.journal ?? [], [
			...this.provisional.values(),
		]);
		const next = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		this.provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	publish(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionAuthorityInput,
	): SessionAuthorityRecord {
		const ingressId = operation.ingressId ?? operation.id,
			key = provisionalKey(operation.chatId, ingressId);
		const reserved = assertPublishableIdentity(
			operation,
			this.provisional.get(key),
			this.records.get(operation.chatId)?.journal ?? [],
			[...this.provisional.values()],
		);
		const completedAt = new Date().toISOString();
		const journalOperation: SessionOperation = {
			id: operation.id,
			kind: "prompt",
			state: "complete",
			ingressId: operation.ingressId,
			detail: operation.detail,
			startedAt: reserved.startedAt,
			completedAt,
			result: operationResult("turn", mapping),
		};
		const next = this.store({ ...mapping, journal: [journalOperation] });
		this.provisional.set(key, { ...reserved, state: "complete", completedAt });
		return next;
	}
	transitionProvisional(
		chatId: string,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): ProvisionalSessionOperation {
		const key = provisionalKey(chatId, ingressId),
			current = this.provisional.get(key);
		if (current === undefined) throw new Error(`Unknown provisional session operation ${ingressId}.`);
		if (current.state === "complete" && state !== "complete")
			throw new Error("Completed session operations are immutable.");
		const next = {
			...current,
			state,
			...(detail === undefined ? {} : { detail }),
			...(state === "complete" ? { completedAt: new Date().toISOString() } : {}),
		};
		this.provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	attach(
		chatId: string,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
	): ProvisionalSessionOperation {
		const key = provisionalKey(chatId, ingressId),
			current = this.provisional.get(key);
		if (current === undefined || current.state !== "pending")
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		if (
			attachment.sessionId === undefined ||
			attachment.attachment?.tmuxSocket === undefined ||
			attachment.attachment.tmuxPane === undefined ||
			attachment.attachment.tmuxPanePid === undefined ||
			attachment.attachment.tmuxOwnershipTag === undefined
		)
			throw new Error("Provisional session authority requires an exact endpoint and owned-pane proof.");
		const next = { ...current, ...attachment };
		this.provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	begin(
		chatId: string,
		operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
	): SessionAuthorityRecord {
		const record = this.require(chatId),
			incomingIdentifiers = operationIdentifiers(operation),
			prior = record.journal.find(candidate =>
				operationIdentifiers(candidate).some(identifier => incomingIdentifiers.includes(identifier)),
			);
		if (prior !== undefined) {
			if (prior.id !== operation.id || prior.ingressId !== operation.ingressId || prior.kind !== operation.kind)
				throw new Error(
					`Session ingress ${operation.ingressId ?? operation.id} conflicts with an existing operation.`,
				);
			return copy(record);
		}
		assertBeginableIdentity(operation, [...this.provisional.values()]);
		const next = {
			...record,
			journal: [...record.journal, { ...operation, state: "pending" as const, startedAt: new Date().toISOString() }],
		};
		this.records.set(chatId, next);
		return copy(next);
	}
	acknowledge(
		chatId: string,
		operationId: string,
		operationHash: string,
		successor: AcknowledgedSuccessor,
	): SessionOperation {
		const record = this.require(chatId),
			index = record.journal.findIndex(
				operation => operation.id === operationId || operation.ingressId === operationId,
			),
			current = record.journal[index];
		if (
			current === undefined ||
			(current.kind !== "create" && current.kind !== "branch") ||
			(current.state !== "pending" && current.state !== "uncertain") ||
			current.detail !== operationHash
		)
			throw new Error(`Session operation ${operationId} requires reconciliation.`);
		if (current.acknowledgedSuccessor !== undefined) {
			if (JSON.stringify(current.acknowledgedSuccessor) !== JSON.stringify(successor))
				throw new Error(`Session operation ${operationId} has a conflicting acknowledged successor.`);
			return copyOperation(current);
		}
		const journal = [...record.journal];
		journal[index] = { ...current, acknowledgedSuccessor: copyAcknowledgedSuccessor(successor) };
		this.records.set(chatId, { ...record, journal });
		return copyOperation(journal[index]!);
	}
	transition(
		chatId: string,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): SessionAuthorityRecord {
		const record = this.require(chatId),
			index = record.journal.findIndex(
				operation => operation.id === operationId || operation.ingressId === operationId,
			),
			current = record.journal[index];
		if (current === undefined) throw new Error(`Unknown session operation ${operationId}.`);
		if (requiresUncertainAcknowledgedSuccessorCompletionReconciliation(current, state, detail, result))
			throw new Error(`Session operation ${operationId} requires reconciliation.`);
		if (current.state === "complete" && state !== "complete")
			throw new Error("Completed session operations are immutable.");
		if (state === "complete" && result === undefined && current.result === undefined)
			throw new Error("Completed session operations require an immutable result binding.");
		if (state !== "complete" && result !== undefined)
			throw new Error("Only completed session operations may bind a result.");
		const { acknowledgedSuccessor: _acknowledgedSuccessor, ...withoutAcknowledgedSuccessor } = current,
			journal = [...record.journal];
		journal[index] = {
			...(state === "complete" ? withoutAcknowledgedSuccessor : current),
			state,
			...(detail === undefined ? {} : { detail }),
			...(result === undefined ? {} : { result: copyOperationResult(result) }),
			...(state === "complete" ? { completedAt: new Date().toISOString() } : {}),
		};
		const next = { ...record, journal };
		this.records.set(chatId, next);
		return copy(next);
	}
	reconcile(): readonly SessionAuthorityRecord[] {
		return reconcileSessionAuthority(this.records, this.provisional);
	}
	replace(records: readonly SessionAuthorityRecord[], provisional: readonly ProvisionalSessionOperation[] = []): void {
		if (!isAuthorityDocumentRelationallyValid(records, provisional))
			throw new Error("Refusing to replace session authority with invalid operation identities.");
		this.records.clear();
		this.provisional.clear();
		for (const record of records) this.records.set(record.chatId, copy(record));
		for (const operation of provisional)
			this.provisional.set(
				provisionalKey(operation.chatId, operation.ingressId ?? operation.id),
				copyProvisionalOperation(operation),
			);
	}
}
