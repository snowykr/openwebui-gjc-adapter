import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	assertManagedLifecycleEvidenceUpdate,
	copyManagedEndpointReceipt,
	copyManagedLifecycleEvidence,
	isManagedEndpointReceipt,
	type ManagedLifecycleEvidence,
	managedHistoricalSourceAssociation,
	managedLifecycleEvidenceHash,
	transitionManagedLifecycleEvidence,
} from "./managed-lifecycle-evidence";
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
import { AuthorityMutationLock } from "./session-authority-file";
import { SessionAuthorityDurabilityError } from "./session-authority-persistence";
import {
	type AcknowledgedSuccessor,
	type HistoricalSessionBinding,
	SessionAuthorityLoadError,
} from "./session-authority-types";
import {
	encodeSessionAuthorityV3Document,
	type ManagedTurnAuthorityV3,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_KIND,
	type SessionAuthorityV3AcknowledgedSuccessor,
	type SessionAuthorityV3Binding,
	type SessionAuthorityV3Document,
	type SessionAuthorityV3Mapping,
	type SessionAuthorityV3Operation,
	type SessionAuthorityV3ProvisionalOperation,
	type SessionAuthorityV3Reassignment,
	type SessionAuthorityV3Result,
	type SessionAuthorityV3Tombstone,
} from "./session-authority-v3";
import {
	assertBootstrapAccess,
	assertBootstrapAccessCurrent,
	assertBootstrapOperation,
	retainBootstrapReceipt,
	type SessionAuthorityV3BootstrapAccess,
} from "./session-authority-v3-activation";
import { SessionMappingStore } from "./session-mapping-memory-store";
import type { ManagedEndpointReceipt, ManagedTurnAuthority } from "./turn-runner";

export interface SessionAuthorityV3BootstrapStage {
	read(): SessionAuthorityV3Document;
	/** Original, live invocation only. This handle grants no proof, retry, promotion or new effect. */
	retainInvocation(operation: SessionOperation): SessionAuthorityV3InvocationReceipt;
	begin(operationId: string, evidence: ManagedLifecycleEvidence): Promise<SessionOperation>;
	advance(
		operationId: string,
		expectedEvidenceHash: string,
		evidence: ManagedLifecycleEvidence,
	): Promise<SessionOperation>;
	/** Promotes only persisted active-generation proof; remote proof belongs to the restricted coordinator. */
	promote(operationId: string, expectedEvidenceHash: string, evidence: ManagedLifecycleEvidence): Promise<void>;
}

export interface SessionAuthorityV3InvocationReceipt {
	observe(
		identity: { readonly sessionId: string; readonly generation: number } | undefined,
		endpointReceipt?: ManagedEndpointReceipt,
	): ManagedLifecycleEvidence;
	/** Called only after the raw invocation and its observation have settled. */
	finish(): void;
}

/** Canonical V3 authority storage. This deliberately has no V2 compatibility,
 * attachment, descriptor, or terminal persistence path. The activation marker
 * is an immutable activation identity; ordinary writes replace only this
 * canonical document and never rewrite or validate that marker. */
class V3FileSessionAuthority extends SessionAuthority {
	#generation = 0;
	#closed = false;

