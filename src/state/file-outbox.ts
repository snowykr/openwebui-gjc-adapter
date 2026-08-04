import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createOperationId } from "./metadata";
import {
	assertSameEnqueueIdentity,
	canonicalProjectionOperationKey,
	copyOperation,
	type EnqueueProjectionOperationInput,
	normalizeProjectionPrincipalId,
	OUTBOX_DOCUMENT_VERSION,
	type OutboxFileSystem,
	type OutboxStore,
	type ProjectionOperation,
	type ProjectionOperationReference,
	parsePersistedOutboxDocument,
	toTimestamp,
} from "./outbox-types";

export const nodeOutboxFileSystem: OutboxFileSystem = {
	exists: existsSync,
	lstat: lstatSync,
	mkdir: mkdirSync,
	open: openSync,
	readFile: readFileSync,
	writeFile: writeFileSync,
	fsync: fsyncSync,
	close: closeSync,
	rename: renameSync,
	rm: rmSync,
};

export class FileBackedOutboxStore implements OutboxStore {
	private operations = new Map<string, ProjectionOperation>();

	constructor(
		private readonly filePath: string,
		private readonly fileSystem: OutboxFileSystem = nodeOutboxFileSystem,
	) {
		this.load();
	}

	enqueue(input: EnqueueProjectionOperationInput): ProjectionOperation {
		const operationId = input.operationId ?? createOperationId(`projection-${input.kind}`, input.now);
		const principalId = normalizeProjectionPrincipalId(input.principalId);
		const key = canonicalProjectionOperationKey(principalId, input.chatId, operationId);
		const normalizedInput =
			principalId === input.principalId
				? input
				: { ...input, ...(principalId === undefined ? {} : { principalId }) };
		const existing = this.operations.get(key);
		if (existing !== undefined) {
			assertSameEnqueueIdentity(existing, normalizedInput);
			return copyOperation(existing);
		}

		const timestamp = toTimestamp(input.now);
		const operation: ProjectionOperation = {
			operationId,
			...(principalId === undefined ? {} : { principalId }),
			ownerUserId: input.ownerUserId,
			projectId: input.projectId,
			chatId: input.chatId,
			kind: input.kind,
			state: "pending",
			payloadHash: input.payloadHash,
			attempts: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const candidate = this.copyOperations();
		candidate.set(key, operation);
		this.persist(candidate);
		this.operations = candidate;
		return copyOperation(operation);
	}

	markApplying(reference: ProjectionOperationReference, now?: Date): ProjectionOperation {
		return this.update(reference, now, operation => ({
			...operation,
			state: "applying",
			attempts: operation.attempts + 1,
			lastError: undefined,
		}));
	}

	markApplied(reference: ProjectionOperationReference, now?: Date): ProjectionOperation {
		return this.update(reference, now, operation => ({
			...operation,
			state: "applied",
			lastError: undefined,
		}));
	}

	markFailed(reference: ProjectionOperationReference, error: string, now?: Date): ProjectionOperation {
		return this.update(reference, now, operation => ({
			...operation,
			state: "failed",
			lastError: error,
		}));
	}

	markReconcile(reference: ProjectionOperationReference, now?: Date): ProjectionOperation {
		return this.update(reference, now, operation => ({ ...operation, state: "reconcile" }));
	}

	listPending(): ProjectionOperation[] {
		return Array.from(this.operations.values())
			.filter(operation => operation.state === "pending" || operation.state === "reconcile")
			.map(copyOperation);
	}

	listApplying(): ProjectionOperation[] {
		return Array.from(this.operations.values())
			.filter(operation => operation.state === "applying")
			.map(copyOperation);
	}

	get(reference: ProjectionOperationReference): ProjectionOperation | undefined {
		const key = this.resolveKey(reference);
		if (key === undefined) return undefined;
		const operation = this.operations.get(key);
		return operation === undefined ? undefined : copyOperation(operation);
	}

	private update(
		reference: ProjectionOperationReference,
		now: Date | undefined,
		change: (operation: ProjectionOperation) => ProjectionOperation,
	): ProjectionOperation {
		const key = this.resolveKey(reference);
		const operation = this.requireOperation(reference, key);
		if (key === undefined) throw new Error("Unknown projection operation");
		const updated = {
			...change(operation),
			updatedAt: toTimestamp(now),
		};
		const candidate = this.copyOperations();
		candidate.set(key, updated);
		this.persist(candidate);
		this.operations = candidate;
		return copyOperation(updated);
	}

	private requireOperation(
		reference: ProjectionOperationReference,
		key = this.resolveKey(reference),
	): ProjectionOperation {
		const operation = key === undefined ? undefined : this.operations.get(key);
		if (operation === undefined) {
			const operationId = typeof reference === "string" ? reference : reference.operationId;
			throw new Error(`Unknown projection operation: ${operationId}`);
		}
		return operation;
	}

	private resolveKey(reference: ProjectionOperationReference): string | undefined {
		if (typeof reference !== "string") {
			const principalId = normalizeProjectionPrincipalId(reference.principalId);
			return canonicalProjectionOperationKey(principalId, reference.chatId, reference.operationId);
		}
		const matches = Array.from(this.operations.entries()).filter(
			([, operation]) => operation.operationId === reference,
		);
		if (matches.length > 1) throw new Error(`Projection operation ID is ambiguous: ${reference}`);
		return matches[0]?.[0];
	}

	private copyOperations(): Map<string, ProjectionOperation> {
		return new Map(
			Array.from(this.operations, ([operationId, operation]) => [operationId, copyOperation(operation)]),
		);
	}

	private load(): void {
		if (!this.fileSystem.exists(this.filePath)) return;
		assertRegularFile(this.fileSystem, this.filePath);
		const document = parsePersistedOutboxDocument(this.fileSystem.readFile(this.filePath, "utf8"));
		this.operations = new Map(
			document.operations.map(operation => [
				canonicalProjectionOperationKey(operation.principalId, operation.chatId, operation.operationId),
				copyOperation(operation),
			]),
		);
	}

	private persist(operations: ReadonlyMap<string, ProjectionOperation>): void {
		const directory = dirname(this.filePath);
		this.fileSystem.mkdir(directory, { recursive: true });
		assertDirectory(this.fileSystem, directory);
		if (this.fileSystem.exists(this.filePath)) {
			assertRegularFile(this.fileSystem, this.filePath);
		}

		const tempPath = join(directory, `.${createOperationId("outbox")}.tmp`);
		let tempFileDescriptor: number | undefined;
		let renamed = false;
		try {
			tempFileDescriptor = this.fileSystem.open(tempPath, "wx", 0o600);
			this.fileSystem.writeFile(
				tempFileDescriptor,
				JSON.stringify({ version: OUTBOX_DOCUMENT_VERSION, operations: Array.from(operations.values()) }, null, 2),
			);
			this.fileSystem.fsync(tempFileDescriptor);
			this.fileSystem.close(tempFileDescriptor);
			tempFileDescriptor = undefined;
			this.fileSystem.rename(tempPath, this.filePath);
			renamed = true;
			this.fsyncDirectory(directory);
		} finally {
			if (tempFileDescriptor !== undefined) {
				this.fileSystem.close(tempFileDescriptor);
			}
			if (!renamed) {
				this.fileSystem.rm(tempPath, { force: true });
			}
		}
	}

	private fsyncDirectory(directory: string): void {
		const directoryDescriptor = this.fileSystem.open(directory, "r");
		try {
			this.fileSystem.fsync(directoryDescriptor);
		} finally {
			this.fileSystem.close(directoryDescriptor);
		}
	}
}

function assertRegularFile(fileSystem: OutboxFileSystem, path: string): void {
	const stat = fileSystem.lstat(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Outbox path must be a regular file: ${path}`);
	}
}

function assertDirectory(fileSystem: OutboxFileSystem, path: string): void {
	const stat = fileSystem.lstat(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Outbox directory must be a directory: ${path}`);
	}
}
