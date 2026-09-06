import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	canonicalSessionMappingKey,
	type ProvisionalSessionOperation,
	SessionAuthority,
	type SessionAuthorityInput,
	type SessionAuthorityRecord,
	type SessionAuthorityTargetIdentity,
	type SessionAuthorityTombstone,
	type SessionOperation,
	type SessionOperationResult,
	type SessionOperationState,
} from "./session-authority";
import type { ManagedAcknowledgedSuccessor, ManagedSessionOperation } from "./session-authority-copy";
import { AuthorityMutationLock } from "./session-authority-file";
import { SessionAuthorityDurabilityError } from "./session-authority-persistence";
import { type AcknowledgedSuccessor, SessionAuthorityLoadError } from "./session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	type ManagedTurnAuthorityV3,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	type SessionAuthorityV3AcknowledgedSuccessor,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Mapping,
	type SessionAuthorityV3Operation,
	type SessionAuthorityV3ProvisionalOperation,
	type SessionAuthorityV3Reassignment,
	type SessionAuthorityV3Tombstone,
} from "./session-authority-v3";
import { SessionMappingStore } from "./session-mapping-memory-store";
import type { ManagedTurnAuthority } from "./turn-runner";

type ManagedSessionAuthorityTombstone = Omit<SessionAuthorityTombstone, "journal" | "prior"> & {
	readonly journal: readonly ManagedSessionOperation[];
	readonly prior?: ManagedSessionAuthorityTombstone;
};
type ManagedSessionAuthorityReassignment = Omit<
	NonNullable<SessionAuthorityRecord["reassignment"]>,
	"sourceTombstone" | "priorTombstone"
> & {
	readonly sourceTombstone?: ManagedSessionAuthorityTombstone;
	readonly priorTombstone?: ManagedSessionAuthorityTombstone;
};
type ManagedSessionAuthorityRecord = Omit<SessionAuthorityRecord, "journal" | "reassignment"> & {
	readonly journal: readonly ManagedSessionOperation[];
	readonly reassignment?: ManagedSessionAuthorityReassignment;
};
type ManagedProvisionalSessionOperation = Omit<ProvisionalSessionOperation, "acknowledgedSuccessor"> & {
	readonly acknowledgedSuccessor?: ManagedAcknowledgedSuccessor;
};

/** Canonical V3 authority storage. This deliberately has no V2 compatibility,
 * attachment, descriptor, or terminal persistence path. The activation marker
 * is an immutable activation identity; ordinary writes replace only this
 * canonical document and never rewrite or validate that marker. */
class V3FileSessionAuthority extends SessionAuthority {
	#generation = 0;
	#closed = false;

	constructor(readonly filePath: string) {
		super();
		const lock = AuthorityMutationLock.acquire(filePath);
		try {
			if (existsSync(filePath)) {
				this.load();
				super.reconcileRestart(false);
				if (this.hasDirtyJournal()) this.persist();
			}
		} finally {
			lock.release();
		}
	}

	get generation(): number {
		return this.#generation;
	}
	get closed(): boolean {
		return this.#closed;
	}
	close(): void {
		this.#closed = true;
	}

