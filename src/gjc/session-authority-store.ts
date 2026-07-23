import { copy, copyProvisionalOperation } from "./session-authority-copy";
import { SessionAuthorityJournal } from "./session-authority-journal";
import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityInput,
	SessionAuthorityRecord,
	SessionOperation,
	SessionOperationResult,
	SessionOperationState,
} from "./session-authority-types";
import { provisionalKey } from "./session-operation-codec";

export class SessionAuthority {
	readonly #journal = new SessionAuthorityJournal();
	get(chatId: string): SessionAuthorityRecord | undefined {
		const record = this.#journal.records.get(chatId);
		return record === undefined ? undefined : copy(record);
	}
	entries(): readonly SessionAuthorityRecord[] {
		return [...this.#journal.records.values()].map(copy);
	}
	set(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.#journal.store(input);
	}
	upsert(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.#journal.store(input);
	}
	reassignProject(chatId: string, currentProjectId: string, nextProjectId: string): boolean {
		return this.#journal.reassignProject(chatId, currentProjectId, nextProjectId);
	}
	provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined {
		const operation = this.#journal.provisional.get(provisionalKey(chatId, ingressId));
		return operation === undefined ? undefined : copyProvisionalOperation(operation);
	}
	reserveProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		return this.#journal.reserve(operation);
	}
	publishProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionAuthorityInput,
	): SessionAuthorityRecord {
		return this.#journal.publish(operation, mapping);
	}
	transitionProvisionalOperation(
		chatId: string,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): ProvisionalSessionOperation {
		return this.#journal.transitionProvisional(chatId, ingressId, state, detail);
	}
	attachProvisionalOperation(
		chatId: string,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
	): ProvisionalSessionOperation {
		return this.#journal.attach(chatId, ingressId, attachment);
	}
	provisionalEntries(): readonly ProvisionalSessionOperation[] {
		return [...this.#journal.provisional.values()].map(copyProvisionalOperation);
	}
	beginOperation(
		chatId: string,
		operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
	): SessionAuthorityRecord {
		return this.#journal.begin(chatId, operation);
	}
	recordAcknowledgedSuccessor(
		chatId: string,
		operationId: string,
		operationHash: string,
		successor: AcknowledgedSuccessor,
	): SessionOperation {
		return this.#journal.acknowledge(chatId, operationId, operationHash, successor);
	}
	transitionOperation(
		chatId: string,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): SessionAuthorityRecord {
		return this.#journal.transition(chatId, operationId, state, detail, result);
	}
	completeOperationWithMapping(
		chatId: string,
		operationId: string,
		detail: string,
		mapping: SessionAuthorityInput,
		result: SessionOperationResult,
	): SessionAuthorityRecord {
		this.transitionOperation(chatId, operationId, "complete", detail, result);
		return this.upsert(mapping);
	}
	reconcileRestart(): readonly SessionAuthorityRecord[] {
		return this.#journal.reconcile();
	}
	protected replaceAll(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly ProvisionalSessionOperation[] = [],
	): void {
		this.#journal.replace(records, provisional);
	}
}
