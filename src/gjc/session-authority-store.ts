import { copy, copyProvisionalOperation } from "./session-authority-copy";
import { SessionAuthorityJournal } from "./session-authority-journal";
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
import { provisionalKey } from "./session-operation-codec";

export class SessionAuthority {
	readonly #journal = new SessionAuthorityJournal();
	get(chatId: string): SessionAuthorityRecord | undefined {
		const record = this.#journal.records.get(chatId);
		return record === undefined ? undefined : copy(record);
	}
	/** Copy-free record lookup for boot synthesis: returns the ACTUAL record
	 * object (shared by reference) so oversized retained payloads are never
	 * deep-copied while a record is only being inspected (retirement, scope,
	 * operation state). Consumers must not mutate the returned record. */
	recordReference(chatId: string): SessionAuthorityRecord | undefined {
		return this.#journal.records.get(chatId);
	}
	entries(): readonly SessionAuthorityRecord[] {
		return [...this.#journal.records.values()].map(copy);
	}
	/**
	 * Read-only view of the live records; callers must not mutate the returned
	 * records or their nested event payloads.
	 */
	/** @internal Boot-synthesis-only no-copy view of the journal's records.
	 * Returns the ACTUAL record objects (shared by reference): consumers must
	 * never mutate them or their nested payloads, or they would modify durable
	 * state without dirty tracking. Public copy-returning access is entries(). */
	records(): readonly SessionAuthorityRecord[] {
		return [...this.#journal.records.values()];
	}
	/** @internal Streaming no-copy view of the journal's records. Iterates the
	 * live Map directly without allocating an array of every value, so a
	 * record-count-dominated authority does not exhaust the heap before the
	 * caller can filter/project one entry at a time. */
	*recordsIterable(): Iterable<SessionAuthorityRecord> {
		for (const record of this.#journal.records.values()) yield record;
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
	beginProjectReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): SessionAuthorityRecord {
		return this.#journal.beginProjectReassignment(chatId, currentProjectId, nextProjectId, target);
	}
	rollbackProjectReassignment(chatId: string, currentProjectId: string): SessionAuthorityRecord {
		return this.#journal.rollbackProjectReassignment(chatId, currentProjectId);
	}
	beginReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): SessionAuthorityRecord {
		return this.#journal.beginReassignment(chatId, currentProjectId, nextProjectId, target);
	}
	rollbackReassignment(chatId: string, currentProjectId: string): SessionAuthorityRecord {
		return this.#journal.rollbackReassignment(chatId, currentProjectId);
	}
	lookupOperation(chatId: string, operationId: string): SessionOperation | undefined {
		return this.#journal.lookupOperation(chatId, operationId);
	}
	/** Copy-free operation state check for boot synthesis (see the journal
	 * counterpart): avoids the document-sized copies that lookupOperation()
	 * would incur for oversized legacy records. */
	operationStateReference(
		chatId: string,
		operationId: string,
	): { readonly state: SessionOperationState; readonly resultOperationId?: string } | undefined {
		return this.#journal.operationStateReference(chatId, operationId);
	}
	lookupOperationAuthority(
		chatId: string,
		operationId: string,
	): SessionAuthorityRecord | SessionAuthorityTombstone | undefined {
		return this.#journal.lookupOperationAuthority(chatId, operationId);
	}
	assertOperationProject(chatId: string, projectId: string, operationId: string): void {
		this.#journal.assertOperationProject(chatId, projectId, operationId);
	}
	assertOperationIdentity(
		chatId: string,
		projectId: string,
		operation: Pick<SessionOperation, "id" | "ingressId">,
	): void {
		this.#journal.assertOperationIdentity(chatId, projectId, operation);
	}
	provisionalOperation(chatId: string, ingressId: string): ProvisionalSessionOperation | undefined {
		const operation =
			this.#journal.provisional.get(provisionalKey(chatId, ingressId)) ??
			[...this.#journal.provisional.values()].find(
				candidate =>
					candidate.chatId === chatId && (candidate.id === ingressId || candidate.ingressId === ingressId),
			);
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
	discardPendingOperation(chatId: string, operation: Pick<SessionOperation, "id" | "ingressId" | "detail">): void {
		this.#journal.discardPendingOperation(chatId, operation);
	}
	discardPendingProvisionalOperation(
		chatId: string,
		operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "detail">,
	): void {
		this.#journal.discardPendingProvisionalOperation(chatId, operation);
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
	reconcileRestart(copyResults = true): readonly SessionAuthorityRecord[] {
		return this.#journal.reconcile(copyResults);
	}
	protected takeDirtyRecords(): readonly SessionAuthorityRecord[] {
		return this.#journal.takeDirtyRecords();
	}
	protected takeDirtyProvisional(): readonly {
		readonly key: string;
		readonly operation: ProvisionalSessionOperation;
	}[] {
		return this.#journal.takeDirtyProvisional();
	}
	protected snapshotJournalForRollback(): {
		readonly records: ReadonlyMap<string, SessionAuthorityRecord>;
		readonly provisional: ReadonlyMap<string, ProvisionalSessionOperation>;
	} {
		return this.#journal.snapshotReferences();
	}
	protected rawJournalEntries(): {
		readonly records: ReadonlyMap<string, SessionAuthorityRecord>;
		readonly provisional: ReadonlyMap<string, ProvisionalSessionOperation>;
	} {
		return this.#journal.rawEntries();
	}
	protected replaceAllWithReferences(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly ProvisionalSessionOperation[] = [],
	): void {
		this.#journal.replaceReferences(records, provisional);
	}
	protected hasDirtyJournal(): boolean {
		return this.#journal.hasDirty;
	}
	protected journalNeedsCompaction(): boolean {
		return this.#journal.needsCompaction;
	}
	protected clearDirtyJournal(): void {
		this.#journal.clearDirty();
	}
	protected replaceAll(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly ProvisionalSessionOperation[] = [],
	): void {
		this.#journal.replace(records, provisional);
	}
}
