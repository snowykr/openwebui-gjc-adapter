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
import { provisionalKey } from "./session-operation-codec";

const WAL_KIND = "openwebui-gjc-session-authority-wal" as const;
const WAL_VERSION = 1 as const;
const WAL_COMPACTION_THRESHOLD_BYTES = 32 * 1024 * 1024;

export class SessionAuthorityDurabilityError extends Error {
	constructor(filePath: string, cause: unknown) {
		super(`Session authority durability is uncertain after replacing ${filePath}.`, { cause });
		this.name = "SessionAuthorityDurabilityError";
	}
}

export class FileSessionAuthority extends SessionAuthority {
	#baseIdentity: { readonly size: number; readonly mtimeMs: number } | undefined = undefined;
	#walIdentity: { readonly size: number; readonly mtimeMs: number } | undefined = undefined;

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
			const records = this.entries();
			const provisionalOperations = this.provisionalEntries();
			let result: T;
			try {
				result = mutation();
			} catch (error) {
				if (error instanceof SessionAuthorityDurabilityError) throw error;
				this.replaceAll(records, provisionalOperations);
				this.clearDirtyJournal();
				throw error;
			}
			if (this.journalNeedsCompaction()) {
				try {
					this.persist();
				} catch (error) {
					if (error instanceof SessionAuthorityDurabilityError) throw error;
					this.replaceAll(records, provisionalOperations);
					this.clearDirtyJournal();
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
						this.replaceAll(records, provisionalOperations);
						this.clearDirtyJournal();
						throw error;
					}
				} else {
					try {
						this.appendWal(dirtyRecords, dirtyProvisional);
					} catch (error) {
						if (error instanceof SessionAuthorityDurabilityError) throw error;
						this.replaceAll(records, provisionalOperations);
						this.clearDirtyJournal();
						throw error;
					}
					if (this.walOversized()) {
						try {
							this.persist();
						} catch (error) {
							if (error instanceof SessionAuthorityDurabilityError) throw error;
							this.replaceAll(records, provisionalOperations);
							this.clearDirtyJournal();
							throw error;
						}
					}
				}
			}
			return result;
		} finally {
			lock.release();
		}
	}
	private verifyAgainstDisk(): void {
		const baseStat = statIdentity(this.filePath);
		const walStat = statIdentity(this.walPath);
		if (sameStatIdentity(baseStat, this.#baseIdentity) && sameStatIdentity(walStat, this.#walIdentity)) return;
		this.load();
		if (walStat !== undefined) this.replayWal();
		else this.#walIdentity = undefined;
	}
	private load(): void {
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
			this.replaceAll([]);
			this.#baseIdentity = statIdentity(this.filePath);
			this.clearDirtyJournal();
			return;
		}
		if (
			!isAuthorityDocument(document) ||
			!isAuthorityDocumentRelationallyValid(document.mappings, document.provisionalOperations ?? [])
		)
			throw new SessionAuthorityLoadError(this.filePath, "authority document is not a valid v2 authority");
		this.replaceAll(document.mappings, document.provisionalOperations ?? []);
		this.#baseIdentity = statIdentity(this.filePath);
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
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(
				descriptor,
				`${JSON.stringify({
					kind: "openwebui-gjc-session-authority",
					version: SESSION_AUTHORITY_VERSION,
					mappings: mappings.map(normalizeRecordForPersistence),
					provisionalOperations: provisionalOperations.map(normalizeProvisionalForPersistence),
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
			this.load();
			this.#walIdentity = undefined;
			try {
				if (existsSync(this.walPath)) unlinkSync(this.walPath);
			} catch {
				// The base already supersedes the WAL; a stale file is discarded at the next boot stat check.
			}
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
		this.resetWalFile();
		this.#baseIdentity = statIdentity(this.filePath);
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
		if (!isWalHeader(header, statIdentity(this.filePath))) {
			this.dropWalFile();
			return { trailingGarbage: false };
		}
		const records = new Map<string, SessionAuthorityRecord>();
		const provisional = new Map<string, ProvisionalSessionOperation>();
		for (const record of this.entries()) records.set(record.chatId, record);
		for (const operation of this.provisionalEntries())
			provisional.set(provisionalKey(operation.chatId, operation.ingressId ?? operation.id), operation);
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
		this.replaceAll([...records.values()], [...provisional.values()]);
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
				if (created)
					writeFileSync(descriptor, `${JSON.stringify(walHeader(statIdentity(this.filePath)))}\n`, "utf8");
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
		return isWalHeader(header, statIdentity(this.filePath));
	}
	private recoverFailedWalAppend(previousStat: { readonly size: number; readonly mtimeMs: number } | undefined): void {
		const walPath = this.walPath;
		if (previousStat === undefined) {
			try {
				if (existsSync(walPath)) unlinkSync(walPath);
			} catch {
				// Best effort; a stale partial WAL is discarded at the next boot stat check.
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
			} finally {
				closeSync(descriptor);
			}
			this.#walIdentity = previousStat;
		} catch {
			// Best effort; boot replay tolerates a trailing partial line.
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
		return this.#walIdentity !== undefined && this.#walIdentity.size > WAL_COMPACTION_THRESHOLD_BYTES;
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
function sameStatIdentity(
	left: { readonly size: number; readonly mtimeMs: number } | undefined,
	right: { readonly size: number; readonly mtimeMs: number } | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function walHeader(base: { readonly size: number; readonly mtimeMs: number } | undefined): unknown {
	return { kind: WAL_KIND, version: WAL_VERSION, base };
}
function isWalHeader(value: unknown, base: { readonly size: number; readonly mtimeMs: number } | undefined): boolean {
	if (typeof value !== "object" || value === null || base === undefined) return false;
	const header = value as Record<string, unknown>;
	return (
		header.kind === WAL_KIND &&
		header.version === WAL_VERSION &&
		isRecord(header.base) &&
		header.base.size === base.size &&
		header.base.mtimeMs === base.mtimeMs
	);
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
	mappings: SessionAuthorityRecord[];
	provisionalOperations?: ProvisionalSessionOperation[];
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const document = value as Record<string, unknown>;
	return (
		Object.keys(document).every(key => ["kind", "version", "mappings", "provisionalOperations"].includes(key)) &&
		document.kind === "openwebui-gjc-session-authority" &&
		document.version === SESSION_AUTHORITY_VERSION &&
		Array.isArray(document.mappings) &&
		document.mappings.every(isV2Record) &&
		(document.provisionalOperations === undefined ||
			(Array.isArray(document.provisionalOperations) &&
				document.provisionalOperations.every(isProvisionalOperation)))
	);
}