	override set(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.mutate(() => super.set(input));
	}
	override upsert(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.mutate(() => super.upsert(input));
	}
	override reassignProject(chatId: string, currentProjectId: string, nextProjectId: string): boolean {
		return this.mutate(() => super.reassignProject(chatId, currentProjectId, nextProjectId));
	}
	override beginProjectReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): SessionAuthorityRecord {
		return this.mutate(() => super.beginProjectReassignment(chatId, currentProjectId, nextProjectId, target));
	}
	override rollbackProjectReassignment(chatId: string, currentProjectId: string): SessionAuthorityRecord {
		return this.mutate(() => super.rollbackProjectReassignment(chatId, currentProjectId));
	}
	override beginReassignment(
		chatId: string,
		currentProjectId: string,
		nextProjectId: string,
		target?: SessionAuthorityTargetIdentity,
	): SessionAuthorityRecord {
		return this.mutate(() => super.beginReassignment(chatId, currentProjectId, nextProjectId, target));
	}
	override rollbackReassignment(chatId: string, currentProjectId: string): SessionAuthorityRecord {
		return this.mutate(() => super.rollbackReassignment(chatId, currentProjectId));
	}
	override recordAcknowledgedSuccessor(
		chatId: string,
		operationId: string,
		operationHash: string,
		successor: AcknowledgedSuccessor,
	): SessionOperation {
		return this.mutate(() => super.recordAcknowledgedSuccessor(chatId, operationId, operationHash, successor));
	}
	override transitionOperation(
		chatId: string,
		operationId: string,
		state: SessionOperationState,
		detail?: string,
		result?: SessionOperationResult,
	): SessionAuthorityRecord {
		return this.mutate(() => {
			const durableResult =
				result === undefined ? undefined : normalizeResultAuthority(result, this.get(chatId)?.managedAuthority);
			return super.transitionOperation(chatId, operationId, state, detail, durableResult);
		});
	}
	override completeOperationWithMapping(
		chatId: string,
		operationId: string,
		detail: string,
		mapping: SessionAuthorityInput,
		result: SessionOperationResult,
	): SessionAuthorityRecord {
		return this.mutate(() => {
			const durableMapping = {
				...mapping,
				managedAuthority: authorityV3(mapping.managedAuthority, `mapping ${chatId}`),
			};
			const durableResult = normalizeResultAuthority(result, durableMapping.managedAuthority);
			super.transitionOperation(chatId, operationId, "complete", detail, durableResult);
			return super.upsert(durableMapping);
		});
	}
	override beginOperation(
		chatId: string,
		operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">,
	): SessionAuthorityRecord {
		return this.mutate(() => super.beginOperation(chatId, operation));
	}
	override discardPendingOperation(
		chatId: string,
		operation: Pick<SessionOperation, "id" | "ingressId" | "detail">,
	): void {
		this.mutate(() => super.discardPendingOperation(chatId, operation));
	}
	override reserveProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		return this.mutate(() => super.reserveProvisionalOperation(operation));
	}
	override discardPendingProvisionalOperation(
		chatId: string,
		operation: Pick<ProvisionalSessionOperation, "id" | "ingressId" | "detail">,
	): void {
		this.mutate(() => super.discardPendingProvisionalOperation(chatId, operation));
	}
	override publishProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
		mapping: SessionAuthorityInput,
	): SessionAuthorityRecord {
		return this.mutate(() => {
			const published = super.publishProvisionalOperation(operation, mapping);
			const normalized = normalizePublishedRecord(published);
			if (normalized !== published) {
				this.replaceAll(
					this.entries().map(record => (record.chatId === normalized.chatId ? normalized : record)),
					this.provisionalEntries(),
				);
			}
			return normalized;
		});
	}
	override attachProvisionalOperation(
		chatId: string,
		ingressId: string,
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment" | "managedAuthority">,
	): ProvisionalSessionOperation {
		return this.mutate(() => super.attachProvisionalOperation(chatId, ingressId, attachment));
	}
	override transitionProvisionalOperation(
		chatId: string,
		ingressId: string,
		state: SessionOperationState,
		detail?: string,
	): ProvisionalSessionOperation {
		return this.mutate(() => super.transitionProvisionalOperation(chatId, ingressId, state, detail));
	}

	replaceAuthorityState(
		mutation: (
			records: readonly SessionAuthorityRecord[],
			provisional: readonly ProvisionalSessionOperation[],
		) => {
			readonly records: readonly SessionAuthorityRecord[];
			readonly provisional: readonly ProvisionalSessionOperation[];
		},
	): void {
		this.mutate(() => {
			const next = mutation(this.entries(), this.provisionalEntries());
			this.replaceAll(next.records, next.provisional);
		});
	}

	private mutate<T>(action: () => T): T {
		if (this.#closed) throw new Error("Session authority store is closed.");
		const lock = AuthorityMutationLock.acquire(this.filePath);
		let durableMutation = false;
		let mutationError: unknown;
		let failed = false;
		let result!: T;
		try {
			// A second writer may have committed between calls; always reload under
			// the shared file lock before deriving the next immutable V3 document.
			if (existsSync(this.filePath)) this.load();
			const rollback = this.snapshotJournalForRollback();
			try {
				result = action();
				if (this.hasDirtyJournal()) {
					this.persist();
					durableMutation = true;
				}
			} catch (error) {
				if (error instanceof SessionAuthorityDurabilityError) {
					durableMutation = true;
					throw error;
				}
				this.replaceAllWithReferences([...rollback.records.values()], [...rollback.provisional.values()]);
				this.clearDirtyJournal();
				throw error;
			}
		} catch (error) {
			failed = true;
			mutationError = error;
		}
		try {
			lock.release();
		} catch (error) {
			const cause = failed
				? new AggregateError([mutationError, error], "authority mutation and lock release failed")
				: error;
			if (durableMutation) throw new SessionAuthorityDurabilityError(this.filePath, cause);
			throw cause;
		}
		if (failed) throw mutationError;
		return result;
	}

	private load(): void {
		let document: SessionAuthorityV3Document | undefined;
		try {
			document = parseSessionAuthorityV3Document(readFileSync(this.filePath, "utf8"));
		} catch (cause) {
			throw new SessionAuthorityLoadError(this.filePath, "authority JSON is unreadable", cause);
		}
		if (document === undefined)
			throw new SessionAuthorityLoadError(this.filePath, "authority document is not strict V3");
		this.replaceAllWithReferences(
			document.mappings.map(fromV3Mapping) as unknown as SessionAuthorityRecord[],
			document.provisionalOperations.map(fromV3Provisional) as unknown as ProvisionalSessionOperation[],
		);
		this.clearDirtyJournal();
		this.#generation += 1;
	}

	private persist(): void {
		const document: SessionAuthorityV3Document = {
			kind: SESSION_AUTHORITY_V3_KIND,
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: this.entries().map(toV3Mapping),
			provisionalOperations: this.provisionalEntries().map(toV3Provisional),
		};
		const bytes = encodeSessionAuthorityV3Document(document);
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		let descriptor: number | undefined;
		let renameAttempted = false;
		let replaced = false;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, bytes, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameAttempted = true;
			renameSync(temporary, this.filePath);
			replaced = true;
			const directory = openSync(dirname(this.filePath), "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			this.clearDirtyJournal();
			this.#generation += 1;
		} catch (error) {
			// A failed rename whose source disappeared may already have replaced
			// the document. Never report a clean rollback across that boundary.
			const durabilityUncertain = replaced || (renameAttempted && !existsSync(temporary));
			try {
				if (descriptor !== undefined) closeSync(descriptor);
			} catch {
				/* preserve the original persistence failure */
			}
			try {
				unlinkSync(temporary);
			} catch {
				/* uncommitted temporary absent */
			}
			if (durabilityUncertain) {
				try {
					this.load();
				} catch (loadError) {
					throw new SessionAuthorityDurabilityError(
						this.filePath,
						new AggregateError([error, loadError], "authority reload failed after the V3 replacement"),
					);
				}
				throw new SessionAuthorityDurabilityError(this.filePath, error);
			}
			throw error;
		}
	}
}

