import { FileSessionAuthority } from "./session-authority";
import {
	preflightSessionAuthorityMigration,
	SessionAuthorityMigrationError,
	type SessionAuthorityMigrationRequest,
} from "./session-authority-migration";
import type { SessionAuthorityMigrationResult } from "./session-authority-types";
import { SessionMappingStore } from "./session-mapping-memory-store";

export type FileBackedSessionMappingStoreOptions = Omit<SessionAuthorityMigrationRequest, "sourcePath">;

export class FileBackedSessionMappingStore extends SessionMappingStore {
	readonly migrationResult?: SessionAuthorityMigrationResult;

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
		super(new FileSessionAuthority(filePath));
		this.migrationResult = migration;
	}
}
