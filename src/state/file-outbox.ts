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
	copyOperation,
	type EnqueueProjectionOperationInput,
	OUTBOX_DOCUMENT_VERSION,
	type OutboxFileSystem,
	type OutboxStore,
	type ProjectionOperation,
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
		const existing = this.operations.get(operationId);
		if (existing !== undefined) {
			assertSameEnqueueIdentity(existing, input);
			return copyOperation(existing);
		}

		const timestamp = toTimestamp(input.now);
		const operation: ProjectionOperation = {
			operationId,
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
		candidate.set(operationId, operation);
		this.persist(candidate);
		this.operations = candidate;
		return copyOperation(operation);
	}

	markApplying(operationId: string, now?: Date): ProjectionOperation {
		return this.update(operationId, now, operation => ({
			...operation,
			state: "applying",
			attempts: operation.attempts + 1,
			lastError: undefined,
		}));
	}

	markApplied(operationId: string, now?: Date): ProjectionOperation {
		return this.update(operationId, now, operation => ({
			...operation,
			state: "applied",
			lastError: undefined,
		}));
	}

	markFailed(operationId: string, error: string, now?: Date): ProjectionOperation {
		return this.update(operationId, now, operation => ({
			...operation,
			state: "failed",
			lastError: error,
		}));
	}

	markReconcile(operationId: string, now?: Date): ProjectionOperation {
		return this.update(operationId, now, operation => ({ ...operation, state: "reconcile" }));
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

	get(operationId: string): ProjectionOperation | undefined {
		const operation = this.operations.get(operationId);
		return operation === undefined ? undefined : copyOperation(operation);
	}

	private update(
		operationId: string,
		now: Date | undefined,
		change: (operation: ProjectionOperation) => ProjectionOperation,
	): ProjectionOperation {
		const operation = this.requireOperation(operationId);
		const updated = {
			...change(operation),
			updatedAt: toTimestamp(now),
		};
		const candidate = this.copyOperations();
		candidate.set(operationId, updated);
		this.persist(candidate);
		this.operations = candidate;
		return copyOperation(updated);
	}

	private requireOperation(operationId: string): ProjectionOperation {
		const operation = this.operations.get(operationId);
		if (operation === undefined) {
			throw new Error(`Unknown projection operation: ${operationId}`);
		}
		return operation;
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
			document.operations.map(operation => [operation.operationId, copyOperation(operation)]),
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