export class V3FileBackedSessionMappingStore extends SessionMappingStore {
	readonly authorityEpoch = SESSION_AUTHORITY_V3_EPOCH;
	readonly #authority: V3FileSessionAuthority;
	constructor(filePath: string) {
		const authority = new V3FileSessionAuthority(filePath);
		super(authority);
		this.#authority = authority;
	}
	get generation(): number {
		return this.#authority.generation;
	}
	get epoch(): string {
		return this.authorityEpoch;
	}
	close(): void {
		this.#authority.close();
	}
	protected override mutateAuthorityState(
		mutation: (
			records: readonly SessionAuthorityRecord[],
			provisional: readonly ProvisionalSessionOperation[],
		) => {
			readonly records: readonly SessionAuthorityRecord[];
			readonly provisional: readonly ProvisionalSessionOperation[];
		},
	): void {
		this.#authority.replaceAuthorityState(mutation);
	}
}

export { V3FileBackedSessionMappingStore as SessionV3FileBackedMappingStore };

function normalizePublishedRecord(record: SessionAuthorityRecord): SessionAuthorityRecord {
	const authority = record.managedAuthority;
	if (authority === undefined) return record;
	const managedAuthority = { ...authority, chatId: record.chatId };
	const journal = record.journal.map(operation =>
		normalizePublishedOperation(operation, managedAuthority, record.chatId),
	);
	const reassignment =
		record.reassignment === undefined
			? undefined
			: {
					...record.reassignment,
					...(record.reassignment.sourceTombstone === undefined
						? {}
						: { sourceTombstone: normalizePublishedTombstone(record.reassignment.sourceTombstone) }),
					...(record.reassignment.priorTombstone === undefined
						? {}
						: { priorTombstone: normalizePublishedTombstone(record.reassignment.priorTombstone) }),
				};
	const changed =
		authority.chatId !== managedAuthority.chatId ||
		record.journal.some((operation, index) => operation !== journal[index]) ||
		record.reassignment !== reassignment;
	return changed
		? { ...record, managedAuthority, journal, ...(reassignment === undefined ? {} : { reassignment }) }
		: record;
}

