import type { SessionEntry, SessionHeader } from "@gajae-code/coding-agent";

export type GjcSessionLoadDiagnosticCode =
	| "missing_session_header"
	| "invalid_session_header"
	| "empty_session_file"
	| "corrupt_session_file";

export interface GjcSessionLoadDiagnostic {
	code: GjcSessionLoadDiagnosticCode;
	message: string;
	filePath: string;
}

export interface LoadedGjcSessionFile {
	filePath: string;
	header: SessionHeader;
	entries: SessionEntry[];
	diagnostics: GjcSessionLoadDiagnostic[];
}

export class GjcSessionLoadError extends Error {
	readonly filePath: string;
	readonly diagnostics: GjcSessionLoadDiagnostic[];
	readonly cause: unknown;

	constructor(filePath: string, diagnostics: GjcSessionLoadDiagnostic[], cause?: unknown) {
		super(
			diagnostics.map(diagnostic => diagnostic.message).join("; ") || `Failed to load GJC session file: ${filePath}`,
		);
		this.name = "GjcSessionLoadError";
		this.filePath = filePath;
		this.diagnostics = diagnostics;
		this.cause = cause;
	}
}
