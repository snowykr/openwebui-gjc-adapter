import { randomUUID } from "node:crypto";
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
const WAL_VERSION = 1 as const;
const WAL_COMPACTION_THRESHOLD_BYTES = 32 * 1024 * 1024;

type BaseIdentity = { readonly size: number; readonly mtimeMs: number; readonly generation?: string };

export class SessionAuthorityDurabilityError extends Error {
	constructor(filePath: string, cause: unknown) {
		super(`Session authority durability is uncertain after replacing ${filePath}.`, { cause });
		this.name = "SessionAuthorityDurabilityError";
	}
}

export class FileSessionAuthority extends SessionAuthority {
	#baseIdentity: BaseIdentity | undefined = undefined;
	#walIdentity: { readonly size: number; readonly mtimeMs: number } | undefined = undefined;
	protected walCompactionThresholdBytes = WAL_COMPACTION_THRESHOLD_BYTES;

	constructor(private readonly filePath: string) {
		super();
		const lock = AuthorityMutationLock.acquire(this.filePath);
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
			lock.release();
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
			this.baseGenerationMatchesDisk()
		)
			return;
		this.load();
		if (walStat !== undefined) this.replayWal();
		else this.#walIdentity = undefined;
	}
	/** The live verification path must also confirm the collision-resistant base
	 * generation, not only size/mtime: a timestamp-preserving same-size external
	 * replacement while this instance is running would otherwise keep appending
	 * under the stale generation and the WAL would be rejected (and the
	 * acknowledged mutation silently lost) at the next boot. */
	private baseGenerationMatchesDisk(): boolean {
		const base = this.#baseIdentity;
		if (base === undefined) return true;
		return readBaseGeneration(this.filePath) === (base.generation ?? undefined);
	}
	protected load(): void {
		if (!existsSync(this.filePath)) {
			this.#baseIdentity = undefined;
			this.clearDirtyJournal();
			return;
		}
		let document: unknown;
		try {
			document = JSON.parse(readFileSync(this.filePath, "utf8"));
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
						...(typeof document.generation === "string" ? { generation: document.generation } : {}),
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
		this.#baseIdentity = { ...statIdentity(this.filePath)!, generation: nextGeneration };
		this.clearDirtyJournal();
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
		const lines = contents.split("\n").filter(line => line.length > 0);
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
		const raw = this.rawJournalEntries();
		const records = new Map(raw.records);
		const provisional = new Map(raw.provisional);
		let trailingGarbage = false;
		for (const line of lines.slice(1)) {
			let delta: unknown;
			try {
				delta = JSON.parse(line);
			} catch {
				trailingGarbage = true;
				break;
			}
			if (!isWalDelta(delta)) {
				trailingGarbage = true;
				break;
			}
			for (const record of delta.records) records.set(record.chatId, record);
			for (const item of delta.provisional) provisional.set(item.key, item.operation);
		}
		this.replaceAllWithReferences([...records.values()], [...provisional.values()]);
		this.#walIdentity = statIdentity(walPath);
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
			if (existsSync(walPath) && this.walHasValidHeader(walPath)) {
				this.#walIdentity = statIdentity(walPath);
			} else {
				if (existsSync(walPath)) unlinkSync(walPath);
				created = true;
			}
		}
		const previousStat = this.#walIdentity;
		let descriptor: number;
		try {
			descriptor = openSync(walPath, "a", 0o600);
			try {
				if (created) writeFileSync(descriptor, `${JSON.stringify(walHeader(this.#baseIdentity))}\n`, "utf8");
				writeFileSync(descriptor, `${JSON.stringify(walDelta(records, provisional))}\n`, "utf8");
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
				this.#walIdentity = statIdentity(walPath);
				throw new SessionAuthorityDurabilityError(this.filePath, error);
			}
		}
		this.#walIdentity = statIdentity(walPath);
	}
	private walHasValidHeader(walPath: string): boolean {
		let contents: string;
		try {
			contents = readFileSync(walPath, "utf8");
		} catch {
			return false;
		}
		const line = contents.split("\n")[0];
		if (line === undefined || line.length === 0) return false;
		let header: unknown;
		try {
			header = JSON.parse(line);
		} catch {
			return false;
		}
		return isWalHeader(header, this.#baseIdentity);
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
	protected recoverFailedWalAppend(
		previousStat: { readonly size: number; readonly mtimeMs: number } | undefined,
	): void {
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

function statIdentity(path: string): { readonly size: number; readonly mtimeMs: number } | undefined {
	if (!existsSync(path)) return undefined;
	const stat = statSync(path);
	return { size: stat.size, mtimeMs: stat.mtimeMs };
}
/** Streams the base document and extracts the TOP-LEVEL generation value
 * without assuming JSON property order or a fixed prefix size. The document is
 * scanned in bounded chunks while tracking container depth and string state,
 * so a generation placed after a large mappings array (or reordered by an
 * external writer) is still found without ever reading the whole file at once.
 * Returns undefined when the file is unreadable or has no top-level generation
 * (legacy bases); the caller treats that as a mismatch when a generation is
 * expected, which is fail-safe. */
function readBaseGeneration(path: string): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(64 * 1024);
		let offset = 0;
		let depth = 0;
		let inString = false;
		let escaped = false;
		let collectingValue = false;
		let afterKeyColon = false;
		const keyBytes: number[] = [];
		const valueBytes: number[] = [];
		let chunkSize = 4096;
		while (true) {
			const bytesRead = readSync(descriptor, buffer, 0, Math.min(chunkSize, buffer.length), offset);
			if (bytesRead <= 0) break;
			for (let index = 0; index < bytesRead; index += 1) {
				const byte = buffer[index]!;
				if (inString) {
					if (escaped) {
						escaped = false;
					} else if (byte === 0x5c) {
						escaped = true;
					} else if (byte === 0x22) {
						inString = false;
						if (collectingValue) {
							collectingValue = false;
							if (Buffer.from(keyBytes).toString("utf8") === "generation")
								return Buffer.from(valueBytes).toString("utf8");
						}
						afterKeyColon = false;
					} else if (depth === 1 && collectingValue) {
						valueBytes.push(byte);
					} else if (depth === 1) {
						keyBytes.push(byte);
					}
					continue;
				}
				// Whitespace outside strings is insignificant: it must never clear
				// the pending key-colon state (an external writer may emit formatted
				// JSON such as `"generation": "uuid"`).
				if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
				if (byte === 0x22) {
					// A root-level string starts: either a key or the value after a
					// colon. Nested strings (depth >= 2) are ignored entirely.
					inString = true;
					if (depth === 1 && afterKeyColon) {
						collectingValue = true;
						valueBytes.length = 0;
					} else if (depth === 1) {
						collectingValue = false;
						keyBytes.length = 0;
					}
					continue;
				}
				if (byte === 0x7b || byte === 0x5b) {
					depth += 1;
					afterKeyColon = false;
					continue;
				}
				if (byte === 0x7d || byte === 0x5d) {
					depth = Math.max(0, depth - 1);
					afterKeyColon = false;
					continue;
				}
				if (byte === 0x3a && depth === 1) {
					afterKeyColon = true;
					collectingValue = false;
					continue;
				}
				if (byte === 0x2c) {
					afterKeyColon = false;
					continue;
				}
				if (afterKeyColon) {
					// A root-level scalar (number/bool/null) value token; it cannot
					// be the generation, so stop treating the colon as pending.
					afterKeyColon = false;
				}
			}
			offset += bytesRead;
			chunkSize = buffer.length;
		}
		return undefined;
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
	return { kind: WAL_KIND, version: WAL_VERSION, base };
}
function isWalHeader(value: unknown, base: BaseIdentity | undefined): boolean {
	if (typeof value !== "object" || value === null || base === undefined) return false;
	const header = value as Record<string, unknown>;
	if (header.kind !== WAL_KIND || header.version !== WAL_VERSION || !isRecord(header.base)) return false;
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
): unknown {
	return { kind: WAL_KIND, version: WAL_VERSION, records, provisional };
}
function isWalDelta(value: unknown): value is {
	readonly records: readonly SessionAuthorityRecord[];
	readonly provisional: readonly { readonly key: string; readonly operation: ProvisionalSessionOperation }[];
} {
	if (typeof value !== "object" || value === null) return false;
	const delta = value as Record<string, unknown>;
	return (
		delta.kind === WAL_KIND &&
		delta.version === WAL_VERSION &&
		Array.isArray(delta.records) &&
		delta.records.every(isV2Record) &&
		Array.isArray(delta.provisional) &&
		delta.provisional.every(
			item => isRecord(item) && typeof item.key === "string" && isProvisionalOperation(item.operation),
		)
	);
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

function isAuthorityDocument(value: unknown): value is {
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