	constructor(
		readonly filePath: string,
		heldMutationLock?: AuthorityMutationLock,
	) {
		super();
		const lock = heldMutationLock ?? AuthorityMutationLock.acquire(filePath);
		try {
			lock.assertHeld(filePath);
			if (existsSync(filePath)) {
				this.load();
				super.reconcileRestart(false);
				if (this.hasDirtyJournal()) this.persist(lock);
			}
		} finally {
			if (heldMutationLock === undefined) lock.release();
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
		return this.mutate(() => {
			this.assertNotHistorical(input.chatId);
			return super.set(input);
		});
	}
	override upsert(input: SessionAuthorityInput): SessionAuthorityRecord {
		return this.mutate(() => {
			this.assertNotHistorical(input.chatId);
			return super.upsert(input);
		});
	}
	private assertNotHistorical(chatId: string): void {
		if (this.get(chatId)?.historicalBinding !== undefined)
			throw new Error("Historical session requires explicit bootstrap proof before live mutation.");
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
			this.assertNotHistorical(chatId);
			if (mapping.historicalBinding !== undefined)
				throw new Error("Historical mapping cannot be published as an active operation.");
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
		return this.mutate(() => {
			this.assertNotHistorical(chatId);
			return super.beginOperation(chatId, operation);
		});
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
		return this.mutate(() => {
			this.assertNotHistorical(operation.chatId);
			return super.reserveProvisionalOperation(operation);
		});
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
		assertCurrent?: () => void,
	): void {
		this.mutate(() => {
			assertCurrent?.();
			const records = this.entries(),
				provisional = this.provisionalEntries();
			const next = mutation(records, provisional);
			if (next.records === records && next.provisional === provisional) return;
			this.replaceAll(next.records, next.provisional);
		}, assertCurrent);
	}

	private mutate<T>(action: () => T, assertCurrent?: () => void): T {
		if (this.#closed) throw new Error("Session authority store is closed.");
		const lock = AuthorityMutationLock.acquire(this.filePath);
		let durableMutation = false;
		let mutationError: unknown;
		let failed = false;
		let result!: T;
		try {
			lock.assertHeld(this.filePath);
			// A second writer may have committed between calls; always reload under
			// the shared file lock before deriving the next immutable V3 document.
			if (existsSync(this.filePath)) this.load();
			const rollback = this.snapshotJournalForRollback();
			try {
				result = action();
				if (this.hasDirtyJournal()) {
					this.persist(lock, assertCurrent);
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
			document.mappings.map(fromV3Mapping),
			document.provisionalOperations.map(fromV3Provisional),
		);
		this.clearDirtyJournal();
		this.#generation += 1;
	}

	private persist(lock: AuthorityMutationLock, assertCurrent?: () => void): void {
		lock.assertHeld(this.filePath);
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
			lock.assertHeld(this.filePath);
			assertCurrent?.();
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
	constructor(filePath: string, heldMutationLock?: AuthorityMutationLock) {
		const authority = new V3FileSessionAuthority(filePath, heldMutationLock);
		super(authority);
		this.#authority = authority;
	}
	get generation(): number {
		return this.#authority.generation;
	}
	get epoch(): string {
		return this.authorityEpoch;
	}
	/** A dispatch fence reads current canonical bytes, never a different writer's stale in-memory view. */
	catalogProvisionalSnapshot(
		scope: { readonly principalId: string; readonly chatId: string },
		operationId: string,
	): ProvisionalSessionOperation | undefined {
		if (this.#authority.closed) throw new Error("Session authority store is closed.");
		const key = canonicalSessionMappingKey(scope.principalId, scope.chatId);
		const document = parseSessionAuthorityV3Document(readFileSync(this.#authority.filePath));
		if (document === undefined) throw new Error("Catalog admission requires valid canonical V3 authority.");
		const candidates = document.provisionalOperations.filter(
			operation => operation.chatId === key && operation.purpose === "model-catalog" && operation.id === operationId,
		);
		const operation = candidates.length === 1 ? candidates[0] : undefined;
		return operation === undefined ? undefined : { ...fromV3Provisional(operation), chatId: scope.chatId };
	}
	bootstrapStage(access: SessionAuthorityV3BootstrapAccess): SessionAuthorityV3BootstrapStage {
		const path = this.#authority.filePath;
		assertBootstrapAccessCurrent(access, path);
		const issuedReceipts = new Set<string>();
		const admittedInvocations = new Map<string, SessionOperation>();
		let stageIdentity = lstatSync(path, { bigint: true });
		const assertStageIdentity = () => {
			const current = lstatSync(path, { bigint: true });
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.dev !== stageIdentity.dev ||
				current.ino !== stageIdentity.ino ||
				current.size !== stageIdentity.size ||
				current.mtimeNs !== stageIdentity.mtimeNs ||
				current.ctimeNs !== stageIdentity.ctimeNs
			)
				throw new Error("Historical receipt staged authority identity changed.");
		};
		const assertCurrent = () => {
			const manifestDigest = assertBootstrapAccessCurrent(access, path);
			assertStageIdentity();
			return manifestDigest;
		};
		const retainInvocation = (operation: SessionOperation): SessionAuthorityV3InvocationReceipt => {
			assertCurrent();
			const original = structuredClone(operation);
			if (!isDeepStrictEqual(admittedInvocations.get(original.id), original))
				throw new Error("Historical receipt requires this live attempt's original invocation.");
			const initial = original.lifecycle;
			if (
				(original.state !== "pending" && original.state !== "uncertain") ||
				initial?.state !== "invoking" ||
				initial.operation !== "session.resume" ||
				initial.historicalSource === undefined ||
				initial.acknowledged !== undefined ||
				issuedReceipts.has(original.id)
			)
				throw new Error("Historical receipt requires one original pending invocation.");
			const source = initial.historicalSource;
			const locate = (records: readonly SessionAuthorityRecord[]) => {
				const candidates = records.filter(
					record =>
						isDeepStrictEqual(record.historicalBinding, source.historicalBinding) ||
						managedHistoricalSourceAssociation(record, source.historicalBinding)?.operationId === original.id,
				);
				const record = candidates.length === 1 ? candidates[0] : undefined;
				const retained = record?.journal.find(item => item.id === original.id);
				if (
					record === undefined ||
					retained === undefined ||
					retained.ingressId !== original.ingressId ||
					retained.startedAt !== original.startedAt ||
					retained.kind !== original.kind ||
					retained.detail !== original.detail ||
					retained.lifecycle?.requestHash !== initial.requestHash ||
					!isDeepStrictEqual(retained.lifecycle.preparedAuthority, initial.preparedAuthority) ||
					!isDeepStrictEqual(retained.lifecycle.historicalSource, source) ||
					!isDeepStrictEqual(retained.lifecycle.target, initial.target)
				)
					throw new Error("Historical receipt original owner changed.");
				return { record, retained };
			};
			const retained = locate(this.#authority.entries()).retained;
			if (!isDeepStrictEqual(retained, original))
				throw new Error("Historical receipt invocation changed before admission.");
			const owner = retainBootstrapReceipt(access, path);
			admittedInvocations.delete(original.id);
			issuedReceipts.add(original.id);
			let expected = initial;
			let observation:
				| {
						identity: { sessionId: string; generation: number } | undefined;
						endpointReceipt?: ManagedEndpointReceipt;
				  }
				| undefined;
			let failure: { error: unknown } | undefined;
			let finished = false;
			const assertReceiptCurrent = () => {
				owner.assertCurrent();
				assertStageIdentity();
			};
			const update = (
				finish: boolean,
				identity?: { sessionId: string; generation: number },
				endpointReceipt?: ManagedEndpointReceipt,
			): ManagedLifecycleEvidence => {
				let updated!: ManagedLifecycleEvidence;
				this.#authority.replaceAuthorityState((records, provisional) => {
					const { record, retained: current } = locate(records);
					const evidence = current.lifecycle!;
					if (
						finish &&
						evidence.state === "active_generation_proven" &&
						expected.state === "acknowledged_unproven" &&
						isDeepStrictEqual(evidence.acknowledged, expected.acknowledged)
					) {
						assertManagedLifecycleEvidenceUpdate(expected, evidence);
						updated = evidence;
						return { records, provisional };
					}
					if (current.state !== original.state || !isDeepStrictEqual(evidence, expected))
						throw new Error("Historical receipt evidence changed before observation.");
					updated = evidence;
					if (!finish && identity !== undefined) {
						updated = transitionManagedLifecycleEvidence(evidence, "acknowledged_unproven", {
							acknowledged: { ...initial.preparedAuthority, ...identity },
							...(endpointReceipt === undefined ? {} : { endpointReceipt }),
						});
					}
					if ((finish || identity === undefined || !owner.admitted()) && updated.state !== "uncertain")
						updated = transitionManagedLifecycleEvidence(updated, "uncertain");
					if (isDeepStrictEqual(updated, evidence)) return { records, provisional };
					return {
						records: records.map(item =>
							item === record
								? {
										...record,
										journal: record.journal.map(item =>
											item === current ? { ...item, lifecycle: updated } : item,
										),
									}
								: item,
						),
						provisional,
					};
				}, assertReceiptCurrent);
				stageIdentity = lstatSync(path, { bigint: true });
				expected = copyManagedLifecycleEvidence(updated);
				return copyManagedLifecycleEvidence(updated);
			};
			return Object.freeze({
				observe: (
					value: { readonly sessionId: string; readonly generation: number } | undefined,
					endpointReceipt?: ManagedEndpointReceipt,
				) => {
					if (finished) throw new Error("Historical receipt ownership is closed.");
					try {
						const identity = value === undefined ? undefined : structuredClone(value);
						if (
							identity !== undefined &&
							(Object.keys(identity).some(key => key !== "sessionId" && key !== "generation") ||
								identity.sessionId !== source.historicalBinding.sessionId ||
								!Number.isSafeInteger(identity.generation) ||
								identity.generation <= 0)
						)
							throw new Error("Historical receipt does not match its original session outcome.");
						if (
							endpointReceipt !== undefined &&
							(identity === undefined || !isManagedEndpointReceipt(endpointReceipt, identity))
						)
							throw new Error("Historical endpoint receipt does not match its original session outcome.");
						const retainedEndpoint =
							endpointReceipt === undefined ? undefined : copyManagedEndpointReceipt(endpointReceipt);
						if (observation !== undefined) {
							assertReceiptCurrent();
							if (
								!isDeepStrictEqual(observation.identity, identity) ||
								!isDeepStrictEqual(observation.endpointReceipt, retainedEndpoint)
							)
								throw new Error("Historical receipt observation is immutable.");
							const current = locate(this.#authority.entries()).retained;
							if (!isDeepStrictEqual(current.lifecycle, expected))
								throw new Error("Historical receipt evidence changed before observation.");
							return copyManagedLifecycleEvidence(expected);
						}
						const result = update(false, identity, retainedEndpoint);
						observation = {
							identity,
							...(retainedEndpoint === undefined ? {} : { endpointReceipt: retainedEndpoint }),
						};
						return result;
					} catch (error) {
						failure ??= { error };
						throw error;
					}
				},
				finish: () => {
					if (finished) {
						if (failure !== undefined) throw failure.error;
						return;
					}
					try {
						if (failure !== undefined) throw failure.error;
						update(true);
					} catch (error) {
						failure ??= { error };
						throw error;
					} finally {
						finished = true;
						owner.release(failure);
					}
				},
			});
		};
		const mutate = async (
			kind: "begin" | "advance" | "promote",
			operationId: string,
			expectedHash: string | undefined,
			input: ManagedLifecycleEvidence,
		): Promise<SessionOperation> => {
			const evidence = copyManagedLifecycleEvidence(input);
			const acknowledgement = kind === "advance" && evidence.state === "acknowledged_unproven";
			const uncertain = kind === "advance" && evidence.state === "uncertain";
			// The invocation's owned durable intent authorizes acknowledgement
			// capture even if its external lease was just revoked. Fresh lease proof
			// remains mandatory before adoption, promotion, or another effect.
			if (acknowledgement || uncertain) await assertBootstrapAccess(access, path);
			else await assertBootstrapOperation(access, path, evidence);
			const source = evidence.historicalSource;
			if (
				source === undefined ||
				source.manifestDigest !== assertCurrent() ||
				!operationId.startsWith("migration:resume:") ||
				operationId.length === "migration:resume:".length
			)
				throw new Error("Historical bootstrap operation does not match its manifest and namespaced identity.");
			let updated!: SessionOperation;
			let admitted = false;
			this.#authority.replaceAuthorityState((records, provisional) => {
				const destination = canonicalSessionMappingKey(
					evidence.preparedAuthority.principalId,
					evidence.preparedAuthority.chatId,
				);
				const candidates = records
					.map((record, index) => ({ record, index }))
					.filter(
						({ record }) =>
							isDeepStrictEqual(record.historicalBinding, source.historicalBinding) ||
							(record.chatId === destination &&
								managedHistoricalSourceAssociation(record, source.historicalBinding)?.operationId ===
									operationId),
					);
				const index = candidates.length === 1 ? candidates[0]!.index : -1;
				const record = records[index];
				if (
					record === undefined ||
					record.projectId !== evidence.preparedAuthority.projectId ||
					record.sessionId !== source.historicalBinding.sessionId
				)
					throw new Error("Historical bootstrap source occurrence is unavailable.");
				const found = record.journal.find(operation => operation.id === operationId);
				if (record.historicalBinding === undefined) {
					if (
						kind === "promote" &&
						found?.state === "complete" &&
						found.lifecycle !== undefined &&
						managedLifecycleEvidenceHash(found.lifecycle) === expectedHash &&
						isDeepStrictEqual(found.lifecycle, evidence) &&
						isDeepStrictEqual(
							record.managedAuthority,
							authorityV3ForDurableChat(evidence.acknowledged, "bootstrap", record.chatId),
						)
					) {
						updated = found;
						return { records, provisional };
					}
					throw new Error("Historical bootstrap cannot rewrite an already managed occurrence.");
				}
				if (!isDeepStrictEqual(record.historicalBinding, source.historicalBinding))
					throw new Error("Historical bootstrap evidence names a different source occurrence.");
				if (kind === "begin") {
					if (evidence.state !== "intent_prepared")
						throw new Error("Historical bootstrap must durably prepare before invocation.");
					if (found !== undefined) {
						if (!isDeepStrictEqual(found.lifecycle, evidence))
							throw new Error("Historical bootstrap operation already has different evidence.");
						updated = found;
						return { records, provisional };
					}
					if (record.journal.some(operation => operation.lifecycle?.historicalSource !== undefined))
						throw new Error("Historical bootstrap cannot start a new key for an existing attempt.");
					updated = {
						id: operationId,
						ingressId: operationId,
						kind: "resume",
						state: "pending",
						startedAt: evidence.recordedAt,
						detail: evidence.payloadHash,
						lifecycle: evidence,
					};
				} else {
					if (
						found?.lifecycle === undefined ||
						found.state === "complete" ||
						found.state === "conflict" ||
						managedLifecycleEvidenceHash(found.lifecycle) !== expectedHash
					)
						throw new Error("Historical bootstrap evidence changed before journal mutation.");
					if (found.lifecycle.state === "uncertain" && evidence.state !== "uncertain")
						throw new Error("Uncertain bootstrap recovery requires original-incarnation public evidence.");
					if (acknowledgement && found.lifecycle.state !== "invoking")
						throw new Error("Bootstrap acknowledgement requires this attempt's durable invocation.");
					assertManagedLifecycleEvidenceUpdate(found.lifecycle, evidence);
					admitted = found.lifecycle.state === "intent_prepared" && evidence.state === "invoking";
					updated = { ...found, lifecycle: evidence };
				}
				let replacement: SessionAuthorityRecord = {
					...record,
					journal:
						found === undefined
							? [...record.journal, updated]
							: record.journal.map(operation => (operation.id === operationId ? updated : operation)),
				};
				if (kind === "promote") {
					if (
						evidence.state !== "active_generation_proven" ||
						evidence.acknowledged === undefined ||
						evidence.proven === undefined ||
						!isDeepStrictEqual(found!.lifecycle, evidence)
					)
						throw new Error("Historical bootstrap promotion requires already persisted exact generation proof.");
					if (
						records.some(item => item !== record && item.chatId === destination) ||
						(destination !== record.chatId && provisional.some(item => item.chatId === destination))
					)
						throw new Error("Historical bootstrap destination is already occupied.");
					updated = { ...updated, state: "complete", completedAt: evidence.recordedAt };
					const { historicalBinding: _history, ...fields } = replacement;
					replacement = {
						...fields,
						chatId: destination,
						header: { ...record.header, chatId: destination },
						managedAuthority: authorityV3ForDurableChat(evidence.acknowledged, "bootstrap", destination),
						journal: record.journal.map(operation => (operation.id === operationId ? updated : operation)),
					};
				}
				return { records: records.map((item, offset) => (offset === index ? replacement : item)), provisional };
			}, assertCurrent);
			stageIdentity = lstatSync(path, { bigint: true });
			if (admitted) admittedInvocations.set(operationId, structuredClone(updated));
			return structuredClone(updated);
		};
		return Object.freeze({
			retainInvocation,
			read: () => {
				assertCurrent();
				const document = parseSessionAuthorityV3Document(readFileSync(path));
				if (document === undefined) throw new Error("Historical bootstrap stage is not a valid V3 document.");
				return document;
			},
			begin: (operationId: string, evidence: ManagedLifecycleEvidence) =>
				mutate("begin", operationId, undefined, evidence),
			advance: (operationId: string, hash: string, evidence: ManagedLifecycleEvidence) =>
				mutate("advance", operationId, hash, evidence),
			promote: async (operationId: string, hash: string, evidence: ManagedLifecycleEvidence) => {
				await mutate("promote", operationId, hash, evidence);
			},
		});
	}
	assertServingReady(): void {
		if (
			[...this.#authority.recordsIterable()].some(record => record.historicalBinding !== undefined) ||
			this.#authority
				.provisionalEntries()
				.some(operation => operation.historicalBinding !== undefined && operation.state !== "complete")
		)
			throw new Error("Canonical V3 contains unbound history requiring restricted bootstrap.");
		if (this.#authority.provisionalEntries().some(operation => operation.state !== "complete"))
			throw new Error("Canonical V3 contains unfinished provisional operations requiring reconciliation.");
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
		successor !== undefined && "managedAuthority" in successor ? successor.managedAuthority : undefined;
	const result = operation.result;
	const normalizedResult =
		result === undefined
			? undefined
			: result.historicalBinding !== undefined
				? result
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
	if (result.historicalBinding !== undefined) return result;
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

function bindingV3(
	value: { readonly managedAuthority?: ManagedTurnAuthority; readonly historicalBinding?: HistoricalSessionBinding },
	context: string,
	durableChatId?: string,
): SessionAuthorityV3Binding {
	if (value.historicalBinding !== undefined) {
		if (value.managedAuthority !== undefined) throw new Error("Historical evidence cannot carry managed authority.");
		const history = structuredClone(value.historicalBinding);
		return { historicalBinding: history };
	}
	return { managedAuthority: authorityV3ForDurableChat(value.managedAuthority, context, durableChatId) };
}

function toV3Result(result: SessionOperationResult, context: string, durableChatId?: string): SessionAuthorityV3Result {
	const { managedAuthority: _managed, historicalBinding: _history, ...rest } = result;
	return {
		...rest,
		...bindingV3(result, context, durableChatId),
		mapping: resultMappingForDurableChat(
			result.mapping,
			result.historicalBinding === undefined ? durableChatId : undefined,
		),
	};
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
					result: toV3Result(result, `${context} result`, durableChatId),
				}),
	};
}

function toV3Successor(
	successor: AcknowledgedSuccessor,
	context: string,
	durableChatId?: string,
): SessionAuthorityV3AcknowledgedSuccessor {
	if ("attachment" in successor) {
		throw new Error(
			`V3 managed successor proof is required for ${context}; legacy attachment state is not accepted.`,
		);
	}
	return {
		sessionId: successor.sessionId,
		...bindingV3(successor, context, durableChatId),
	};
}

function fromV3Operation(operation: SessionAuthorityV3Operation): SessionOperation {
	return structuredClone(operation);
}
function resultMappingForDurableChat(
	mapping: SessionOperationResult["mapping"],
	durableChatId: string | undefined,
): SessionAuthorityV3Result["mapping"] {
	const { attachment: _attachment, ...v3 } = mapping;
	return durableChatId === undefined ? v3 : { ...v3, chatId: durableChatId };
}
function toV3Tombstone(tombstone: SessionAuthorityTombstone, durableChatId?: string): SessionAuthorityV3Tombstone {
	const ownedChatId = tombstone.historicalBinding === undefined ? durableChatId : undefined;
	const {
		version: _version,
		attachment: _attachment,
		managedAuthority: _managedAuthority,
		historicalBinding: _historicalBinding,
		journal,
		prior,
		...rest
	} = tombstone;
	return {
		...rest,
		...(ownedChatId === undefined ? {} : { chatId: ownedChatId, header: { ...rest.header, chatId: ownedChatId } }),
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		...bindingV3(tombstone, "tombstone", ownedChatId),
		journal: journal.map(item => toV3Operation(item, "tombstone operation", durableChatId)),
		...(prior === undefined ? {} : { prior: toV3Tombstone(prior, durableChatId) }),
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
	durableChatId?: string,
): SessionAuthorityV3Reassignment {
	const { sourceTombstone, priorTombstone, ...rest } = reassignment;
	return {
		...rest,
		...(sourceTombstone === undefined ? {} : { sourceTombstone: toV3Tombstone(sourceTombstone, durableChatId) }),
		...(priorTombstone === undefined ? {} : { priorTombstone: toV3Tombstone(priorTombstone, durableChatId) }),
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
		attachment: _attachment,
		managedAuthority: _managedAuthority,
		historicalBinding: _historicalBinding,
		journal,
		reassignment,
		...rest
	} = record;
	return {
		...rest,
		version: 3,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		...bindingV3(record, `mapping ${record.chatId}`, scopedDurableChatId(record)),
		journal: journal.map(item =>
			toV3Operation(item, `mapping ${record.chatId} operation`, scopedDurableChatId(record)),
		),
		...(reassignment === undefined
			? {}
			: { reassignment: toV3Reassignment(reassignment, scopedDurableChatId(record)) }),
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
	const {
		attachment: _attachment,
		managedAuthority: _managed,
		historicalBinding,
		sessionId,
		chatId,
		projectId,
		sessionFile,
		activeLeaf,
		...rest
	} = operation;
	const durableChatId = scopedProvisionalChatId(operation);
	const base = {
		...toV3Operation(rest, `provisional ${operation.id}`, durableChatId),
		chatId,
		projectId,
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(activeLeaf === undefined ? {} : { activeLeaf }),
	};
	return sessionId === undefined
		? {
				...base,
				...(historicalBinding === undefined ? {} : { historicalBinding: structuredClone(historicalBinding) }),
			}
		: { ...base, sessionId, ...bindingV3(operation, `provisional ${operation.id}`, durableChatId) };
}
function fromV3Provisional(operation: SessionAuthorityV3ProvisionalOperation): ProvisionalSessionOperation {
	return structuredClone(operation);
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
