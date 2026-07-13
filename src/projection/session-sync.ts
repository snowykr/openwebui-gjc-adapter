import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { GjcSessionLoadError, loadGjcSessionFile } from "../gjc/session-loader";
import { type GjcSessionStorageLocations, resolveGjcSdkSessionRoot } from "../gjc/session-root";
import type { SessionMappingStore } from "../gjc/session-router";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import { buildProjectFolderMetadata, type RegisteredProject } from "../projects/registry";
import { projectGjcSessionToOpenWebUIChat } from "./chat-tree";
import { importProjectedSession, type ProjectedProjectReference, upsertProjectedProjectFolder } from "./importer";

export interface SyncProjectSessionsInput {
	readonly repository: OpenWebUIProjectionRepository;
	readonly ownerUserId: string;
	readonly projects: readonly RegisteredProject[];
	readonly mappings?: SessionMappingStore;
	readonly runtimeLocations?: GjcSessionStorageLocations;
}

export interface ImportedProjectSession {
	readonly projectId: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly folderId: string;
	readonly chatId: string;
	readonly messageCount: number;
}

export interface SkippedProjectSession {
	readonly projectId: string;
	readonly filePath: string;
	readonly code: string;
	readonly message: string;
}

export interface SyncedProjectFolder {
	readonly projectId: string;
	readonly folderId: string;
}

export interface SyncProjectSessionsResult {
	readonly folders: readonly SyncedProjectFolder[];
	readonly imported: readonly ImportedProjectSession[];
	readonly skipped: readonly SkippedProjectSession[];
}

export async function syncProjectSessionsToOpenWebUI(
	input: SyncProjectSessionsInput,
): Promise<SyncProjectSessionsResult> {
	const folders: SyncedProjectFolder[] = [];
	const imported: ImportedProjectSession[] = [];
	const skipped: SkippedProjectSession[] = [];

	for (const project of input.projects) {
		const projectReference = projectedProjectReference(project);
		const importedSessionIds = new Set<string>();
		const folderId = await upsertProjectedProjectFolder({
			repository: input.repository,
			ownerUserId: input.ownerUserId,
			project: projectReference,
		});
		folders.push({ projectId: project.id, folderId });

		for (const filePath of await listSessionFiles(project, input.runtimeLocations)) {
			try {
				const loaded = await loadGjcSessionFile(filePath);
				if (importedSessionIds.has(loaded.header.id)) {
					skipped.push({
						projectId: project.id,
						filePath,
						code: "duplicate_session_id",
						message: `Duplicate GJC session id ${loaded.header.id} in ${filePath}`,
					});
					continue;
				}
				importedSessionIds.add(loaded.header.id);
				const existingChatId = findMappedChatId(input.mappings, project.id, loaded.header.id);
				const projectedChat = projectGjcSessionToOpenWebUIChat({
					sessionFile: loaded.filePath,
					header: loaded.header,
					entries: loaded.entries,
				});
				const result = await importProjectedSession({
					repository: input.repository,
					ownerUserId: input.ownerUserId,
					project: projectReference,
					projectedChat: {
						...projectedChat,
						openWebUIChatId: existingChatId ?? historicalChatId(project.id, loaded.header.id),
					},
				});
				input.mappings?.upsert({
					chatId: result.chatId,
					projectId: project.id,
					sessionId: loaded.header.id,
					sessionFile: loaded.filePath,
					rawFrameCursor: 0,
					eventCursor: 0,
					operationId: "historical-import",
				});
				imported.push({
					projectId: project.id,
					sessionId: loaded.header.id,
					sessionFile: loaded.filePath,
					folderId: result.folderId,
					chatId: result.chatId,
					messageCount: result.messageIds.length,
				});
			} catch (error) {
				const narrowedError = error instanceof Error ? error : new Error("Unknown session import failure");
				if (!(narrowedError instanceof GjcSessionLoadError)) throw narrowedError;
				skipped.push(skippedSession(project.id, filePath, narrowedError));
			}
		}
	}

	return { folders, imported, skipped };
}

function projectedProjectReference(project: RegisteredProject): ProjectedProjectReference {
	return {
		id: project.id,
		name: project.openWebUIFolderName ?? project.name,
		...(project.openWebUIFolderId === undefined ? {} : { folderId: project.openWebUIFolderId }),
		metadata: { ...buildProjectFolderMetadata(project) },
	};
}

function historicalChatId(projectId: string, sessionId: string): string {
	return `gjc-project-${projectId}-session-${sessionId}`;
}

async function listSessionFiles(
	project: RegisteredProject,
	runtimeLocations: GjcSessionStorageLocations | undefined,
): Promise<readonly string[]> {
	const configuredRoot = project.sessionRoot ?? path.join(project.cwd, ".gjc", "sessions");
	const sessionRoots = [
		...(runtimeLocations === undefined ? [] : [resolveGjcSdkSessionRoot(project.cwd, runtimeLocations)]),
		configuredRoot,
	].filter((root, index, roots) => roots.indexOf(root) === index);
	const files: string[] = [];
	for (const sessionRoot of sessionRoots) files.push(...(await listRootSessionFiles(sessionRoot)));
	return files;
}

async function listRootSessionFiles(sessionRoot: string): Promise<readonly string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(sessionRoot, { withFileTypes: true });
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw error;
	}
	return entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map(entry => path.join(sessionRoot, entry.name))
		.sort();
}

function findMappedChatId(
	mappings: SessionMappingStore | undefined,
	projectId: string,
	sessionId: string,
): string | undefined {
	const entries = mappings
		?.entries()
		.filter(mapping => mapping.projectId === projectId && mapping.sessionId === sessionId);
	if (entries === undefined || entries.length === 0) return undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const mapping = entries[index];
		if (mapping?.operationId === "historical-import") return mapping.chatId;
	}
	return entries[entries.length - 1]?.chatId;
}

function skippedSession(projectId: string, filePath: string, error: unknown): SkippedProjectSession {
	if (error instanceof GjcSessionLoadError) {
		const diagnostic = error.diagnostics[0];
		return {
			projectId,
			filePath,
			code: diagnostic?.code ?? "session_load_error",
			message: diagnostic?.message ?? error.message,
		};
	}
	const message = error instanceof Error ? error.message : "Unknown session import failure.";
	return { projectId, filePath, code: "session_import_error", message };
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
