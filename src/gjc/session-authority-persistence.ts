import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pendingWorkflowGateFromEvent } from "../projection/workflow-gates";
import { AuthorityMutationLock } from "./session-authority-file";
import { SessionAuthority } from "./session-authority-store";
import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityInput,
	SessionAuthorityReassignment,
	SessionAuthorityRecord,
	SessionAuthorityTargetIdentity,
	SessionAuthorityTombstone,
	SessionOperation,
	SessionOperationResult,
	SessionOperationState,
} from "./session-authority-types";
import { SESSION_AUTHORITY_VERSION, SessionAuthorityLoadError } from "./session-authority-types";
import {
	isAlreadyExists,
	isAuthorityDocumentRelationallyValid,
	isLegacyMappingDocument,
	isProvisionalOperation,
	isV2Record,
} from "./session-authority-validation";

const WAL_KIND = "openwebui-gjc-session-authority-wal" as const;
const WAL_VERSION = 2 as const;
const WAL_CHAIN_SEED = "openwebui-gjc-session-authority-wal:v2";
const WAL_COMPACTION_THRESHOLD_BYTES = 32 * 1024 * 1024;
/** Legacy v1 WALs carry no chained line hashes; they are compacted away on the
 * first mutation after adoption and their identity is a bounded head+tail
 * content sample. */
const WAL_LEGACY_VERSION = 1 as const;

/** One chained link: the hash binds the previous link's hash and this line's
 * exact text, so the chain covers every delta line cryptographically. */
function lineChainHash(prevHash: string, lineText: string): string {
	return createHash("sha256").update(prevHash).update("\n").update(lineText).digest("hex");
}

type BaseIdentity = {
	readonly size: number;
	readonly mtimeMs: number;
	readonly generation?: string;
	/** Byte offset of the top-level generation key in the base document, cached
	 * so the live per-mutation verification reads a bounded window instead of
	 * scanning the whole document. */
	readonly generationOffset?: number;
	/** UTF-8 byte length of the serialized generation span (key + whitespace +
	 * colon + quoted value), so the per-mutation read window covers the complete
	 * value regardless of an external writer's formatting. */
	readonly generationSpanLength?: number;
	/** SHA-256 of the base document bytes, computed at load/persist time and
	 * bound into the WAL header: an external rewrite that preserves generation,
	 * size, and mtime still changes the digest, so the stale WAL is discarded at
	 * boot instead of being replayed over the edited base (which would silently
	 * revert the operator's change). */
	readonly digest?: string;
};
type WalIdentity = {
	readonly size: number;
	readonly mtimeMs: number;
	readonly digest: string;
	/** 2 for chained WALs (per-line hashes); 1 for legacy stat/sample-bound WALs
	 * that must be compacted before the next append. */
	readonly version: 1 | 2;
	/** Byte length of the last line's JSON text; present for chained v2 WALs. */
	readonly lastLineLength?: number;
	/** Whether the WAL header binds the base CONTENT digest. Older v2 headers
	 * predate the digest field; they remain replayable (stat/generation-bound)
	 * but must be upgraded before the next append. */
	readonly digestBound?: boolean;
};
export const AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES = 64 * 1024 * 1024;

export class SessionAuthorityDurabilityError extends Error {
	constructor(filePath: string, cause: unknown) {
		super(`Session authority durability is uncertain after replacing ${filePath}.`, { cause });
		this.name = "SessionAuthorityDurabilityError";
	}
}

export class FileSessionAuthority extends SessionAuthority {
	#baseIdentity: BaseIdentity | undefined = undefined;
	#walIdentity: WalIdentity | undefined = undefined;
	/** Set when the loaded base document is already in the normalized form this
	 * instance writes (a `normalized: true` marker persisted at compaction): an
	 * oversized base that cannot shrink below the threshold must not be
	 * rewritten again on every boot. */
	#normalized = false;
	protected walCompactionThresholdBytes = WAL_COMPACTION_THRESHOLD_BYTES;
	/**
	 * Base-class-owned so a subclass capture written during the constructor
	 * survives field initialization (subclass fields run after `super()`).
	 */
	protected bootCompactionBeforeBytes: number | undefined = undefined;

