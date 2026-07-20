import { constants, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { copy, copyOperationResult, copyProvisionalOperation } from "./session-authority-copy";
import { createAuthorityIdentity, operationResult, provisionalKey, updateAuthorityIdentity } from "./session-operation-codec";
import { AuthorityMutationLock } from "./session-authority-file";
import { isAlreadyExists, isLegacyMappingDocument, isProvisionalOperation, isV2Record } from "./session-authority-validation";
import type { ProvisionalSessionOperation, SessionAuthorityInput, SessionAuthorityRecord, SessionOperation, SessionOperationResult, SessionOperationState } from "./session-authority-types";
import { SESSION_AUTHORITY_VERSION, SessionAuthorityLoadError } from "./session-authority-types";
export { SESSION_AUTHORITY_VERSION, SessionAuthorityLoadError } from "./session-authority-types";
export type { ProvisionalSessionOperation, SessionAttachmentProof, SessionAuthorityInput, SessionAuthorityRecord, SessionOperation, SessionOperationKind, SessionOperationResult, SessionOperationState } from "./session-authority-types";
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
	reserveProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">): ProvisionalSessionOperation {
		const ingressId = operation.ingressId ?? operation.id;
		const key = provisionalKey(operation.chatId, ingressId);
		const prior = this.#provisional.get(key);
		if (prior !== undefined) {
			if (prior.kind !== operation.kind || prior.projectId !== operation.projectId || prior.detail !== operation.detail) {
				throw new Error(`Session ingress ${ingressId} conflicts with an existing provisional operation.`);
			}
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		}
		const next = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		this.#provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	publishProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">, mapping: SessionAuthorityInput): SessionAuthorityRecord {
		const ingressId = operation.ingressId ?? operation.id;
		const key = provisionalKey(operation.chatId, ingressId);
		const reserved = this.#provisional.get(key);
		if (reserved === undefined || reserved.state !== "pending") {
			throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		}
		const completedAt = new Date().toISOString();
		const journalOperation: SessionOperation = {
			id: operation.id, kind: "prompt", state: "complete", ingressId: operation.ingressId,
			detail: operation.detail, startedAt: reserved.startedAt, completedAt,
			result: operationResult("turn", mapping),
		};
		const next = this.store({ ...mapping, journal: [journalOperation] });
		this.#provisional.set(key, { ...reserved, state: "complete", completedAt });
		return next;
	}
	transitionProvisionalOperation(chatId: string, ingressId: string, state: SessionOperationState, detail?: string): ProvisionalSessionOperation {
		const key = provisionalKey(chatId, ingressId);
		const current = this.#provisional.get(key);
		if (current === undefined) throw new Error(`Unknown provisional session operation ${ingressId}.`);
		if (current.state === "complete" && state !== "complete") throw new Error("Completed session operations are immutable.");
		const next = {
			...current, state,
			...(detail === undefined ? {} : { detail }),
			...(state === "complete" ? { completedAt: new Date().toISOString() } : {}),
		};
		this.#provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	attachProvisionalOperation(chatId: string, ingressId: string, attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">): ProvisionalSessionOperation {
		const key = provisionalKey(chatId, ingressId);
		const current = this.#provisional.get(key);
		if (current === undefined || current.state !== "pending") throw new Error(`Session operation ${ingressId} requires reconciliation.`);
		if (attachment.sessionId === undefined || attachment.sessionFile === undefined || attachment.attachment === undefined) {
			throw new Error("Provisional session authority requires complete attachment proof.");
		}
		const next = { ...current, ...attachment };
		this.#provisional.set(key, next);
		return copyProvisionalOperation(next);
	}
	provisionalEntries(): readonly ProvisionalSessionOperation[] { return [...this.#provisional.values()].map(copyProvisionalOperation); }
	beginOperation(chatId: string, operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">): SessionAuthorityRecord {
		const record = this.require(chatId);
		const prior = record.journal.find(candidate => candidate.id === operation.id || (operation.ingressId !== undefined && candidate.ingressId === operation.ingressId));
		if (prior !== undefined) {
			if (prior.kind !== operation.kind) throw new Error(`Session ingress ${operation.ingressId ?? operation.id} conflicts with an existing operation.`);
			return copy(record);
		}
		const pending = { ...operation, state: "pending" as const, startedAt: new Date().toISOString() };
		const next = { ...record, journal: [...record.journal, pending] };
		this.#records.set(chatId, next);
		return copy(next);
	}
	transitionOperation(chatId: string, operationId: string, state: SessionOperationState, detail?: string, result?: SessionOperationResult): SessionAuthorityRecord {
		const record = this.require(chatId);
		const index = record.journal.findIndex(operation => operation.id === operationId || operation.ingressId === operationId);
		if (index < 0) throw new Error(`Unknown session operation ${operationId}.`);
		const current = record.journal[index];
		if (current === undefined) throw new Error(`Unknown session operation ${operationId}.`);
		if (current.state === "complete" && state !== "complete") throw new Error("Completed session operations are immutable.");
		if (state === "complete" && result === undefined && current.result === undefined) throw new Error("Completed session operations require an immutable result binding.");
		if (state !== "complete" && result !== undefined) throw new Error("Only completed session operations may bind a result.");
		const journal = [...record.journal];
		journal[index] = {
			...current, state,
			...(detail === undefined ? {} : { detail }),
			...(result === undefined ? {} : { result: copyOperationResult(result) }),
			...(state === "complete" ? { completedAt: new Date().toISOString() } : {}),
		};
		const next = { ...record, journal };
		this.#records.set(chatId, next);
		return copy(next);
	}
	completeOperationWithMapping(chatId: string, operationId: string, detail: string, mapping: SessionAuthorityInput, result: SessionOperationResult): SessionAuthorityRecord {
		this.upsert(mapping);
		return this.transitionOperation(chatId, operationId, "complete", detail, result);
	}
	reconcileRestart(): readonly SessionAuthorityRecord[] {
		const reconciled: SessionAuthorityRecord[] = [];
		for (const record of this.#records.values()) {
			const journal = record.journal.map(operation => operation.state === "pending"
				? { ...operation, state: "uncertain" as const, detail: operation.detail ?? "restart before completion" }
				: operation);
			if (!journal.some((operation, index) => operation !== record.journal[index])) continue;
			const next = { ...record, journal };
			this.#records.set(record.chatId, next);
			reconciled.push(copy(next));
		}
		for (const operation of this.#provisional.values()) {
			if (operation.state !== "pending") continue;
			const next = { ...operation, state: "uncertain" as const, detail: operation.detail ?? "restart before completion" };
			this.#provisional.set(provisionalKey(next.chatId, next.ingressId ?? next.id), next);
		}
		return reconciled;
	}
	protected replaceAll(records: readonly SessionAuthorityRecord[], provisional: readonly ProvisionalSessionOperation[] = []): void {
		this.#records.clear();
		this.#provisional.clear();
		for (const record of records) this.#records.set(record.chatId, copy(record));
		for (const operation of provisional) this.#provisional.set(provisionalKey(operation.chatId, operation.ingressId ?? operation.id), copyProvisionalOperation(operation));
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
export class FileSessionAuthority extends SessionAuthority {
	constructor(private readonly filePath: string) {
		super();
		if (!existsSync(filePath)) return;
		this.load();
		if (this.entries().some(record => record.journal.some(operation => operation.state === "pending")) || this.provisionalEntries().some(operation => operation.state === "pending")) {
			super.reconcileRestart();
			this.persist();
		}
	}
	override set(input: SessionAuthorityInput): SessionAuthorityRecord { return this.mutate(() => super.set(input)); }
	override upsert(input: SessionAuthorityInput): SessionAuthorityRecord { return this.mutate(() => super.upsert(input)); }
	override transitionOperation(chatId: string, operationId: string, state: SessionOperationState, detail?: string, result?: SessionOperationResult): SessionAuthorityRecord { return this.mutate(() => super.transitionOperation(chatId, operationId, state, detail, result)); }
	override completeOperationWithMapping(chatId: string, operationId: string, detail: string, mapping: SessionAuthorityInput, result: SessionOperationResult): SessionAuthorityRecord {
		return this.mutate(() => {
			super.upsert(mapping);
			return super.transitionOperation(chatId, operationId, "complete", detail, result);
		});
	}
	override beginOperation(chatId: string, operation: Omit<SessionOperation, "state" | "startedAt" | "completedAt">): SessionAuthorityRecord { return this.mutate(() => super.beginOperation(chatId, operation)); }
	override reserveProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">): ProvisionalSessionOperation { return this.mutate(() => super.reserveProvisionalOperation(operation)); }
	override publishProvisionalOperation(operation: Omit<ProvisionalSessionOperation, "state" | "startedAt" | "completedAt">, mapping: SessionAuthorityInput): SessionAuthorityRecord { return this.mutate(() => super.publishProvisionalOperation(operation, mapping)); }
	override attachProvisionalOperation(chatId: string, ingressId: string, attachment: Pick<ProvisionalSessionOperation, "sessionId" | "sessionFile" | "attachment">): ProvisionalSessionOperation { return this.mutate(() => super.attachProvisionalOperation(chatId, ingressId, attachment)); }
	override transitionProvisionalOperation(chatId: string, ingressId: string, state: SessionOperationState, detail?: string): ProvisionalSessionOperation { return this.mutate(() => super.transitionProvisionalOperation(chatId, ingressId, state, detail)); }
	protected mutate<T>(mutation: () => T): T {
		const lock = AuthorityMutationLock.acquire(this.filePath);
		try {
			this.load();
			const result = mutation();
			this.persist();
			return result;
		} finally {
			lock.release();
		}
	}
	private load(): void {
		if (!existsSync(this.filePath)) return;
		let document: unknown;
		try {
			document = JSON.parse(readFileSync(this.filePath, "utf8"));
		} catch (error) {
			throw new SessionAuthorityLoadError(this.filePath, "authority JSON is unreadable", error);
		}
		if (isLegacyMappingDocument(document)) {
			this.quarantineLegacyDocument();
			this.replaceAll([]);
			return;
		}
		if (!isAuthorityDocument(document)) throw new SessionAuthorityLoadError(this.filePath, "authority document is not a valid v2 authority");
		this.replaceAll(document.mappings, document.provisionalOperations ?? []);
	}
	private persist(): void {
		const mappings = this.entries();
		const provisionalOperations = this.provisionalEntries();
		if (!mappings.every(isV2Record) || !provisionalOperations.every(isProvisionalOperation)) throw new Error("Refusing to persist an invalid v2 session authority.");
		mkdirSync(dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify({ kind: "openwebui-gjc-session-authority", version: SESSION_AUTHORITY_VERSION, mappings, provisionalOperations }, null, 2)}\n`, "utf8");
			fsyncSync(descriptor);
		} finally { closeSync(descriptor); }
		renameSync(temporary, this.filePath);
		const directory = openSync(dirname(this.filePath), "r");
		try {
			fsyncSync(directory);
		} finally { closeSync(directory); }
	}
	private quarantineLegacyDocument(): void {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const quarantine = `${this.filePath}.legacy-${Date.now()}-${process.pid}-${attempt}`;
			try {
				copyFileSync(this.filePath, quarantine, constants.COPYFILE_EXCL);
				const descriptor = openSync(quarantine, "r");
				try {
					fsyncSync(descriptor);
				} finally { closeSync(descriptor); }
				unlinkSync(this.filePath);
				return;
			} catch (error) {
				if (isAlreadyExists(error)) continue;
				throw error;
			}
		}
		throw new SessionAuthorityLoadError(this.filePath, "cannot allocate a collision-safe legacy authority quarantine path");
	}
}
function isAuthorityDocument(value: unknown): value is { kind: string; version: number; mappings: SessionAuthorityRecord[]; provisionalOperations?: ProvisionalSessionOperation[] } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const document = value as Record<string, unknown>;
	return Object.keys(document).every(key => ["kind", "version", "mappings", "provisionalOperations"].includes(key)) && document.kind === "openwebui-gjc-session-authority" && document.version === SESSION_AUTHORITY_VERSION && Array.isArray(document.mappings) && document.mappings.every(isV2Record) && (document.provisionalOperations === undefined || (Array.isArray(document.provisionalOperations) && document.provisionalOperations.every(isProvisionalOperation)));
}