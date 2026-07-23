import {
	closeSync,
	constants,
	copyFileSync,
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
import { AuthorityMutationLock } from "./session-authority-file";
import { SessionAuthority } from "./session-authority-store";
import type {
	AcknowledgedSuccessor,
	ProvisionalSessionOperation,
	SessionAuthorityInput,
	SessionAuthorityRecord,
	SessionAuthorityTargetIdentity,
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

export class SessionAuthorityDurabilityError extends Error {
	constructor(filePath: string, cause: unknown) {
		super(`Session authority durability is uncertain after replacing ${filePath}.`, { cause });
		this.name = "SessionAuthorityDurabilityError";
	}
}

export class FileSessionAuthority extends SessionAuthority {
	constructor(private readonly filePath: string) {
		super();
		const lock = AuthorityMutationLock.acquire(this.filePath);
		try {
			if (!existsSync(this.filePath)) return;
			this.load();
			if (
				this.entries().some(
					record =>
						record.reassignment?.state === "pending" ||
						record.journal.some(operation => operation.state === "pending"),
				) ||
				this.provisionalEntries().some(operation => operation.state === "pending")
			) {
				super.reconcileRestart();
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
			this.load();
			const records = this.entries();
			const provisionalOperations = this.provisionalEntries();
			try {
				const result = mutation();
				this.persist();
				return result;
			} catch (error) {
				if (error instanceof SessionAuthorityDurabilityError) throw error;
				this.replaceAll(records, provisionalOperations);
				throw error;
			}
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
		if (
			!isAuthorityDocument(document) ||
			!isAuthorityDocumentRelationallyValid(document.mappings, document.provisionalOperations ?? [])
		)
			throw new SessionAuthorityLoadError(this.filePath, "authority document is not a valid v2 authority");
		this.replaceAll(document.mappings, document.provisionalOperations ?? []);
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
				`${JSON.stringify({ kind: "openwebui-gjc-session-authority", version: SESSION_AUTHORITY_VERSION, mappings, provisionalOperations }, null, 2)}\n`,
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
			throw new SessionAuthorityDurabilityError(this.filePath, error);
		}
	}
	protected syncDirectory(): void {
		const directory = openSync(dirname(this.filePath), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
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
