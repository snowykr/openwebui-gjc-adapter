import { statSync } from "node:fs";
import { FileSessionAuthority } from "./session-authority";
import {
	preflightSessionAuthorityMigration,
	SessionAuthorityMigrationError,
	type SessionAuthorityMigrationRequest,
} from "./session-authority-migration";
import type {
	ProvisionalSessionOperation,
	SessionAuthorityMigrationResult,
	SessionAuthorityRecord,
} from "./session-authority-types";
import { SessionMappingStore } from "./session-mapping-memory-store";

export type FileBackedSessionMappingStoreOptions = Omit<SessionAuthorityMigrationRequest, "sourcePath">;
type AuthorityState = {
	readonly records: readonly SessionAuthorityRecord[];
	readonly provisional: readonly ProvisionalSessionOperation[];
};

type AuthorityStateMutation = (
	records: readonly SessionAuthorityRecord[],
	provisional: readonly ProvisionalSessionOperation[],
) => AuthorityState;

class RetirableFileSessionAuthority extends FileSessionAuthority {
	replaceAuthorityState(mutation: AuthorityStateMutation): void {
		this.mutate(() => {
			const next = mutation(this.entries(), this.provisionalEntries());
			this.replaceAll(next.records, next.provisional);
		});
	}
	get capturedBootCompaction(): { readonly beforeBytes: number } | undefined {
		const beforeBytes = this.bootCompactionBeforeBytes;
		return beforeBytes === undefined ? undefined : { beforeBytes };
	}
}

export class FileBackedSessionMappingStore extends SessionMappingStore {
	readonly migrationResult?: SessionAuthorityMigrationResult;
	readonly bootCompaction?: { readonly beforeBytes: number; readonly afterBytes: number };

	protected override mutateAuthorityState(mutation: AuthorityStateMutation): void {
		const authority = this.authority;
		if (!(authority instanceof RetirableFileSessionAuthority))
			throw new Error("File-backed session mapping retirement requires a durable authority.");
		authority.replaceAuthorityState(mutation);
	}
	constructor(filePath: string, options?: FileBackedSessionMappingStoreOptions) {
		const migration =
			options === undefined
				? undefined
				: preflightSessionAuthorityMigration({
						...options,
						sourcePath: filePath,
					});
		if (migration?.status === "degraded")
			throw new SessionAuthorityMigrationError(
				`Session authority migration degraded for ${filePath}; refusing to open the authority store.`,
				migration,
			);
		const authority = new RetirableFileSessionAuthority(filePath);
		super(authority);
		this.migrationResult = migration;
		const captured = authority.capturedBootCompaction;
		if (captured !== undefined) {
			const stat = statSync(filePath);
			this.bootCompaction = { beforeBytes: captured.beforeBytes, afterBytes: stat.size };
		}
	}
}