	/** When the caller already holds the authority mutation lock (which is not
	 * reentrant), pass it in so the boot-time replay/compaction stays inside the
	 * caller's critical section instead of deadlocking on a second acquire. */
	constructor(
		private readonly filePath: string,
		lock?: ReturnType<typeof AuthorityMutationLock.acquire>,
	) {
		super();
		const held = lock ?? AuthorityMutationLock.acquire(this.filePath);
		try {
			if (!existsSync(this.filePath)) {
				this.#baseIdentity = undefined;
				this.#walIdentity = undefined;
				this.dropWalFile();
				return;
			}
			this.load();
			// Capture the ORIGINAL base size before any recovery compaction below:
			// a pending operation, trailing WAL garbage, or an oversized WAL can
			// shrink the file, and the oversized decision and its health diagnostic
			// must still reflect the pre-compaction document.
			const originalBaseBytes = statIdentity(this.filePath)?.size ?? 0;
			let trailingGarbage = false;
			if (existsSync(this.walPath)) trailingGarbage = this.replayWal().trailingGarbage;
			const pendingOperations = this.hasPendingOperations();
			if (trailingGarbage || this.walOversized() || pendingOperations) {
				if (pendingOperations) super.reconcileRestart();
				this.persist();
			}
			if (originalBaseBytes > AUTHORITY_BOOT_COMPACTION_THRESHOLD_BYTES) {
				if (!this.#normalized) {
					// No persist has happened during this boot yet: perform the
					// reference-based compaction (normalization drops legacy result
					// event arrays by reference, no deep copy, and the live journal
					// is replaced with the normalized records). The persisted
					// `normalized` marker prevents re-running this on every boot.
					this.compactFromReferences();
				}
				// Report the compaction whenever startup rewrote an oversized
				// document: either compactFromReferences just rewrote it, or the
				// recovery persist already normalized it (marker set above).
				this.recordBootCompaction(originalBaseBytes);
			}
		} finally {
			if (lock === undefined) held.release();
		}
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
	override reserveProvisionalOperation(
		operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">,
	): ProvisionalSessionOperation {
		return this.mutate(() => super.reserveProvisionalOperation(operation));
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
		attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">,
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
	protected mutate<T>(mutation: () => T): T {
		const lock = AuthorityMutationLock.acquire(this.filePath);
		try {
			this.verifyAgainstDisk();
			// Shallow rollback snapshot: the journal stores new record/provisional
			// objects on every mutation (copy-on-write), so the pre-mutation values
			// stay intact by reference without deep-copying the whole authority
			// document on every mutation (the O(total-size) allocation that the
			// incremental persistence is meant to remove).
			const rollback = this.snapshotJournalForRollback();
			let result: T;
			try {
				result = mutation();
			} catch (error) {
				if (error instanceof SessionAuthorityDurabilityError) throw error;
				this.restoreRollbackSnapshot(rollback);
				throw error;
			}
			if (this.journalNeedsCompaction()) {
				try {
					this.persist();
				} catch (error) {
					if (error instanceof SessionAuthorityDurabilityError) throw error;
					this.restoreRollbackSnapshot(rollback);
					throw error;
				}
			} else if (this.hasDirtyJournal()) {
				const dirtyRecords = this.takeDirtyRecords();
				const dirtyProvisional = this.takeDirtyProvisional();
				if (!existsSync(this.filePath)) {
					try {
						this.persist();
					} catch (error) {
						if (error instanceof SessionAuthorityDurabilityError) throw error;
						this.restoreRollbackSnapshot(rollback);
						throw error;
					}
				} else {
					try {
						this.appendWal(dirtyRecords, dirtyProvisional);
					} catch (error) {
						if (error instanceof SessionAuthorityDurabilityError) throw error;
						this.restoreRollbackSnapshot(rollback);
						throw error;
					}
					if (this.walOversized()) {
						try {
							this.persist();
						} catch (error) {
							if (error instanceof SessionAuthorityDurabilityError) throw error;
							// The mutation was already appended and fsynced to the WAL, so it is
							// durable; reload the WAL-visible state and surface uncertain
							// durability instead of rolling back to a snapshot that boot will
							// not reproduce (a retry could then conflict or duplicate).
							this.reloadDurableState();
							throw new SessionAuthorityDurabilityError(this.filePath, error);
						}
					}
				}
			}
			return result;
		} finally {
			lock.release();
		}
	}
	/** Exposed for relocation/migration: replays a valid WAL beside the base and
	 * rewrites the base with the complete acknowledged state (fresh generation,
	 * WAL truncated), so a subsequent copy of the base file carries every
	 * WAL-committed mutation instead of losing it. When the caller already holds
	 * the source authority mutation lock (which is not reentrant), pass it in so
	 * the compaction and the caller's snapshot read stay inside the same
	 * critical section. */
	public compactForRelocation(lock?: ReturnType<typeof AuthorityMutationLock.acquire>): void {
		const held = lock ?? AuthorityMutationLock.acquire(this.filePath);
		try {
			this.verifyAgainstDisk();
			this.persist();
		} finally {
			if (lock === undefined) held.release();
		}
	}
	/** Restores the pre-mutation state from a shallow reference snapshot and
	 * clears the dirty markers, so a failed (non-durable) mutation leaves memory
	 * exactly as it was at mutation entry. */
	private restoreRollbackSnapshot(rollback: {
		readonly records: ReadonlyMap<string, SessionAuthorityRecord>;
		readonly provisional: ReadonlyMap<string, ProvisionalSessionOperation>;
	}): void {
		this.replaceAllWithReferences([...rollback.records.values()], [...rollback.provisional.values()]);
		this.clearDirtyJournal();
	}
	private verifyAgainstDisk(): void {
		const baseStat = statIdentity(this.filePath);
		const walStat = statIdentity(this.walPath);
		if (
			sameStatIdentity(baseStat, this.#baseIdentity) &&
			sameStatIdentity(walStat, this.#walIdentity) &&
			this.baseGenerationMatchesDisk() &&
			this.walDigestMatchesDisk()
		)
			return;
		this.load();
		if (walStat !== undefined) {
			// A changed WAL (stat or content detection) is re-verified in full by
			// replayWal, which fails closed on a broken chain link.
			const replayed = this.replayWal();
			// Mirror the constructor: when the replayed WAL ends in a partial
			// (crash-truncated) line, compact the valid prefix immediately, so the
			// next mutation is not appended past garbage that the next boot would
			// stop replaying at (which would silently drop the acknowledged
			// mutation).
			if (replayed.trailingGarbage) {
				if (this.hasPendingOperations()) this.reconcileRestart();
				this.persist();
			}
		} else this.#walIdentity = undefined;
	}
	/** The live verification path must also confirm the collision-resistant base
	 * generation, not only size/mtime: a timestamp-preserving same-size external
	 * replacement while this instance is running would otherwise keep appending
	 * under the stale generation and the WAL would be rejected (and the
	 * acknowledged mutation silently lost) at the next boot. The generation's
	 * byte offset and serialized length are cached at load/persist time, so the
	 * per-mutation read is a window sized for the cached value instead of a
	 * fixed-size prefix that a long value would truncate. */
	private baseGenerationMatchesDisk(): boolean {
		const base = this.#baseIdentity;
		if (base === undefined) return true;
		// A known generation with no cached byte offset cannot be verified: treat
		// it as a mismatch (fail closed) so a same-stat replacement cannot slip
		// through, and the next append upgrades the document to the standard
		// layout that carries a deterministic offset.
		if (base.generation === undefined) return true;
		if (base.generationOffset === undefined || base.generationSpanLength === undefined) return false;
		return (
			readGenerationAtOffset(this.filePath, base.generationOffset, base.generationSpanLength) === base.generation
		);
	}
	/** Binds the cached WAL state to a collision-resistant identity that
	 * authenticates the on-disk prefix before every acknowledged append: every
	 * chained link is verified from the bytes (each line's head commits its own
	 * body and links to the previous head), so an interior same-size same-mtime
	 * delta replacement or corruption is detected live and fails closed. The
	 * WAL is bounded by the compaction threshold, so this is O(WAL), not
	 * O(base). */
	private walDigestMatchesDisk(): boolean {
		const wal = this.#walIdentity;
		if (wal === undefined) return true;
		if (wal.version === WAL_VERSION) {
			const verified = this.verifyWalChainOnDisk();
			return verified !== undefined && verified.digest === wal.digest;
		}
		return walSampleDigestFromFile(this.walPath) === wal.digest;
	}
	/** Streams the WAL and verifies every chained link against the on-disk
	 * bytes (header + deltas): each line's prevHash must equal the previous
	 * head and its body must recompute its embedded head. Returns the final
	 * head, or undefined when any link is broken, unreadable, or the tail is
	 * torn. */
	private verifyWalChainOnDisk(): { readonly digest: string } | undefined {
		let contents: string;
		try {
			contents = readFileSync(this.walPath, "utf8");
		} catch {
			return undefined;
		}
		const parts = contents.split("\n");
		const hasTrailingNewline = parts.length > 0 && parts[parts.length - 1] === "";
		if (!hasTrailingNewline) return undefined;
		const lines = parts.filter(line => line.length > 0);
		if (lines.length === 0) return undefined;
		let header: unknown;
		try {
			header = JSON.parse(lines[0]!);
		} catch {
			return undefined;
		}
		if (!isWalHeader(header, this.#baseIdentity) || (header as Record<string, unknown>).version !== WAL_VERSION)
			return undefined;
		let expectedHead = lineChainHash(WAL_CHAIN_SEED, lines[0]!);
		for (let index = 1; index < lines.length; index += 1) {
			const line = lines[index]!;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return undefined;
			}
			if (!isWalDelta(parsed)) return undefined;
			const record = parsed as Record<string, unknown>;
			if (
				!isNonEmptyString(record.prevHash) ||
				record.prevHash !== expectedHead ||
				lineChainHash(record.prevHash, walDeltaBodyJson(record)) !== record.head
			)
				return undefined;
			expectedHead = record.head as string;
		}
		return { digest: expectedHead };
	}
	protected load(): void {
		if (!existsSync(this.filePath)) {
			this.#baseIdentity = undefined;
			this.clearDirtyJournal();
			return;
		}
		let document: unknown;
		let rawDocument = "";
		try {
			rawDocument = readFileSync(this.filePath, "utf8");
			document = JSON.parse(rawDocument);
		} catch (error) {
			throw new SessionAuthorityLoadError(this.filePath, "authority JSON is unreadable", error);
		}
		if (isLegacyMappingDocument(document)) {
			this.quarantineLegacyDocument();
			this.replaceAllWithReferences([]);
			this.#baseIdentity = statIdentity(this.filePath);
			this.clearDirtyJournal();
			return;
		}
		if (
			!isAuthorityDocument(document) ||
			!isAuthorityDocumentRelationallyValid(document.mappings, document.provisionalOperations ?? [])
		)
			throw new SessionAuthorityLoadError(this.filePath, "authority document is not a valid v2 authority");
		this.replaceAllWithReferences(document.mappings, document.provisionalOperations ?? []);
		this.#normalized = (document as Record<string, unknown>).normalized === true;
		const stat = statIdentity(this.filePath);
		this.#baseIdentity =
			stat === undefined
				? undefined
				: {
						...stat,
						digest: createHash("sha256").update(rawDocument).digest("hex"),
						...(typeof document.generation === "string"
							? generationSpanFromDocument(rawDocument, document.generation)
							: {}),
					};
		this.clearDirtyJournal();
	}
	/**
	 * Captures a one-time normalizing boot compaction of an oversized base
	 * document. Subclasses may override to observe the before-bytes; the base
	 * implementation records it for `bootCompactionBeforeBytes`.
	 */
	protected recordBootCompaction(beforeBytes: number): void {
		this.bootCompactionBeforeBytes = beforeBytes;
	}
	protected persist(): void {
		const mappings = this.entries();
		const provisionalOperations = this.provisionalEntries();
		if (
			!mappings.every(isV2Record) ||
			!provisionalOperations.every(isProvisionalOperation) ||
			!isAuthorityDocumentRelationallyValid(mappings, provisionalOperations)
		)
			throw new Error("Refusing to persist an invalid v2 session authority.");
		// The rewritten base must also become the in-memory state: a legacy
		// record whose result event arrays were stripped only on disk would
		// otherwise re-introduce them through the next WAL delta, so every
		// subsequent mutation would append a large delta and immediately
		// re-compact.
		const normalizedMappings = mappings.map(normalizeRecordForPersistence);
		const normalizedProvisional = provisionalOperations.map(normalizeProvisionalForPersistence);
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		const descriptor = openSync(temporary, "wx", 0o600);
		// A fresh generation on every rewrite makes WAL applicability
		// collision-resistant: a timestamp-preserving external replacement of the
		// base can never replay stale deltas against it.
		const nextGeneration = randomUUID();
		const writtenDocument = `${JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: SESSION_AUTHORITY_VERSION,
			generation: nextGeneration,
			normalized: true,
			mappings: normalizedMappings,
			provisionalOperations: normalizedProvisional,
		})}\n`;
		try {
			writeFileSync(descriptor, writtenDocument, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, this.filePath);
		try {
			this.syncDirectory();
		} catch (error) {
			this.#walIdentity = undefined;
			try {
				this.load();
			} catch (loadError) {
				// The base may already contain the mutation; a failed reload must
				// still surface uncertain durability so callers cannot treat this
				// as a clean rollback and retry.
				throw new SessionAuthorityDurabilityError(
					this.filePath,
					new AggregateError([error, loadError], "authority reload failed after the base replacement"),
				);
			}
			// Keep the WAL: the base rename's directory sync failed, so the
			// replacement is not known durable. If a crash then loses the rename
			// while an unlink reached storage, startup would see the old base
			// without its WAL-only acknowledged mutations. The WAL's generation
			// binding makes it stale (and harmless) if the new base survives.
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		try {
			this.resetWalFile();
		} catch (error) {
			// The base was renamed and directory-synced before this point, so the
			// mutation is committed; reload the visible state and surface uncertain
			// durability instead of letting mutate() restore a pre-mutation snapshot
			// (a retry could then conflict with or duplicate the committed write).
			this.#walIdentity = undefined;
			try {
				this.load();
			} catch (loadError) {
				throw new SessionAuthorityDurabilityError(
					this.filePath,
					new AggregateError([error, loadError], "authority reload failed after the WAL reset"),
				);
			}
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		// The normalized records become the live journal state so subsequent WAL
		// deltas stay compact (no stripped event arrays are re-introduced).
		this.replaceAllWithReferences(normalizedMappings, normalizedProvisional);
		try {
			this.refreshBaseIdentity(nextGeneration, createHash("sha256").update(writtenDocument).digest("hex"));
		} catch (error) {
			// The base was renamed, directory-synced, and the WAL removed before
			// this point, so the mutation is committed; a failed base stat refresh
			// must surface uncertain durability instead of letting mutate() restore
			// a pre-mutation snapshot that a retry could duplicate.
			try {
				this.load();
			} catch (loadError) {
				throw new SessionAuthorityDurabilityError(
					this.filePath,
					new AggregateError([error, loadError], "authority reload failed after the base replacement"),
				);
			}
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		// The persisted document is always the normalized form, so the in-memory
		// marker must be set here too: when the recovery branch persisted first
		// (pending/garbage/oversized-WAL) and the base is still oversized, the
		// subsequent boot-compaction condition must not rewrite it a second time.
		this.#normalized = true;
		this.clearDirtyJournal();
	}
	/** Boot-only compaction from the internal reference view: no deep copy of
	 * every record/event payload happens (the legacy result events are dropped
	 * by reference during normalization), the compact base is written with the
	 * `normalized` marker, and the live journal is replaced with the normalized
	 * records so the oversized legacy state does not stay resident. */
	private compactFromReferences(): void {
		const raw = this.rawJournalEntries();
		const mappings = [...raw.records.values()];
		const provisionalOperations = [...raw.provisional.values()];
		if (
			!mappings.every(isV2Record) ||
			!provisionalOperations.every(isProvisionalOperation) ||
			!isAuthorityDocumentRelationallyValid(mappings, provisionalOperations)
		)
			throw new Error("Refusing to persist an invalid v2 session authority.");
		const normalizedMappings = mappings.map(normalizeRecordForPersistence);
		const normalizedProvisional = provisionalOperations.map(normalizeProvisionalForPersistence);
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		const descriptor = openSync(temporary, "wx", 0o600);
		const nextGeneration = randomUUID();
		const writtenDocument = `${JSON.stringify({
			kind: "openwebui-gjc-session-authority",
			version: SESSION_AUTHORITY_VERSION,
			generation: nextGeneration,
			normalized: true,
			mappings: normalizedMappings,
			provisionalOperations: normalizedProvisional,
		})}\n`;
		try {
			writeFileSync(descriptor, writtenDocument, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, this.filePath);
		try {
			this.syncDirectory();
		} catch (error) {
			this.#walIdentity = undefined;
			try {
				this.load();
			} catch (loadError) {
				throw new SessionAuthorityDurabilityError(
					this.filePath,
					new AggregateError([error, loadError], "authority reload failed after the base replacement"),
				);
			}
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		try {
			this.resetWalFile();
		} catch (error) {
			this.#walIdentity = undefined;
			try {
				this.load();
			} catch (loadError) {
				throw new SessionAuthorityDurabilityError(
					this.filePath,
					new AggregateError([error, loadError], "authority reload failed after the WAL reset"),
				);
			}
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		// The normalized records become the live journal state so the oversized
		// legacy events are not retained in memory and later WAL deltas stay
		// compact.
		this.replaceAllWithReferences(normalizedMappings, normalizedProvisional);
		try {
			this.refreshBaseIdentity(nextGeneration, createHash("sha256").update(writtenDocument).digest("hex"));
		} catch (error) {
			try {
				this.load();
			} catch (loadError) {
				throw new SessionAuthorityDurabilityError(
					this.filePath,
					new AggregateError([error, loadError], "authority reload failed after the base replacement"),
				);
			}
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		this.#normalized = true;
		this.clearDirtyJournal();
	}
	/** Refreshes the cached base identity (stat + generation) after a rewrite;
	 * separated so the post-commit failure handling can guard it. The generation
	 * offset is deterministic for documents this instance writes (the compact
	 * single-line layout always places the generation key at the same byte). */
	protected refreshBaseIdentity(nextGeneration: string, digest: string): void {
		this.#baseIdentity = {
			...statIdentity(this.filePath)!,
			digest,
			generation: nextGeneration,
			generationOffset: GENERATION_KEY_OFFSET,
			generationSpanLength: Buffer.byteLength(`"generation":"${nextGeneration}"`, "utf8"),
		};
	}
	protected syncDirectory(): void {
		const directory = openSync(dirname(this.filePath), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	}
	private replayWal(): { readonly trailingGarbage: boolean } {
		const walPath = this.walPath;
		let contents: string;
		try {
			contents = readFileSync(walPath, "utf8");
		} catch (error) {
			throw new SessionAuthorityLoadError(this.filePath, "authority WAL is unreadable", error);
		}
		const parts = contents.split("\n");
		const hasTrailingNewline = parts.length > 0 && parts[parts.length - 1] === "";
		let lines = parts.filter(line => line.length > 0);
		let trailingGarbage = false;
		if (!hasTrailingNewline && lines.length > 0) {
			// An unterminated final line is a torn write even when its prefix
			// happens to parse as a valid delta: treat it as uncommitted and
			// recover the valid prefix instead of letting the next append write a
			// second JSON object directly after it (which would corrupt the file).
			trailingGarbage = true;
			lines = lines.slice(0, -1);
		}
		if (lines.length === 0) {
			this.dropWalFile();
			return { trailingGarbage };
		}
		let header: unknown;
		try {
			header = JSON.parse(lines[0]!);
		} catch {
			// A header that cannot even be parsed is corruption, not a stale WAL:
			// deleting the file would discard the acknowledged deltas that follow.
			throw new SessionAuthorityLoadError(this.filePath, "authority WAL header is malformed");
		}
		if (!isWalHeaderShape(header))
			throw new SessionAuthorityLoadError(this.filePath, "authority WAL header is malformed");
		if (!isWalHeaderBoundToBase(header, this.#baseIdentity)) {
			// A syntactically valid header demonstrably bound to a DIFFERENT base
			// is a stale WAL (an external base edit wins); only then is deletion
			// safe.
			this.dropWalFile();
			return { trailingGarbage: false };
		}
		const chained = (header as Record<string, unknown>).version === WAL_VERSION;
		// Older v2 headers predate the base digest field; they stay replayable
		// but must be upgraded (digest-bound) before the next append.
		const digestBound = isNonEmptyString(
			((header as Record<string, unknown>).base as Record<string, unknown> | undefined)?.digest,
		);
		// For chained v2 WALs every line carries its own chained head, which
		// commits to the ENTIRE prefix, and its prevHash must equal the previous
		// line's head. A replaced interior delta therefore breaks the chain and
		// fails closed at boot instead of silently changing acknowledged state.
		let expectedHead = chained ? lineChainHash(WAL_CHAIN_SEED, lines[0]!) : "";
		let lastLineLength = 0;
		const raw = this.rawJournalEntries();
		const records = new Map(raw.records);
		const provisional = new Map(raw.provisional);
		const deltaLines = lines.slice(1);
		for (let index = 0; index < deltaLines.length; index += 1) {
			const line = deltaLines[index]!;
			let delta: unknown;
			try {
				delta = JSON.parse(line);
			} catch {
				delta = undefined;
			}
			if (delta === undefined || !isWalDelta(delta))
				throw new SessionAuthorityLoadError(this.filePath, "authority WAL is corrupt before its final line");
			const deltaRecord = delta as Record<string, unknown>;
			if (
				chained &&
				(!isNonEmptyString(deltaRecord.prevHash) ||
					deltaRecord.prevHash !== expectedHead ||
					lineChainHash(deltaRecord.prevHash, walDeltaBodyJson(deltaRecord)) !== deltaRecord.head)
			)
				throw new SessionAuthorityLoadError(this.filePath, "authority WAL chain is broken before its final line");
			expectedHead = chained ? (deltaRecord.head as string) : "";
			lastLineLength = Buffer.byteLength(line, "utf8");
			for (const record of delta.records) records.set(record.chatId, record);
			for (const item of delta.provisional) provisional.set(item.key, item.operation);
		}
		this.replaceAllWithReferences([...records.values()], [...provisional.values()]);
		this.#walIdentity = chained
			? {
					...statIdentity(walPath)!,
					digest: expectedHead,
					lastLineLength,
					version: WAL_VERSION,
					...(this.#baseIdentity?.digest === undefined ? {} : { digestBound }),
				}
			: { ...statIdentity(walPath)!, digest: walSampleDigestFromContents(contents), version: WAL_LEGACY_VERSION };
		this.clearDirtyJournal();
		return { trailingGarbage };
	}
	protected appendWal(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
	): void {
		if (this.#walIdentity !== undefined && this.#walIdentity.version === WAL_LEGACY_VERSION) {
			// A legacy v1 WAL was replayed (e.g. at startup) and still carries a
			// bounded sample identity; compact it into the base before the first
			// v2 append so the WAL becomes chain-covered from its first line
			// instead of remaining sample-bound until the compaction threshold.
			this.persist();
			return;
		}
		if (
			this.#walIdentity !== undefined &&
			this.#baseIdentity?.digest !== undefined &&
			this.#walIdentity.digestBound === false
		) {
			// An older chained WAL whose header predates the base digest field is
			// replayable but not content-bound; upgrade it (compact into the base,
			// reset the WAL) before the first append so the new header binds the
			// base digest.
			this.persist();
			return;
		}
		const walPath = this.walPath;
		let created = false;
		if (this.#walIdentity === undefined) {
			const adopted = this.adoptExistingWal(walPath);
			if (adopted === "legacy") {
				// A legacy v1 WAL (no chained line hashes) is compacted into the
				// base before the first v2 append, so every WAL this instance writes
				// is chain-covered from its first line.
				this.persist();
				return;
			}
			if (adopted === "chained") {
				// adopted: identity (stat + chain digest) seeded
			} else {
				if (existsSync(walPath)) unlinkSync(walPath);
				created = true;
			}
		}
		// A generation PRESENT but with no serialized offset (e.g. an escaped JSON
		// key) cannot be verified per-mutation; upgrade it to the standard layout
		// regardless of whether the WAL was adopted or newly created, so a replayed
		// existing WAL cannot leave the base stuck reloading on every turn.
		if (this.#baseIdentity?.generation !== undefined && this.#baseIdentity.generationOffset === undefined) {
			this.persist();
			return;
		}
		if (created && this.#baseIdentity?.generation === undefined) {
			// A generation-less base (pre-upgrade v2 documents, or migration
			// output) must be rewritten with a fresh generation in the standard
			// layout BEFORE the first WAL append: otherwise the WAL would be bound
			// by stat only and a timestamp-preserving restore could replay stale
			// deltas over the replacement. Persisting writes the full current state
			// (including this mutation) with a deterministic generation offset, so
			// the append is never made under a weak identity.
			this.persist();
			return;
		}
		const previousStat = this.#walIdentity;
		let descriptor: number;
		let writtenDigest: string | undefined;
		let writtenLastLineLength = 0;
		try {
			descriptor = openSync(walPath, "a", 0o600);
			try {
				let prevHash = WAL_CHAIN_SEED;
				if (created) {
					const headerJson = JSON.stringify(walHeader(this.#baseIdentity));
					writeFileSync(descriptor, `${headerJson}\n`, "utf8");
					prevHash = lineChainHash(WAL_CHAIN_SEED, headerJson);
				} else {
					prevHash = this.#walIdentity!.digest;
				}
				const delta = walDelta(records, provisional, prevHash);
				const deltaJson = JSON.stringify(delta);
				writeFileSync(descriptor, `${deltaJson}\n`, "utf8");
				writtenDigest = delta.head;
				writtenLastLineLength = Buffer.byteLength(deltaJson, "utf8");
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
		} catch (error) {
			this.recoverFailedWalAppend(previousStat);
			throw error;
		}
		if (created) {
			try {
				this.syncDirectory();
			} catch (error) {
				try {
					this.refreshWalIdentity(writtenDigest!, writtenLastLineLength);
				} catch (identityError) {
					this.#walIdentity = undefined;
					this.reloadDurableState();
					throw new SessionAuthorityDurabilityError(this.filePath, identityError);
				}
				throw new SessionAuthorityDurabilityError(this.filePath, error);
			}
		}
		try {
			this.refreshWalIdentity(writtenDigest!, writtenLastLineLength);
		} catch (error) {
			// The delta was already written and fsynced; a failure to refresh the
			// cached identity must not escape as an ordinary append failure (mutate
			// would then restore the pre-mutation snapshot while a restart replays
			// the committed delta, and the caller could retry the operation).
			this.#walIdentity = undefined;
			this.reloadDurableState();
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
	}
	/** Refreshes the cached WAL identity (stat + chained digest) after a write;
	 * the digest covers every line through the chained hashes, computed
	 * incrementally from the exact bytes this instance wrote. */
	protected refreshWalIdentity(writtenDigest: string, lastLineLength: number): void {
		const stat = statIdentity(this.walPath);
		if (stat === undefined) throw new Error("WAL stat cannot be refreshed after a write");
		this.#walIdentity = {
			...stat,
			digest: writtenDigest,
			lastLineLength,
			version: WAL_VERSION,
			...(this.#baseIdentity?.digest === undefined ? {} : { digestBound: true }),
		};
	}
	/** Reads an existing WAL, validates its header against the current base, and
	 * adopts it: "chained" seeds the identity by verifying every v2 chain link;
	 * "legacy" signals a v1 WAL that must be compacted before the next append;
	 * false means unreadable/invalid (the caller recreates the WAL). */
	private adoptExistingWal(walPath: string): "chained" | "legacy" | false {
		let contents: string;
		try {
			contents = readFileSync(walPath, "utf8");
		} catch {
			return false;
		}
		const parts = contents.split("\n");
		const hasTrailingNewline = parts.length > 0 && parts[parts.length - 1] === "";
		const lines = parts.filter(line => line.length > 0);
		const firstLine = lines[0];
		if (firstLine === undefined) return false;
		let header: unknown;
		try {
			header = JSON.parse(firstLine);
		} catch {
			throw new SessionAuthorityLoadError(this.filePath, "authority WAL header is malformed");
		}
		if (!isWalHeaderShape(header))
			throw new SessionAuthorityLoadError(this.filePath, "authority WAL header is malformed");
		if (!isWalHeaderBoundToBase(header, this.#baseIdentity)) return false;
		if ((header as Record<string, unknown>).version !== WAL_VERSION) return "legacy";
		const digestBound = isNonEmptyString(
			((header as Record<string, unknown>).base as Record<string, unknown> | undefined)?.digest,
		);
		// Verify the full chained prefix and seed the identity from the last
		// line's head.
		let expectedHead = lineChainHash(WAL_CHAIN_SEED, firstLine);
		let digest: string | undefined;
		let lastLineLength = 0;
		for (let index = 1; index < lines.length; index += 1) {
			const line = lines[index]!;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				if (index === lines.length - 1 && !hasTrailingNewline) return false;
				return false;
			}
			if (!isWalDelta(parsed)) return false;
			const record = parsed as Record<string, unknown>;
			if (
				!isNonEmptyString(record.prevHash) ||
				record.prevHash !== expectedHead ||
				lineChainHash(record.prevHash, walDeltaBodyJson(record)) !== record.head
			)
				return false;
			expectedHead = record.head as string;
			digest = expectedHead;
			lastLineLength = Buffer.byteLength(line, "utf8");
		}
		if (digest === undefined) return false;
		this.#walIdentity = {
			...statIdentity(walPath)!,
			digest,
			lastLineLength,
			version: WAL_VERSION,
			...(this.#baseIdentity?.digest === undefined ? {} : { digestBound }),
		};
		return "chained";
	}
	/** Reloads memory from the durable base and WAL so in-memory state matches
	 * what boot will replay; used when a durability failure leaves the committed
	 * state uncertain. A reload failure is itself a durability error so the
	 * caller can never mistake it for a clean rollback. */
	private reloadDurableState(): void {
		try {
			this.load();
			if (existsSync(this.walPath)) this.replayWal();
			else this.#walIdentity = undefined;
		} catch (error) {
			this.#walIdentity = undefined;
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
	}
	protected recoverFailedWalAppend(previousStat: WalIdentity | undefined): void {
		const walPath = this.walPath;
		if (previousStat === undefined) {
			try {
				if (existsSync(walPath)) unlinkSync(walPath);
			} catch (error) {
				// The WAL may hold a complete replayable delta; reload the WAL-visible
				// state and surface uncertain durability so callers do not retry an
				// operation that boot will consider committed.
				this.#walIdentity = undefined;
				this.reloadDurableState();
				throw new SessionAuthorityDurabilityError(this.filePath, error);
			}
			try {
				// The directory entry removal must be durable before the rollback is
				// reported: a crash before this sync could resurrect the deleted WAL
				// and replay a delta whose caller received an ordinary failure.
				this.syncDirectory();
			} catch (error) {
				this.#walIdentity = undefined;
				this.reloadDurableState();
				throw new SessionAuthorityDurabilityError(this.filePath, error);
			}
			this.#walIdentity = undefined;
			return;
		}
		try {
			if (!existsSync(walPath)) {
				this.#walIdentity = undefined;
				return;
			}
			const descriptor = openSync(walPath, "r+");
			try {
				ftruncateSync(descriptor, previousStat.size);
				// The truncation must be durable BEFORE the rollback is reported: a
				// crash after an fsynced append but before this fsync could otherwise
				// preserve the complete delta and replay an operation whose caller
				// received an ordinary failure and retried.
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			// The truncated file's last line is exactly the pre-append line, so the
			// pre-append identity (chain digest included) is valid without a re-read.
			this.#walIdentity = previousStat;
		} catch (error) {
			// A complete delta may remain replayable despite the reported append
			// error; reload the WAL-visible state and surface uncertain durability.
			this.#walIdentity = undefined;
			this.reloadDurableState();
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
	}
	private dropWalFile(): void {
		const walPath = this.walPath;
		if (existsSync(walPath)) unlinkSync(walPath);
		this.#walIdentity = undefined;
	}
	private resetWalFile(): void {
		this.dropWalFile();
		this.syncDirectory();
	}
	private walOversized(): boolean {
		return this.#walIdentity !== undefined && this.#walIdentity.size > this.walCompactionThresholdBytes;
	}
	private hasPendingOperations(): boolean {
		// Inspect through the internal reference view: entries() deep-copies every
		// record and event payload, and this check runs BEFORE the oversized boot
		// compaction — a 1 GiB-class document must not allocate a second
		// document-sized object just to look for pending operations.
		const raw = this.rawJournalEntries();
		return (
			[...raw.records.values()].some(
				record =>
					record.reassignment?.state === "pending" ||
					record.journal.some(operation => operation.state === "pending"),
			) || [...raw.provisional.values()].some(operation => operation.state === "pending")
		);
	}
	private get walPath(): string {
		return `${this.filePath}.wal`;
	}
	private quarantineLegacyDocument(): void {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const quarantine = `${this.filePath}.legacy-${Date.now()}-${process.pid}-${attempt}`;
			try {
				copyFileSync(this.filePath, quarantine, constants.COPYFILE_EXCL);
				const descriptor = openSync(quarantine, "r");
				try {
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				unlinkSync(this.filePath);
				return;
			} catch (error) {
				if (isAlreadyExists(error)) continue;
				throw error;
			}
		}
		throw new SessionAuthorityLoadError(
			this.filePath,
			"cannot allocate a collision-safe legacy authority quarantine path",
		);
	}
}

const WAL_SAMPLE_BYTES = 8 * 1024;
/** Bounded head+tail content sample of a legacy v1 WAL (byte-consistent with
 * the file-based reader so non-ASCII content cannot diverge the digests). */
function walSampleDigestFromContents(contents: string): string {
	const bytes = Buffer.from(contents, "utf8");
	const hash = createHash("sha256");
	hash.update(String(bytes.length));
	hash.update(bytes.subarray(0, WAL_SAMPLE_BYTES));
	if (bytes.length > WAL_SAMPLE_BYTES) hash.update(bytes.subarray(bytes.length - WAL_SAMPLE_BYTES));
	return hash.digest("hex");
}
function walSampleDigestFromFile(path: string): string | undefined {
	let stat: { readonly size: number };
	try {
		stat = statSync(path);
	} catch {
		return undefined;
	}
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const hash = createHash("sha256");
		hash.update(String(stat.size));
		const head = Buffer.alloc(WAL_SAMPLE_BYTES);
		const headBytes = readSync(descriptor, head, 0, head.length, 0);
		hash.update(head.subarray(0, Math.max(0, headBytes)));
		if (stat.size > WAL_SAMPLE_BYTES) {
			const tail = Buffer.alloc(WAL_SAMPLE_BYTES);
			const tailBytes = readSync(descriptor, tail, 0, tail.length, stat.size - WAL_SAMPLE_BYTES);
			hash.update(tail.subarray(0, Math.max(0, tailBytes)));
		}
		return hash.digest("hex");
	} finally {
		closeSync(descriptor);
	}
}
function statIdentity(path: string): { readonly size: number; readonly mtimeMs: number } | undefined {
	if (!existsSync(path)) return undefined;
	const stat = statSync(path);
	return { size: stat.size, mtimeMs: stat.mtimeMs };
}
/** Compacts an authority in place (replays a valid WAL into the base, then
 * rewrites it with a fresh generation and truncates the WAL), so relocation or
 * migration can copy the base file without losing WAL-committed mutations.
 * When the caller already holds the source authority mutation lock, pass it in
 * so the compaction and the snapshot read stay inside the same critical
 * section (the lock is not reentrant). */
export function compactAuthorityForRelocation(
	filePath: string,
	lock?: ReturnType<typeof AuthorityMutationLock.acquire>,
): void {
	new FileSessionAuthority(filePath, lock).compactForRelocation(lock);
}
/** Inspects whether the WAL beside a base is applicable to it: "current" when
 * its header is syntactically valid, demonstrably bound to the current base,
 * AND it contains at least one fully replayable delta; "stale" when the
 * header is valid but bound to a DIFFERENT base or carries no complete delta
 * (no applicable mutations, so ignoring it cannot lose acknowledged state);
 * "malformed" when the header cannot be parsed, is structurally invalid, or
 * the WAL is unreadable (fail closed so a migration never silently omits
 * WAL-only mutations); and "none" when no WAL exists. Used by the migration
 * layer so a stale WAL left by a crash after compaction cannot force a
 * pointless source rewrite. */
export function walBindingForBase(walPath: string, basePath: string): "none" | "current" | "stale" | "malformed" {
	if (!existsSync(walPath)) return "none";
	let contents: string;
	try {
		contents = readFileSync(walPath, "utf8");
	} catch {
		// An unreadable WAL is not "absent": failing closed (malformed) prevents
		// a migration from copying only the base and omitting WAL-only
		// acknowledged mutations.
		return "malformed";
	}
	const lines = contents.split("\n").filter(line => line.length > 0);
	const firstLine = lines[0];
	if (firstLine === undefined || firstLine.length === 0) return "malformed";
	let header: unknown;
	try {
		header = JSON.parse(firstLine);
	} catch {
		return "malformed";
	}
	if (!isWalHeaderShape(header)) return "malformed";
	const stat = statIdentity(basePath);
	if (stat === undefined) return "stale";
	let generation: string | undefined;
	let digest: string | undefined;
	try {
		const raw = readFileSync(basePath, "utf8");
		const document: unknown = JSON.parse(raw);
		digest = createHash("sha256").update(raw).digest("hex");
		if (isAuthorityDocument(document) && typeof (document as Record<string, unknown>).generation === "string")
			generation = (document as Record<string, unknown>).generation as string;
	} catch {
		generation = undefined;
		digest = undefined;
	}
	const identity: BaseIdentity = {
		...stat,
		...(digest === undefined ? {} : { digest }),
		...(generation === undefined ? {} : { generation }),
	};
	if (!isWalHeaderBoundToBase(header, identity)) return "stale";
	// A CURRENT WAL must contain at least one fully replayable delta. Only a
	// genuinely header-only WAL (no delta lines) or an unterminated torn tail is
	// safe to ignore; a malformed newline-terminated delta is corruption that
	// replay would reject, so it must fail closed instead of letting migration
	// silently omit the acknowledged mutation.
	const parts = contents.split("\n");
	const hasTrailingNewline = parts.length > 0 && parts[parts.length - 1] === "";
	const deltaLines = lines.slice(1);
	if (deltaLines.length === 0) return "stale";
	let sawValidDelta = false;
	for (let index = 0; index < deltaLines.length; index += 1) {
		const line = deltaLines[index]!;
		// An unterminated final line is a torn tail that replay treats as
		// uncommitted, even when it parses as valid JSON; exclude it from the
		// replayable count so a crash-leftover cannot bypass the committed
		// shortcut and trigger a compaction that churns the source digest.
		if (index === deltaLines.length - 1 && !hasTrailingNewline) break;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return "malformed";
		}
		if (!isWalDelta(parsed)) return "malformed";
		sawValidDelta = true;
	}
	return sawValidDelta ? "current" : "stale";
}
/** The compact single-line document this instance writes always places the
 * top-level generation key at a fixed byte offset. */
const GENERATION_KEY_OFFSET = JSON.stringify({
	kind: "openwebui-gjc-session-authority",
	version: 2,
	generation: "",
}).indexOf('"generation"');
/** Finds the TOP-LEVEL generation key by scanning the raw text with
 * container-depth tracking (a nested `observations.generation` carrying the
 * same value must never shadow the top-level key). Returns the key's BYTE
 * offset and the full byte length of the serialized span (key, any whitespace,
 * colon, quoted value), so the per-mutation read window covers the complete
 * value regardless of an external writer's whitespace formatting. */
export function findGenerationOffset(
	raw: string,
	generation: string,
): { readonly offset: number; readonly spanLength: number } | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			// Only depth-1 strings are top-level keys (the document's top-level
			// values are never the literal string "generation").
			if (depth === 1 && raw.slice(index + 1).startsWith('generation"')) {
				const after = raw.slice(index + '"generation"'.length);
				const match = /^\s*:\s*"([^"]*)"/.exec(after);
				// The offset must be a BYTE offset (readSync interprets it as such)
				// while this scan counts UTF-16 code units; convert through the
				// byte length of the preceding text. The span length is the key plus
				// the matched serialization (whitespace included).
				if (match !== null && match[1] === generation)
					return {
						offset: Buffer.byteLength(raw.slice(0, index), "utf8"),
						spanLength: Buffer.byteLength(`"generation"${match[0]}`, "utf8"),
					};
			}
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth = Math.max(0, depth - 1);
	}
	return undefined;
}
/** Resolves the cached identity fields (generation, offset, span length) for a
 * document whose raw text was just parsed. */
function generationSpanFromDocument(
	raw: string,
	generation: string,
): { readonly generation: string; readonly generationOffset?: number; readonly generationSpanLength?: number } {
	const found = findGenerationOffset(raw, generation);
	return {
		generation,
		...(found === undefined ? {} : { generationOffset: found.offset, generationSpanLength: found.spanLength }),
	};
}
/** Reads exactly the cached serialized span at the cached byte offset and
 * extracts the generation value; undefined when the read fails or the window
 * no longer carries the key (the caller treats that as a mismatch, which is
 * fail-safe). */
function readGenerationAtOffset(path: string, offset: number, spanLength: number): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(spanLength);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, offset);
		if (bytesRead <= 0) return undefined;
		const match = /^"generation"\s*:\s*"([^"]*)"/.exec(buffer.toString("utf8", 0, bytesRead));
		return match?.[1];
	} finally {
		closeSync(descriptor);
	}
}
function sameStatIdentity(
	left: { readonly size: number; readonly mtimeMs: number } | undefined,
	right: { readonly size: number; readonly mtimeMs: number } | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function walHeader(base: BaseIdentity | undefined): unknown {
	return { kind: WAL_KIND, version: WAL_VERSION, base, prevHash: WAL_CHAIN_SEED };
}
function isWalHeaderShape(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const header = value as Record<string, unknown>;
	if (
		header.kind !== WAL_KIND ||
		(header.version !== WAL_VERSION && header.version !== WAL_LEGACY_VERSION) ||
		!isRecord(header.base)
	)
		return false;
	if (header.version === WAL_VERSION && !isNonEmptyString(header.prevHash)) return false;
	return true;
}
function isWalHeaderBoundToBase(value: unknown, base: BaseIdentity | undefined): boolean {
	if (!isWalHeaderShape(value) || base === undefined) return false;
	const recorded = (value as Record<string, unknown>).base as Record<string, unknown>;
	if (recorded.size !== base.size || recorded.mtimeMs !== base.mtimeMs) return false;
	// A generation-bearing base requires the header to carry the same
	// generation, so a timestamp-preserving external replacement with the same
	// byte length cannot replay stale deltas over it. Legacy stat-only WALs
	// (and bases that predate generations) remain bound by the stat fields.
	if (base.generation === undefined ? recorded.generation !== undefined : recorded.generation !== base.generation)
		return false;
	// When both the cached identity and the header carry a content digest,
	// require them to match: an external rewrite that preserves generation,
	// size, and mtime still changes the digest, so a stale WAL is discarded
	// instead of being replayed over the edited base. A header that predates
	// the digest field remains replayable (stat/generation-bound) and is
	// upgraded before the next append.
	if (base.digest !== undefined && isNonEmptyString(recorded.digest)) return recorded.digest === base.digest;
	return true;
}
function isWalHeader(value: unknown, base: BaseIdentity | undefined): boolean {
	return isWalHeaderShape(value) && isWalHeaderBoundToBase(value, base);
}
function walDelta(
	records: readonly SessionAuthorityRecord[],
	provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
	prevHash: string,
): { readonly head: string } & {
	readonly kind: typeof WAL_KIND;
	readonly version: typeof WAL_VERSION;
	readonly records: readonly SessionAuthorityRecord[];
	readonly provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[];
	readonly prevHash: string;
} {
	// The chained head commits to the line's BODY (everything but the head
	// itself), so it can be embedded without self-reference.
	const body = { kind: WAL_KIND, version: WAL_VERSION, records, provisional, prevHash };
	return { ...body, head: lineChainHash(prevHash, JSON.stringify(body)) };
}
function isWalDelta(value: unknown): value is {
	readonly records: readonly SessionAuthorityRecord[];
	readonly provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[];
} {
	if (typeof value !== "object" || value === null) return false;
	const delta = value as Record<string, unknown>;
	if (delta.kind !== WAL_KIND || (delta.version !== WAL_VERSION && delta.version !== WAL_LEGACY_VERSION)) return false;
	if (delta.version === WAL_VERSION && (!isNonEmptyString(delta.prevHash) || !isNonEmptyString(delta.head)))
		return false;
	return (
		Array.isArray(delta.records) &&
		delta.records.every(isV2Record) &&
		Array.isArray(delta.provisional) &&
		delta.provisional.every(
			item => isRecord(item) && typeof item.key === "string" && isProvisionalOperation(item.operation),
		)
	);
}
/** Re-serializes a parsed chained delta's body (everything but head) so its
 * head can be recomputed byte-identically against the on-disk line. */
function walDeltaBodyJson(delta: Record<string, unknown>): string {
	const { head: _head, ...body } = delta;
	return JSON.stringify(body);
}
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeRecordForPersistence(record: SessionAuthorityRecord): SessionAuthorityRecord {
	return {
		...record,
		journal: record.journal.map(normalizeOperationResult),
		...(record.reassignment === undefined ? {} : { reassignment: normalizeReassignment(record.reassignment) }),
	};
}
function normalizeProvisionalForPersistence(operation: ProvisionalSessionOperation): ProvisionalSessionOperation {
	return {
		...operation,
		...(operation.result === undefined ? {} : { result: normalizeResult(operation.result) }),
	};
}
function normalizeReassignment(reassignment: SessionAuthorityReassignment): SessionAuthorityReassignment {
	return {
		...reassignment,
		...(reassignment.sourceTombstone === undefined
			? {}
			: { sourceTombstone: normalizeTombstone(reassignment.sourceTombstone) }),
		...(reassignment.priorTombstone === undefined
			? {}
			: { priorTombstone: normalizeTombstone(reassignment.priorTombstone) }),
	};
}
function normalizeTombstone(tombstone: SessionAuthorityTombstone): SessionAuthorityTombstone {
	return {
		...tombstone,
		journal: tombstone.journal.map(normalizeOperationResult),
		...(tombstone.prior === undefined ? {} : { prior: normalizeTombstone(tombstone.prior) }),
	};
}
function normalizeOperationResult(operation: SessionOperation): SessionOperation {
	if (operation.result === undefined) return operation;
	return { ...operation, result: normalizeResult(operation.result) };
}
function normalizeResult(result: SessionOperationResult): SessionOperationResult {
	if (result.events === undefined) return result;
	const gateEvents = result.events.filter(event => event.type === "workflow_gate");
	// Legacy workflow-gate results (written before the compact gate binding
	// existed) may rely on their retained events as the only evidence
	// authenticating the answered gate once the record mapping has advanced.
	// Synthesize a compact gate binding ONLY when the answered gate is
	// unambiguous (a single workflow-gate event): in a sequential chain the
	// events can begin with gates accepted by EARLIER operations, and taking
	// the first would bind the wrong gate. When ambiguous, preserve the events
	// so the legacy replay path can still verify against them.
	if (result.gate === undefined && gateEvents.length > 0) {
		if (gateEvents.length === 1) {
			const gate = pendingWorkflowGateFromEvent(gateEvents[0]!);
			if (gate !== null) {
				const { events: _events, ...withoutEvents } = result;
				return {
					...withoutEvents,
					gate: {
						gateId: gate.gateId,
						...(gate.commandId === undefined || gate.turnId === undefined || gate.sessionId === undefined
							? {}
							: { commandId: gate.commandId, turnId: gate.turnId, sessionId: gate.sessionId }),
					},
				};
			}
		}
		return result;
	}
	const { events: _events, ...withoutEvents } = result;
	return withoutEvents;
}

export function isAuthorityDocument(value: unknown): value is {
	kind: string;
	version: number;
	generation?: string;
	mappings: SessionAuthorityRecord[];
	provisionalOperations?: ProvisionalSessionOperation[];
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const document = value as Record<string, unknown>;
	return (
		Object.keys(document).every(key =>
			["kind", "version", "generation", "normalized", "mappings", "provisionalOperations"].includes(key),
		) &&
		document.kind === "openwebui-gjc-session-authority" &&
		document.version === SESSION_AUTHORITY_VERSION &&
		(document.generation === undefined ||
			(typeof document.generation === "string" && document.generation.length > 0)) &&
		Array.isArray(document.mappings) &&
		document.mappings.every(isV2Record) &&
		(document.provisionalOperations === undefined ||
			(Array.isArray(document.provisionalOperations) &&
				document.provisionalOperations.every(isProvisionalOperation)))
	);
}
