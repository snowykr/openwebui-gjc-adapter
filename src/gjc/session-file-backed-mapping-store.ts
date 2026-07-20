import { FileSessionAuthority } from "./session-authority";
import { SessionMappingStore } from "./session-mapping-memory-store";

export class FileBackedSessionMappingStore extends SessionMappingStore {
	constructor(filePath: string) {
		super(new FileSessionAuthority(filePath));
	}
}
