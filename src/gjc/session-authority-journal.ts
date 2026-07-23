import {
	copy,
	copyAcknowledgedSuccessor,
	copyOperation,
	copyOperationResult,
	copyProvisionalOperation,
	copyTombstone,
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
	SessionAuthorityTargetIdentity,
	SessionAuthorityTombstone,
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
		const conflictingProject = [...this.provisional.values()].find(operation => {
			if (operation.chatId !== input.chatId || operation.projectId === input.projectId) return false;
			const reassignment = existing?.reassignment;
			return !(
				reassignment?.state === "rolled_back" &&
				reassignment.targetProjectId === operation.projectId &&
				reassignment.target !== undefined &&
				sameTarget(operation, reassignment.target) &&
				(operation.state === "uncertain" || operation.state === "conflict")
			);
		});
		if (conflictingProject !== undefined)
			throw new Error(`Session authority for chat ${input.chatId} is assigned to another project.`);
		assertInputIdentityFence(input, existing);
		const next = existing === undefined ? createAuthorityIdentity(input) : updateAuthorityIdentity(input, existing);
		this.records.set(next.chatId, next);
		return copy(next);
	}
	beginProjectReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): SessionAuthorityRecord {
		const existing = this.records.get(chatId);
		if (existing === undefined || existing.projectId !== currentProjectId)
			throw new Error(`Unknown or cross-project session authority for chat ${chatId}.`);
		if (currentProjectId === nextProjectId)
			throw new Error("Session project reassignment requires distinct source and target projects.");
		const unresolvedTarget = [...this.provisional.values()].find(
			operation => operation.chatId === chatId && operation.state !== "complete",
		);
		if (unresolvedTarget !== undefined)
			throw new Error(
				`Session operation ${unresolvedTarget.ingressId ?? unresolvedTarget.id} requires reconciliation.`,
			);
		const prior = existing.reassignment;
		if (
			prior !== undefined &&
			prior.state === "pending" &&
			(prior.sourceProjectId !== currentProjectId || prior.targetProjectId !== nextProjectId)
		)
			throw new Error(`Session authority for chat ${chatId} has an unrelated reassignment.`);
		if (target !== undefined) assertTargetIdentity(target);
		const next: SessionAuthorityRecord = {
			...existing,
			reassignment: {
				state: "pending",
				sourceProjectId: currentProjectId,
				targetProjectId: nextProjectId,
				startedAt: new Date().toISOString(),
				...(target === undefined ? {} : { target: { ...target } }),
				...(prior?.state === "committed" && prior.sourceTombstone !== undefined
					? { priorTombstone: copyTombstone(prior.sourceTombstone) }
					: {}),
			},
		};
		this.records.set(chatId, next);
		return copy(next);
	}
	reassignProject(chatId: string, currentProjectId: string, nextProjectId: string): boolean {
		try {
			this.beginProjectReassignment(chatId, currentProjectId, nextProjectId);
			return true;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Unknown or cross-project")) return false;
			throw error;
		}
	}
	beginReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): SessionAuthorityRecord {
		return this.beginProjectReassignment(chatId, currentProjectId, nextProjectId, target);
	}
	rollbackReassignment(chatId: string, currentProjectId: string): SessionAuthorityRecord {
		return this.rollbackProjectReassignment(chatId, currentProjectId);
	}
	rollbackProjectReassignment(chatId: string, currentProjectId: string): SessionAuthorityRecord {
		const existing = this.records.get(chatId);
		const reassignment = existing?.reassignment;
		if (
			existing === undefined ||
			existing.projectId !== currentProjectId ||
			reassignment === undefined ||
			reassignment.state !== "pending" ||
			reassignment.sourceProjectId !== currentProjectId
		)
			throw new Error(`Unknown or cross-project project reassignment for chat ${chatId}.`);
		if (reassignment.target !== undefined) {
			const key = provisionalKey(chatId, reassignment.target.ingressId ?? reassignment.target.id);
			const provisional = this.provisional.get(key);
			if (provisional !== undefined && provisional.state === "pending")
				this.provisional.set(key, {
					...provisional,
					state: "uncertain",
					detail: "project reassignment rolled back; external effect evidence retained",
				});
		}
		const next = {
			...existing,
			reassignment: { ...reassignment, state: "rolled_back" as const, completedAt: new Date().toISOString() },
		};
		this.records.set(chatId, next);
		return copy(next);
	}
	require(chatId: string): SessionAuthorityRecord {
		const record = this.records.get(chatId);
		if (record === undefined) throw new Error(`Unknown session authority for chat ${chatId}.`);
		return record;
	}
	lookupOperation(chatId: string, operationId: string): SessionOperation | undefined {
		const record = this.records.get(chatId);
		if (record === undefined) return undefined;
		const active = record.journal.find(
			operation => operation.id === operationId || operation.ingressId === operationId,
		);
		if (active !== undefined) return copyOperation(active);
		let tombstone = record.reassignment?.sourceTombstone;
		while (tombstone !== undefined) {
			const retired = tombstone.journal.find(
				operation => operation.id === operationId || operation.ingressId === operationId,
			);
			if (retired !== undefined) return copyOperation(retired);
			tombstone = tombstone.prior;
		}
		return undefined;
	}
	lookupOperationAuthority(
		chatId: string,
		operationId: string,
	): SessionAuthorityRecord | SessionAuthorityTombstone | undefined {
		const record = this.records.get(chatId);
		if (record === undefined) return undefined;
		if (record.journal.some(operation => operation.id === operationId || operation.ingressId === operationId))
			return copy(record);
		let tombstone = record.reassignment?.sourceTombstone;
		while (tombstone !== undefined) {
			if (tombstone.journal.some(operation => operation.id === operationId || operation.ingressId === operationId))
				return copyTombstone(tombstone);
			tombstone = tombstone.prior;
		}
		return undefined;
	}
	assertOperationProject(chatId: string, projectId: string, operationId: string): void {
		const authority = this.lookupOperationAuthority(chatId, operationId);
		if (authority === undefined || authority.projectId !== projectId)
			throw new Error(`Session operation ${operationId} is not authorized for project ${projectId}.`);
	}
	assertOperationIdentity(
		chatId: string,
		projectId: string,
		operation: Pick<SessionOperation, "id" | "ingressId">,
	): void {
		const record = this.require(chatId);
		if (record.projectId !== projectId) {
			throw new Error(`Session authority for chat ${chatId} is assigned to another project.`);
		}
		const incoming = operationIdentifiers(operation);
		if (
			journalFor(record).some(candidate =>
				operationIdentifiers(candidate).some(identifier => incoming.includes(identifier)),
			) ||
			[...this.provisional.values()].some(
				candidate =>
					candidate.chatId === chatId &&
					operationIdentifiers(candidate).some(identifier => incoming.includes(identifier)),
			)
		)
			throw new Error(
				`Session ingress ${operation.ingressId ?? operation.id} conflicts with an existing operation.`,
			);
	}
	reserve(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		const record = this.records.get(operation.chatId);
		const reassignment = record?.reassignment;
		const ingressId = operation.ingressId ?? operation.id;
		if (record !== undefined && record.projectId !== operation.projectId) {
			if (
				reassignment?.state !== "pending" ||
				reassignment.targetProjectId !== operation.projectId ||
				(reassignment.target !== undefined && !sameTarget(operation, reassignment.target))
			)
				throw new Error(`Session authority for chat ${operation.chatId} is assigned to another project.`);
			if (reassignment.target === undefined) {
				this.records.set(operation.chatId, {
					...record,
					reassignment: { ...reassignment, target: targetIdentity(operation) },
				});
			}
		}
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
		assertReservableIdentity(operation, journalFor(record), [...this.provisional.values()]);
		const next = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		this.provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	publish(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionAuthorityInput,
	): SessionAuthorityRecord {
		const record = this.records.get(operation.chatId),
			reassignment = record?.reassignment,
			ingressId = operation.ingressId ?? operation.id,
			key = provisionalKey(operation.chatId, ingressId);
		if (reassignment?.state === "pending" && mapping.projectId !== record?.projectId) {
			if (
				mapping.projectId !== reassignment.targetProjectId ||
				reassignment.target === undefined ||
				!sameTarget(operation, reassignment.target)
			)
				throw new Error(`Session project reassignment publication does not match its exact target.`);
		} else if (record !== undefined && mapping.projectId !== record.projectId) {
			throw new Error(`Session authority for chat ${operation.chatId} is assigned to another project.`);
		}
		const reserved = assertPublishableIdentity(operation, this.provisional.get(key), journalFor(record), [
			...this.provisional.values(),
		]);
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
		if (reassignment?.state === "pending" && mapping.projectId === reassignment.targetProjectId) {
			const target = createAuthorityIdentity({ ...mapping, journal: [journalOperation] });
			const committed: SessionAuthorityRecord = {
				...target,
				reassignment: {
					...reassignment,
					state: "committed",
					completedAt,
					sourceTombstone: toTombstone(record!, completedAt),
				},
			};
			assertInputIdentityFence(committed, undefined);
			this.records.set(operation.chatId, committed);
			this.provisional.set(key, { ...reserved, state: "complete", completedAt });
			return copy(committed);
		}
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
function journalFor(record: SessionAuthorityRecord | undefined): readonly SessionOperation[] {
	if (record === undefined) return [];
	const journal = [...record.journal];
	let tombstone = record.reassignment?.sourceTombstone;
	while (tombstone !== undefined) {
		journal.push(...tombstone.journal);
		tombstone = tombstone.prior;
	}
	return journal;
}

function targetIdentity(
	operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "kind" | "detail">,
): SessionAuthorityTargetIdentity {
	return {
		id: operation.id,
		...(operation.ingressId === undefined ? {} : { ingressId: operation.ingressId }),
		kind: operation.kind,
		...(operation.detail === undefined ? {} : { detail: operation.detail }),
	};
}

function sameTarget(
	operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "kind" | "detail">,
	target: Pick<SessionAuthorityTargetIdentity, "id" | "ingressId" | "kind" | "detail">,
): boolean {
	return (
		operation.id === target.id &&
		(operation.ingressId ?? operation.id) === (target.ingressId ?? target.id) &&
		operation.kind === target.kind &&
		operation.detail === target.detail
	);
}

function assertTargetIdentity(target: SessionAuthorityTargetIdentity): void {
	if (
		target.id.length === 0 ||
		(target.ingressId !== undefined && target.ingressId.length === 0) ||
		target.kind.length === 0
	)
		throw new Error("Project reassignment target identity is invalid.");
}

function toTombstone(record: SessionAuthorityRecord, retiredAt: string): SessionAuthorityTombstone {
	const { reassignment: _reassignment, ...source } = record;
	return {
		...source,
		header: { ...source.header },
		events: source.events === undefined ? undefined : source.events.map(event => ({ ...event })),
		...(source.modelSelection === undefined ? {} : { modelSelection: { ...source.modelSelection } }),
		observations: source.observations === undefined ? undefined : structuredClone(source.observations),
		...(source.attachment === undefined
			? {}
			: { attachment: { ...source.attachment, descriptorStat: { ...source.attachment.descriptorStat } } }),
		journal: source.journal.map(copyOperation),
		...(record.reassignment?.priorTombstone === undefined
			? {}
			: { prior: copyTombstone(record.reassignment.priorTombstone) }),
		retiredAt,
	};
}

function assertInputIdentityFence(input: SessionAuthorityInput, existing: SessionAuthorityRecord | undefined): void {
	const incoming = input.journal ?? [];
	const prior = journalFor(existing);
	for (const operation of incoming) {
		const collision = prior.find(candidate =>
			operationIdentifiers(candidate).some(identifier => operationIdentifiers(operation).includes(identifier)),
		);
		if (
			collision !== undefined &&
			JSON.stringify([collision.id, collision.ingressId ?? collision.id]) !==
				JSON.stringify([operation.id, operation.ingressId ?? operation.id])
		)
			throw new Error(
				`Session ingress ${operation.ingressId ?? operation.id} conflicts with an existing operation.`,
			);
	}
}