function normalizePublishedOperation(
	operation: SessionOperation,
	managedAuthority: ManagedTurnAuthority,
	durableChatId: string,
): SessionOperation {
	const successor = operation.acknowledgedSuccessor;
	const successorAuthority =
		successor === undefined
			? undefined
			: (successor as AcknowledgedSuccessor & { readonly managedAuthority?: ManagedTurnAuthority }).managedAuthority;
	const result = operation.result;
	const normalizedResult =
		result === undefined
			? undefined
			: {
					...result,
					managedAuthority: {
						...(result.managedAuthority ?? managedAuthority),
						chatId: durableChatId,
					},
					mapping: { ...result.mapping, chatId: durableChatId },
				};
	return {
		...operation,
		...(successor === undefined || successorAuthority === undefined
			? {}
			: {
					acknowledgedSuccessor: {
						...successor,
						managedAuthority: { ...successorAuthority, chatId: durableChatId },
					} as AcknowledgedSuccessor,
				}),
		...(normalizedResult === undefined ? {} : { result: normalizedResult }),
	};
}

function normalizePublishedTombstone(tombstone: SessionAuthorityTombstone): SessionAuthorityTombstone {
	const authority = tombstone.managedAuthority;
	if (authority === undefined) return tombstone;
	const managedAuthority = { ...authority, chatId: tombstone.chatId };
	return {
		...tombstone,
		header: { ...tombstone.header, chatId: tombstone.chatId },
		managedAuthority,
		journal: tombstone.journal.map(operation =>
			normalizePublishedOperation(operation, managedAuthority, tombstone.chatId),
		),
		...(tombstone.prior === undefined ? {} : { prior: normalizePublishedTombstone(tombstone.prior) }),
	};
}

function normalizeResultAuthority(
	result: SessionOperationResult,
	mappingAuthority: ManagedTurnAuthority | undefined,
): SessionOperationResult {
	return {
		...result,
		managedAuthority: authorityV3(
			result.managedAuthority === undefined ? mappingAuthority : result.managedAuthority,
			"operation result",
		),
	};
}

function authorityV3(value: unknown, context: string): ManagedTurnAuthorityV3 {
	if (typeof value !== "object" || value === null) throw new Error(`V3 managed authority is required for ${context}.`);
	const authority = value as ManagedTurnAuthority & { readonly authorityEpoch?: unknown };
	if (authority.authorityEpoch !== undefined && authority.authorityEpoch !== SESSION_AUTHORITY_V3_EPOCH)
		throw new Error(`Invalid V3 authority schema epoch for ${context}.`);
	if (typeof authority.epoch !== "string" || authority.epoch.length === 0)
		throw new Error(`Managed runtime epoch is required for ${context}.`);
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
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
	};
}
function authorityV3ForDurableChat(
	value: unknown,
	context: string,
	durableChatId: string | undefined,
): ManagedTurnAuthorityV3 {
	const authority = authorityV3(value, context);
	return durableChatId === undefined ? authority : { ...authority, chatId: durableChatId };
}
function toV3Operation(
	operation: SessionOperation,
	context: string,
	durableChatId?: string,
): SessionAuthorityV3Operation {
	const { acknowledgedSuccessor, result, ...rest } = operation;
	return {
		...rest,
		...(acknowledgedSuccessor === undefined
			? {}
			: {
					acknowledgedSuccessor: toV3Successor(acknowledgedSuccessor, `${context} successor`, durableChatId),
				}),
		...(result === undefined
			? {}
			: {
					result: {
						...result,
						mapping: resultMappingForDurableChat(result.mapping, durableChatId),
						managedAuthority: authorityV3ForDurableChat(
							result.managedAuthority,
							`${context} result`,
							durableChatId,
						),
					},
				}),
	};
}

