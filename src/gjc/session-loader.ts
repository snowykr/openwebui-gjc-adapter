import type { SessionEntry, SessionHeader } from "@gajae-code/coding-agent";
import { loadEntriesFromFile } from "@gajae-code/coding-agent/session/session-manager";

export type GjcSessionLoadDiagnosticCode = "missing_session_header" | "empty_session_file" | "corrupt_session_file";

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

export async function loadGjcSessionFile(filePath: string): Promise<LoadedGjcSessionFile> {
	try {
		const fileEntries = await loadEntriesFromFile(filePath);
		if (fileEntries.length === 0) {
			throw new GjcSessionLoadError(filePath, [
				{
					code: "empty_session_file",
					message: `No valid GJC session entries found in ${filePath}`,
					filePath,
				},
			]);
		}

		const [firstEntry] = fileEntries;
		const sessionEntries = fileEntries.slice(1) as SessionEntry[];
		if (firstEntry.type !== "session") {
			throw new GjcSessionLoadError(filePath, [
				{
					code: "missing_session_header",
					message: `GJC session file ${filePath} does not start with a session header`,
					filePath,
				},
			]);
		}

		return {
			filePath,
			header: firstEntry,
			entries: sessionEntries,
			diagnostics: [],
		};
	} catch (error) {
		if (error instanceof GjcSessionLoadError) throw error;
		throw new GjcSessionLoadError(
			filePath,
			[
				{
					code: "corrupt_session_file",
					message: `Failed to load GJC session file ${filePath}`,
					filePath,
				},
			],
			error,
		);
	}
}
