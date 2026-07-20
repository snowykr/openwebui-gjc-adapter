import { copy, copyOperationResult, copyProvisionalOperation } from "./session-authority-copy";
import type {
	ProvisionalSessionOperation,
	SessionAuthorityInput,
	SessionAuthorityRecord,
	SessionOperation,
	SessionOperationResult,
	SessionOperationState,
} from "./session-authority-types";
import {
	createAuthorityIdentity,
	operationResult,
	provisionalKey,
	updateAuthorityIdentity,
} from "./session-operation-codec";

export class SessionAuthority {
	readonly #records = new Map<string, SessionAuthorityRecord>();
	readonly #provisional = new Map<string, ProvisionalSessionOperation>();

	get(chatId: string): SessionAuthorityRecord | undefined {
		const record = this.#records.get(chatId);
		return record === undefined ? undefined : copy(record);
	}
	entries(): readonly SessionAuthorityRecord[] {
		return [...this.#records.values()].map(copy);
	}
	set(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.store(input);
	}
	upsert(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.store(input);
	}
	provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined {
		const operation = this.#provisional.get(provisionalKey(chatId, ingressId));
		return operation === undefined ? undefined : copyProvisionalOperation(operation);
	}
	reserveProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		const ingressId = operation.ingressId ?? operation.id;
		const key = provisionalKey(operation.chatId, ingressId);
		const prior = this.#provisional.get(key);
		if (prior !== undefined) {
			if (
				prior.kind !== operation.kind ||
				prior.projectId !== operation.projectId ||
				prior.detail !== operation.detail
			)
				throw new Error(`Session ingress ${ingressId} conflicts with an existing provisional operation.`);
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		}
		const next = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		this.#provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	publishProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionAuthorityInput,
	): SessionAuthorityRecord {
		const ingressId = operation.ingressId ?? operation.id;
		const key = provisionalKey(operation.chatId, ingressId);
		const reserved = this.#provisional.get(key);
		if (reserved === undefined || reserved.state !== "pending")
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
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
		this.#provisional.set(key, { ...reserved, state: "complete", completedAt });
		return next;
	}
	transitionProvisionalOperation(
		chatId: string,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): ProvisionalSessionOperation {
		const key = provisionalKey(chatId, ingressId);
		const current = this.#provisional.get(key);
		if (current === undefined) throw new Error(`Unknown provisional session operation ${ingressId}.`);
		if (current.state === "complete" && state !== "complete")
			throw new Error("Completed session operations are immutable.");
		const next = {
			...current,
			state,
			...(detail === undefined ? {} : { detail }),
			...(state === "complete" ? { completedAt: new Date().toISOString() } : {}),
		};
		this.#provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	attachProvisionalOperation(
		chatId: string,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
	): ProvisionalSessionOperation {
		const key = provisionalKey(chatId, ingressId);
		const current = this.#provisional.get(key);
		if (current === undefined || current.state !== "pending")
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		if (
			attachment.sessionId === undefined ||
			attachment.attachment === undefined ||
			attachment.attachment.tmuxSocket === undefined ||
			attachment.attachment.tmuxPane === undefined ||
			attachment.attachment.tmuxPanePid === undefined ||
			attachment.attachment.tmuxOwnershipTag === undefined
		)
			throw new Error("Provisional session authority requires an exact endpoint and owned-pane proof.");
		const next = { ...current, ...attachment };
		this.#provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	provisionalEntries(): readonly ProvisionalSessionOperation[] {
		return [...this.#provisional.values()].map(copyProvisionalOperation);
	}
	beginOperation(
		chatId: string,
		operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
	): SessionAuthorityRecord {
		const record = this.require(chatId);
		const prior = record.journal.find(
			candidate =>
				candidate.id === operation.id ||
				(operation.ingressId !== undefined && candidate.ingressId === operation.ingressId),
		);
		if (prior !== undefined) {
			if (prior.kind !== operation.kind)
				throw new Error(
					`Session ingress ${operation.ingressId ?? operation.id} conflicts with an existing operation.`,
				);
			return copy(record);
		}
		const pending = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		const next = { ...record, journal: [...record.journal, pending] };
		this.#records.set(chatId, next);
		return copy(next);
	}
	transitionOperation(
		chatId: string,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): SessionAuthorityRecord {
		const record = this.require(chatId);
		const index = record.journal.findIndex(
			operation => operation.id === operationId || operation.ingressId === operationId,
		);
		if (index < 0) throw new Error(`Unknown session operation ${operationId}.`);
		const current = record.journal[index];
		if (current === undefined) throw new Error(`Unknown session operation ${operationId}.`);
		if (current.state === "complete" && state !== "complete")
			throw new Error("Completed session operations are immutable.");
		if (state === "complete" && result === undefined && current.result === undefined)
			throw new Error("Completed session operations require an immutable result binding.");
		if (state !== "complete" && result !== undefined)
			throw new Error("Only completed session operations may bind a result.");
		const journal = [...record.journal];
		journal[index] = {
			...current,
			state,
			...(detail === undefined ? {} : { detail }),
			...(result === undefined ? {} : { result: copyOperationResult(result) }),
			...(state === "complete" ? { completedAt: new Date().toISOString() } : {}),
		};
		const next = { ...record, journal };
		this.#records.set(chatId, next);
		return copy(next);
	}
	completeOperationWithMapping(
		chatId: string,
		operationId: string,
		detail: string,
		mapping: SessionAuthorityInput,
		result: SessionOperationResult,
	): SessionAuthorityRecord {
		this.upsert(mapping);
		return this.transitionOperation(chatId, operationId, "complete", detail, result);
	}
	reconcileRestart(): readonly SessionAuthorityRecord[] {
		const reconciled: SessionAuthorityRecord[] = [];
		for (const record of this.#records.values()) {
			const journal = record.journal.map(operation =>
				operation.state === "pending"
					? { ...operation, state: "uncertain" as const, detail: operation.detail ?? "restart before completion" }
					: operation,
			);
			if (!journal.some((operation, index) => operation !== record.journal[index])) continue;
			const next = { ...record, journal };
			this.#records.set(record.chatId, next);
			reconciled.push(copy(next));
		}
		for (const operation of this.#provisional.values()) {
			if (operation.state !== "pending") continue;
			const next = {
				...operation,
				state: "uncertain" as const,
				detail: operation.detail ?? "restart before completion",
			};
			this.#provisional.set(provisionalKey(next.chatId, next.ingressId ?? next.id), next);
		}
		return reconciled;
	}
	protected replaceAll(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly ProvisionalSessionOperation[] = [],
	): void {
		this.#records.clear();
		this.#provisional.clear();
		for (const record of records) this.#records.set(record.chatId, copy(record));
		for (const operation of provisional)
			this.#provisional.set(
				provisionalKey(operation.chatId, operation.ingressId ?? operation.id),
				copyProvisionalOperation(operation),
			);
	}
	private store(input: SessionAuthorityInput): SessionAuthorityRecord {
		const existing = this.#records.get(input.chatId);
		const next = existing === undefined ? createAuthorityIdentity(input) : updateAuthorityIdentity(input, existing);
		this.#records.set(next.chatId, next);
		return copy(next);
	}
	private require(chatId: string): SessionAuthorityRecord {
		const record = this.#records.get(chatId);
		if (record === undefined) throw new Error(`Unknown session authority for chat ${chatId}.`);
		return record;
	}
}