function toV3Successor(
	successor: unknown,
	context: string,
	durableChatId?: string,
): SessionAuthorityV3AcknowledgedSuccessor {
	if (typeof successor !== "object" || successor === null) {
		throw new Error(`V3 managed successor proof is required for ${context}.`);
	}
	const value = successor as Record<string, unknown>;
	if (
		Object.keys(value).some(key => key !== "sessionId" && key !== "managedAuthority") ||
		typeof value.sessionId !== "string"
	) {
		throw new Error(
			`V3 managed successor proof is required for ${context}; legacy attachment state is not accepted.`,
		);
	}
	return {
		sessionId: value.sessionId,
		managedAuthority: authorityV3ForDurableChat(value.managedAuthority, context, durableChatId),
	};
}

function fromV3Operation(operation: SessionAuthorityV3Operation): ManagedSessionOperation {
	const { acknowledgedSuccessor, result, ...rest } = operation;
	return {
		...rest,
		...(acknowledgedSuccessor === undefined
			? {}
			: {
					acknowledgedSuccessor: {
						sessionId: acknowledgedSuccessor.sessionId,
						managedAuthority: authorityV3(acknowledgedSuccessor.managedAuthority, "reloaded successor"),
					},
				}),
		...(result === undefined ? {} : { result: { ...result, managedAuthority: result.managedAuthority } }),
	};
}
function stripMapping(
	mapping: SessionOperationResult["mapping"],
): SessionAuthorityV3Operation["result"] extends infer _ ? any : never {
	const { sessionFile: _sessionFile, activeLeaf: _activeLeaf, attachment: _attachment, ...v3 } = mapping;
	return v3;
}
function resultMappingForDurableChat(
	mapping: SessionOperationResult["mapping"],
	durableChatId: string | undefined,
): SessionAuthorityV3Operation["result"] extends infer _ ? any : never {
	const v3 = stripMapping(mapping);
	return durableChatId === undefined ? v3 : { ...v3, chatId: durableChatId };
}
function toV3Tombstone(tombstone: SessionAuthorityTombstone, durableChatId?: string): SessionAuthorityV3Tombstone {
	const {
		version: _version,
		sessionFile: _sessionFile,
		activeLeaf: _activeLeaf,
		attachment: _attachment,
		managedAuthority,
		journal,
		prior,
		...rest
	} = tombstone;
	return {
		...rest,
		...(durableChatId === undefined
			? {}
			: { chatId: durableChatId, header: { ...rest.header, chatId: durableChatId } }),
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		managedAuthority: authorityV3ForDurableChat(managedAuthority, "tombstone", durableChatId),
		journal: journal.map(item => toV3Operation(item, "tombstone operation", durableChatId)),
		...(prior === undefined ? {} : { prior: toV3Tombstone(prior, durableChatId) }),
	};
}
function fromV3Tombstone(tombstone: SessionAuthorityV3Tombstone): ManagedSessionAuthorityTombstone {
	const { version: _version, authorityEpoch: _epoch, journal, prior, ...rest } = tombstone;
	return {
		...rest,
		version: 2,
		journal: journal.map(fromV3Operation),
		...(prior === undefined ? {} : { prior: fromV3Tombstone(prior) }),
	};
}
function toV3Reassignment(
	reassignment: NonNullable<SessionAuthorityRecord["reassignment"]>,
	durableChatId?: string,
): SessionAuthorityV3Reassignment {
	const { sourceTombstone, priorTombstone, ...rest } = reassignment;
	return {
		...rest,
		...(sourceTombstone === undefined ? {} : { sourceTombstone: toV3Tombstone(sourceTombstone, durableChatId) }),
		...(priorTombstone === undefined ? {} : { priorTombstone: toV3Tombstone(priorTombstone, durableChatId) }),
	};
}
function fromV3Reassignment(reassignment: SessionAuthorityV3Reassignment): ManagedSessionAuthorityReassignment {
	const { sourceTombstone, priorTombstone, ...rest } = reassignment;
	return {
		...rest,
		...(sourceTombstone === undefined ? {} : { sourceTombstone: fromV3Tombstone(sourceTombstone) }),
		...(priorTombstone === undefined ? {} : { priorTombstone: fromV3Tombstone(priorTombstone) }),
	};
}
function toV3Mapping(record: SessionAuthorityRecord): SessionAuthorityV3Mapping {
	const {
		version: _version,
		sessionFile: _sessionFile,
		activeLeaf: _activeLeaf,
		attachment: _attachment,
		managedAuthority,
		journal,
		reassignment,
		...rest
	} = record;
	return {
		...rest,
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		managedAuthority: authorityV3ForDurableChat(
			managedAuthority,
			`mapping ${record.chatId}`,
			scopedDurableChatId(record),
		),
		journal: journal.map(item =>
			toV3Operation(item, `mapping ${record.chatId} operation`, scopedDurableChatId(record)),
		),
		...(reassignment === undefined
			? {}
			: { reassignment: toV3Reassignment(reassignment, scopedDurableChatId(record)) }),
	};
}
function fromV3Mapping(mapping: SessionAuthorityV3Mapping): ManagedSessionAuthorityRecord {
	const { version: _version, authorityEpoch: _epoch, journal, reassignment, ...rest } = mapping;
	return {
		...rest,
		version: 2,
		journal: journal.map(fromV3Operation),
		...(reassignment === undefined ? {} : { reassignment: fromV3Reassignment(reassignment) }),
	};
}
function toV3Provisional(operation: ProvisionalSessionOperation): SessionAuthorityV3ProvisionalOperation {
	const { sessionFile: _sessionFile, attachment: _attachment, managedAuthority, ...rest } = operation;
	const durableChatId = scopedProvisionalChatId(operation);
	return {
		...toV3Operation(rest, `provisional ${operation.id}`, durableChatId),
		chatId: operation.chatId,
		projectId: operation.projectId,
		...(operation.sessionId === undefined
			? {}
			: {
					sessionId: operation.sessionId,
					managedAuthority: authorityV3ForDurableChat(
						managedAuthority,
						`provisional ${operation.id}`,
						durableChatId,
					),
				}),
	};
}
function fromV3Provisional(operation: SessionAuthorityV3ProvisionalOperation): ManagedProvisionalSessionOperation {
	const { managedAuthority, ...rest } = operation;
	return {
		...fromV3Operation(rest),
		chatId: operation.chatId,
		projectId: operation.projectId,
		...(operation.sessionId === undefined ? {} : { sessionId: operation.sessionId }),
		...(managedAuthority === undefined ? {} : { managedAuthority }),
	};
}

function scopedDurableChatId(record: SessionAuthorityRecord): string | undefined {
	const observation = record.observations?.__gjcSessionMappingScope;
	if (typeof observation !== "object" || observation === null || Array.isArray(observation)) return undefined;
	const principalId = (observation as { readonly principalId?: unknown }).principalId;
	const chatId = (observation as { readonly chatId?: unknown }).chatId;
	return typeof principalId === "string" && typeof chatId === "string"
		? canonicalSessionMappingKey(principalId, chatId) === record.chatId
			? record.chatId
			: undefined
		: undefined;
}

function scopedProvisionalChatId(operation: ProvisionalSessionOperation): string | undefined {
	const authority = operation.managedAuthority;
	if (authority === undefined || authority.chatId === operation.chatId) return undefined;
	return canonicalSessionMappingKey(authority.principalId, authority.chatId) === operation.chatId
		? operation.chatId
		: undefined;
}
