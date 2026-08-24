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
import { AuthorityMutationLock } from "./session-authority-file";
import { type AcknowledgedSuccessor, SessionAuthorityLoadError } from "./session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	type ManagedTurnAuthorityV3,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Mapping,
	type SessionAuthorityV3Operation,
	type SessionAuthorityV3ProvisionalOperation,
	type SessionAuthorityV3Reassignment,
	type SessionAuthorityV3Tombstone,
} from "./session-authority-v3";
import { SessionMappingStore } from "./session-mapping-memory-store";

/** Canonical V3 authority storage. This deliberately has no V2 compatibility,
 * attachment, descriptor, or terminal persistence path. */
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
		return this.mutate(() => super.transitionOperation(chatId, operationId, state, detail, result));
	}
	override completeOperationWithMapping(
		chatId: string,
		operationId: string,
		detail: string,
		mapping: SessionAuthorityInput,
		result: SessionOperationResult,
	): SessionAuthorityRecord {
		return this.mutate(() => {
			super.transitionOperation(chatId, operationId, "complete", detail, result);
			return super.upsert(mapping);
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
		return this.mutate(() => super.publishProvisionalOperation(operation, mapping));
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
		try {
			// A second writer may have committed between calls; always reload under
			// the shared file lock before deriving the next immutable V3 document.
			if (existsSync(this.filePath)) this.load();
			const result = action();
			this.persist();
			return result;
		} finally {
			lock.release();
		}
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
			document.mappings.map(fromV3Mapping),
			document.provisionalOperations.map(fromV3Provisional),
		);
		this.clearDirtyJournal();
		this.#generation += 1;
	}

	private persist(): void {
		const document: SessionAuthorityV3Document = {
			version: 3,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			mappings: this.entries().map(toV3Mapping),
			provisionalOperations: this.provisionalEntries().map(toV3Provisional),
		};
		const bytes = encodeSessionAuthorityV3Document(document);
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporary, "wx", 0o600);
			writeFileSync(descriptor, bytes, "utf8");
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(temporary, this.filePath);
			const directory = openSync(dirname(this.filePath), "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			this.clearDirtyJournal();
			this.#generation += 1;
		} catch (error) {
			if (descriptor !== undefined) closeSync(descriptor);
			try {
				unlinkSync(temporary);
			} catch {
				/* uncommitted temporary absent */
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

function authorityV3(value: unknown, context: string): ManagedTurnAuthorityV3 {
	if (typeof value !== "object" || value === null) throw new Error(`V3 managed authority is required for ${context}.`);
	const authority = value as Omit<ManagedTurnAuthorityV3, "authorityEpoch">;
	if (authority.epoch !== SESSION_AUTHORITY_V3_EPOCH)
		throw new Error(`V3 managed authority epoch is required for ${context}.`);
	return { ...authority, authorityEpoch: SESSION_AUTHORITY_V3_EPOCH };
}
function toV3Operation(operation: SessionOperation, context: string): SessionAuthorityV3Operation {
	const { acknowledgedSuccessor, result, ...rest } = operation;
	return {
		...rest,
		...(acknowledgedSuccessor === undefined
			? {}
			: {
					acknowledgedSuccessor: {
						sessionId: acknowledgedSuccessor.sessionId,
						managedAuthority: authorityV3(
							(acknowledgedSuccessor as unknown as { managedAuthority?: unknown }).managedAuthority,
							`${context} successor`,
						),
					},
				}),
		...(result === undefined
			? {}
			: {
					result: {
						...result,
						mapping: stripMapping(result.mapping),
						managedAuthority: authorityV3(result.managedAuthority, `${context} result`),
					},
				}),
	};
}
function fromV3Operation(operation: SessionAuthorityV3Operation): SessionOperation {
	const { acknowledgedSuccessor, result, ...rest } = operation;
	return {
		...rest,
		...(acknowledgedSuccessor === undefined
			? {}
			: {
					acknowledgedSuccessor: {
						sessionId: acknowledgedSuccessor.sessionId,
						attachment: {} as AcknowledgedSuccessor["attachment"],
						managedAuthority: acknowledgedSuccessor.managedAuthority,
					} as AcknowledgedSuccessor,
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
function toV3Tombstone(tombstone: SessionAuthorityTombstone): SessionAuthorityV3Tombstone {
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
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		managedAuthority: authorityV3(managedAuthority, "tombstone"),
		journal: journal.map(item => toV3Operation(item, "tombstone operation")),
		...(prior === undefined ? {} : { prior: toV3Tombstone(prior) }),
	};
}
function fromV3Tombstone(tombstone: SessionAuthorityV3Tombstone): SessionAuthorityTombstone {
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
): SessionAuthorityV3Reassignment {
	const { sourceTombstone, priorTombstone, ...rest } = reassignment;
	return {
		...rest,
		...(sourceTombstone === undefined ? {} : { sourceTombstone: toV3Tombstone(sourceTombstone) }),
		...(priorTombstone === undefined ? {} : { priorTombstone: toV3Tombstone(priorTombstone) }),
	};
}
function fromV3Reassignment(
	reassignment: SessionAuthorityV3Reassignment,
): NonNullable<SessionAuthorityRecord["reassignment"]> {
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
		managedAuthority: authorityV3(managedAuthority, `mapping ${record.chatId}`),
		journal: journal.map(item => toV3Operation(item, `mapping ${record.chatId} operation`)),
		...(reassignment === undefined ? {} : { reassignment: toV3Reassignment(reassignment) }),
	};
}
function fromV3Mapping(mapping: SessionAuthorityV3Mapping): SessionAuthorityRecord {
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
	if (operation.sessionId === undefined)
		throw new Error(`V3 provisional operation ${operation.id} requires a session ID.`);
	return {
		...toV3Operation(rest, `provisional ${operation.id}`),
		chatId: operation.chatId,
		projectId: operation.projectId,
		sessionId: operation.sessionId,
		managedAuthority: authorityV3(managedAuthority, `provisional ${operation.id}`),
	};
}
function fromV3Provisional(operation: SessionAuthorityV3ProvisionalOperation): ProvisionalSessionOperation {
	const { managedAuthority, ...rest } = operation;
	return {
		...fromV3Operation(rest),
		chatId: operation.chatId,
		projectId: operation.projectId,
		sessionId: operation.sessionId,
		managedAuthority,
	};
}
