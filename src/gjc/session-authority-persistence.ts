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
};
type WalIdentity = {
	readonly size: number;
	readonly mtimeMs: number;
	readonly digest: string;
	/** Byte length of the last line's JSON text; present for chained v2 WALs,
	 * absent for legacy v1 WALs (sample-based identity). */
	readonly lastLineLength?: number;
};

export class SessionAuthorityDurabilityError extends Error {
	constructor(filePath: string, cause: unknown) {
		super(`Session authority durability is uncertain after replacing ${filePath}.`, { cause });
		this.name = "SessionAuthorityDurabilityError";
	}
}

export class FileSessionAuthority extends SessionAuthority {
	#baseIdentity: BaseIdentity | undefined = undefined;
	#walIdentity: WalIdentity | undefined = undefined;
	protected walCompactionThresholdBytes = WAL_COMPACTION_THRESHOLD_BYTES;

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
			let trailingGarbage = false;
			if (existsSync(this.walPath)) trailingGarbage = this.replayWal().trailingGarbage;
			const pendingOperations = this.hasPendingOperations();
			if (trailingGarbage || this.walOversized() || pendingOperations) {
				if (pendingOperations) super.reconcileRestart();
				this.persist();
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
	 * byte offset is cached at load/persist time, so the per-mutation read is a
	 * bounded window instead of a whole-document scan even when an external
	 * writer reorders the document. */
	private baseGenerationMatchesDisk(): boolean {
		const base = this.#baseIdentity;
		if (base === undefined) return true;
		// A known generation with no cached byte offset cannot be verified: treat
		// it as a mismatch (fail closed) so a same-stat replacement cannot slip
		// through, and the next append upgrades the document to the standard
		// layout that carries a deterministic offset.
		if (base.generation === undefined) return true;
		if (base.generationOffset === undefined) return false;
		return readGenerationAtOffset(this.filePath, base.generationOffset) === base.generation;
	}
	/** The cached WAL state is bound to the WAL's CONTENT, not only its stat
	 * identity: a replacement with different valid contents that preserves byte
	 * length and mtime must be replayed before the next mutation is appended,
	 * otherwise the append would be acknowledged against a state that a restart
	 * never replays. The identity is a bounded head+tail content sample, so the
	 * check stays O(1) at every WAL size instead of re-reading the whole file
	 * per mutation (the full line-by-line validation still runs at boot). */
	private walDigestMatchesDisk(): boolean {
		const wal = this.#walIdentity;
		if (wal === undefined) return true;
		if (wal.lastLineLength !== undefined) {
			// Chained v2 identity: reading the last line re-verifies a hash that
			// cryptographically covers EVERY delta line, at O(last-line) cost
			// instead of re-hashing the whole WAL.
			const lastLine = walLastLine(this.walPath, wal.lastLineLength);
			if (lastLine === undefined) return false;
			return lineChainHash(lastLine.prevHash, lastLine.text) === wal.digest;
		}
		return walSampleDigestFromFile(this.walPath) === wal.digest;
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
		const stat = statIdentity(this.filePath);
		this.#baseIdentity =
			stat === undefined
				? undefined
				: {
						...stat,
						...(typeof document.generation === "string"
							? {
									generation: document.generation,
									generationOffset: findGenerationOffset(rawDocument, document.generation),
								}
							: {}),
					};
		this.clearDirtyJournal();
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
		try {
			writeFileSync(
				descriptor,
				`${JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: SESSION_AUTHORITY_VERSION,
					generation: nextGeneration,
					mappings: normalizedMappings,
					provisionalOperations: normalizedProvisional,
				})}\n`,
				"utf8",
			);
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
			try {
				if (existsSync(this.walPath)) unlinkSync(this.walPath);
			} catch {
				// The base already supersedes the WAL; a stale file is discarded at the next boot stat check.
			}
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
			this.refreshBaseIdentity(nextGeneration);
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
		this.clearDirtyJournal();
	}
	/** Refreshes the cached base identity (stat + generation) after a rewrite;
	 * separated so the post-commit failure handling can guard it. The generation
	 * offset is deterministic for documents this instance writes (the compact
	 * single-line layout always places the generation key at the same byte). */
	protected refreshBaseIdentity(nextGeneration: string): void {
		this.#baseIdentity = {
			...statIdentity(this.filePath)!,
			generation: nextGeneration,
			generationOffset: GENERATION_KEY_OFFSET,
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
		const lines = parts.filter(line => line.length > 0);
		if (lines.length === 0) {
			this.dropWalFile();
			return { trailingGarbage: false };
		}
		let header: unknown;
		try {
			header = JSON.parse(lines[0]!);
		} catch {
			header = undefined;
		}
		if (!isWalHeader(header, this.#baseIdentity)) {
			this.dropWalFile();
			return { trailingGarbage: false };
		}
		const chained = (header as Record<string, unknown>).version === WAL_VERSION;
		// For chained v2 WALs every line's prevHash must match the running chain,
		// so a replaced interior delta (even a syntactically valid one) breaks the
		// link and fails closed at boot instead of silently changing acknowledged
		// authority state.
		let expectedChain = WAL_CHAIN_SEED;
		let lastLineLength = 0;
		const raw = this.rawJournalEntries();
		const records = new Map(raw.records);
		const provisional = new Map(raw.provisional);
		let trailingGarbage = false;
		const deltaLines = lines.slice(1);
		const verifyLink = (prevHash: unknown, line: string): void => {
			if (!chained) return;
			if (!isNonEmptyString(prevHash) || prevHash !== expectedChain)
				throw new SessionAuthorityLoadError(this.filePath, "authority WAL chain is broken before its final line");
			expectedChain = lineChainHash(prevHash, line);
		};
		verifyLink((header as Record<string, unknown>).prevHash, lines[0]!);
		for (let index = 0; index < deltaLines.length; index += 1) {
			const line = deltaLines[index]!;
			let delta: unknown;
			try {
				delta = JSON.parse(line);
			} catch {
				delta = undefined;
			}
			if (delta === undefined || !isWalDelta(delta)) {
				// Only an unterminated malformed FINAL line is a crash-truncation
				// artifact that can be recovered by compacting the valid prefix. A
				// malformed non-final line (or a newline-terminated malformed line)
				// is corruption: silently dropping every acknowledged mutation
				// after it would be data loss, so fail closed instead.
				if (index === deltaLines.length - 1 && !hasTrailingNewline) {
					trailingGarbage = true;
					break;
				}
				throw new SessionAuthorityLoadError(this.filePath, "authority WAL is corrupt before its final line");
			}
			const deltaRecord = delta as Record<string, unknown>;
			verifyLink(deltaRecord.prevHash, line);
			lastLineLength = Buffer.byteLength(line, "utf8");
			for (const record of delta.records) records.set(record.chatId, record);
			for (const item of delta.provisional) provisional.set(item.key, item.operation);
		}
		this.replaceAllWithReferences([...records.values()], [...provisional.values()]);
		this.#walIdentity = chained
			? { ...statIdentity(walPath)!, digest: expectedChain, lastLineLength }
			: { ...statIdentity(walPath)!, digest: walSampleDigestFromContents(contents) };
		this.clearDirtyJournal();
		return { trailingGarbage };
	}
	protected appendWal(
		records: readonly SessionAuthorityRecord[],
		provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
	): void {
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
		if (
			created &&
			(this.#baseIdentity?.generation === undefined || this.#baseIdentity?.generationOffset === undefined)
		) {
			// A generation-less base (pre-upgrade v2 documents, or migration
			// output) or a base whose generation offset cannot be matched in its
			// raw representation (e.g. escaped JSON keys) must be rewritten with a
			// fresh generation in the standard layout BEFORE the first WAL append:
			// otherwise the WAL would be bound by stat only, or the per-mutation
			// generation check would be disabled and a timestamp-preserving restore
			// could replay stale deltas over the replacement. Persisting writes the
			// full current state (including this mutation) with a deterministic
			// generation offset, so the append is never made under a weak identity.
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
				const deltaJson = JSON.stringify(walDelta(records, provisional, prevHash));
				writeFileSync(descriptor, `${deltaJson}\n`, "utf8");
				writtenDigest = lineChainHash(prevHash, deltaJson);
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
		this.#walIdentity = { ...stat, digest: writtenDigest, lastLineLength };
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
		const lines = contents.split("\n").filter(line => line.length > 0);
		const firstLine = lines[0];
		if (firstLine === undefined) return false;
		let header: unknown;
		try {
			header = JSON.parse(firstLine);
		} catch {
			return false;
		}
		if (!isWalHeader(header, this.#baseIdentity)) return false;
		if ((header as Record<string, unknown>).version !== WAL_VERSION) return "legacy";
		let expectedChain = WAL_CHAIN_SEED;
		let digest: string | undefined;
		let lastLineLength = 0;
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return false;
			}
			const record = parsed as Record<string, unknown>;
			if (!isNonEmptyString(record.prevHash) || record.prevHash !== expectedChain) return false;
			expectedChain = lineChainHash(record.prevHash, line);
			digest = expectedChain;
			lastLineLength = Buffer.byteLength(line, "utf8");
		}
		if (digest === undefined) return false;
		this.#walIdentity = { ...statIdentity(walPath)!, digest, lastLineLength };
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
		return (
			this.entries().some(
				record =>
					record.reassignment?.state === "pending" ||
					record.journal.some(operation => operation.state === "pending"),
			) || this.provisionalEntries().some(operation => operation.state === "pending")
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
/** Reads the last chained line of a v2 WAL (bounded to its known byte length
 * plus the line terminator) and returns its prevHash and exact text, so the
 * per-mutation chain verification covers every delta without re-reading the
 * whole WAL. */
function walLastLine(
	path: string,
	lastLineLength: number,
): { readonly prevHash: string; readonly text: string } | undefined {
	let stat: { readonly size: number };
	try {
		stat = statSync(path);
	} catch {
		return undefined;
	}
	const readLength = lastLineLength + 1;
	if (stat.size < lastLineLength) return undefined;
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(readLength);
		const bytesRead = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, stat.size - readLength));
		if (bytesRead <= 0) return undefined;
		const text = buffer
			.toString("utf8", 0, bytesRead)
			.replace(/^[\n\r]+/, "")
			.replace(/[\n\r]+$/, "");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return undefined;
		}
		const record = parsed as Record<string, unknown>;
		if (!isNonEmptyString(record.prevHash)) return undefined;
		return { prevHash: record.prevHash, text };
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
/** The compact single-line document this instance writes always places the
 * top-level generation key at a fixed byte offset. */
const GENERATION_KEY_OFFSET = JSON.stringify({
	kind: "openwebui-gjc-session-authority",
	version: 2,
	generation: "",
}).indexOf('"generation"');
/** Finds the byte offset of the TOP-LEVEL generation key in a parsed
 * document by scanning the raw text with container-depth tracking: a nested
 * `observations.generation` carrying the same value must never shadow the
 * top-level key, otherwise the per-mutation window read would verify the
 * wrong occurrence and miss a same-stat top-level replacement. */
export function findGenerationOffset(raw: string, generation: string): number | undefined {
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
				const match = /^\s*:\s*"([^"]*)"/.exec(raw.slice(index + '"generation"'.length));
				// The offset must be a BYTE offset (readSync interprets it as such)
				// while this scan counts UTF-16 code units; convert through the
				// byte length of the preceding text.
				if (match !== null && match[1] === generation) return Buffer.byteLength(raw.slice(0, index), "utf8");
			}
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth = Math.max(0, depth - 1);
	}
	return undefined;
}
/** Reads a bounded window at the cached generation offset and extracts the
 * generation value; undefined when the read fails or the window no longer
 * carries the generation key (the caller treats that as a mismatch, which is
 * fail-safe). */
function readGenerationAtOffset(path: string, offset: number): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(256);
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
function isWalHeader(value: unknown, base: BaseIdentity | undefined): boolean {
	if (typeof value !== "object" || value === null || base === undefined) return false;
	const header = value as Record<string, unknown>;
	if (
		header.kind !== WAL_KIND ||
		(header.version !== WAL_VERSION && header.version !== WAL_LEGACY_VERSION) ||
		!isRecord(header.base)
	)
		return false;
	if (header.version === WAL_VERSION && !isNonEmptyString(header.prevHash)) return false;
	const recorded = header.base as Record<string, unknown>;
	if (recorded.size !== base.size || recorded.mtimeMs !== base.mtimeMs) return false;
	// A generation-bearing base requires the header to carry the same
	// generation, so a timestamp-preserving external replacement with the same
	// byte length cannot replay stale deltas over it. Legacy stat-only WALs
	// (and bases that predate generations) remain bound by the stat fields.
	return base.generation === undefined ? recorded.generation === undefined : recorded.generation === base.generation;
}
function walDelta(
	records: readonly SessionAuthorityRecord[],
	provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[],
	prevHash: string,
): unknown {
	return { kind: WAL_KIND, version: WAL_VERSION, records, provisional, prevHash };
}
function isWalDelta(value: unknown): value is {
	readonly records: readonly SessionAuthorityRecord[];
	readonly provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[];
} {
	if (typeof value !== "object" || value === null) return false;
	const delta = value as Record<string, unknown>;
	if (delta.kind !== WAL_KIND || (delta.version !== WAL_VERSION && delta.version !== WAL_LEGACY_VERSION)) return false;
	if (delta.version === WAL_VERSION && !isNonEmptyString(delta.prevHash)) return false;
	return (
		Array.isArray(delta.records) &&
		delta.records.every(isV2Record) &&
		Array.isArray(delta.provisional) &&
		delta.provisional.every(
			item => isRecord(item) && typeof item.key === "string" && isProvisionalOperation(item.operation),
		)
	);
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
			["kind", "version", "generation", "mappings", "provisionalOperations"].includes(key),
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
