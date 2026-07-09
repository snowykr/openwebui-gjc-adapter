import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedOpenWebUIFileContext } from "../live/chat-file-context-format";
import type { LiveGatewayFileContextResolver } from "../live/file-contexts";
import type { RegisteredProject } from "../projects/registry";
import type { OpenWebUIFileBytes, OpenWebUIFileContent } from "./client";

const ATTACHMENT_CACHE_DIRECTORY = ".gjc/openwebui-attachments";
const MAX_SEGMENT_LENGTH = 80;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface OpenWebUIFileContextClient {
	getFileContent(fileId: string): Promise<OpenWebUIFileContent | undefined>;
	getFileBytes(fileId: string): Promise<OpenWebUIFileBytes | undefined>;
}

export function createOpenWebUIFileContextResolver(client: OpenWebUIFileContextClient): LiveGatewayFileContextResolver {
	return async input => {
		const [metadata, original] = await Promise.all([
			client.getFileContent(input.reference.id),
			client.getFileBytes(input.reference.id),
		]);
		if (metadata === undefined && original === undefined) return undefined;
		const localPath =
			original === undefined
				? undefined
				: await materializeOpenWebUIFile({
						project: input.project,
						chatId: input.chatId,
						userMessageId: input.userMessageId,
						fileId: input.reference.id,
						filename: metadata?.filename ?? input.reference.name,
						contentType: original.contentType ?? input.reference.type,
						bytes: original.bytes,
					});
		return resolvedFileContext({ referenceId: input.reference.id, metadata, original, localPath });
	};
}

async function materializeOpenWebUIFile(input: {
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly fileId: string;
	readonly filename?: string;
	readonly contentType?: string;
	readonly bytes: Uint8Array;
}): Promise<string> {
	const projectRoot = await realpath(input.project.cwd);
	const gjcDirectory = path.join(projectRoot, ".gjc");
	const cacheRoot = path.join(projectRoot, ATTACHMENT_CACHE_DIRECTORY);
	await ensurePrivateDirectoryInsideProject(projectRoot, gjcDirectory);
	await ensurePrivateDirectoryInsideProject(projectRoot, cacheRoot);
	const chatDirectory = path.join(cacheRoot, pathSegment(input.chatId, "chat"));
	await ensurePrivateDirectoryInsideProject(projectRoot, chatDirectory);
	const targetDirectory = path.resolve(chatDirectory, pathSegment(input.userMessageId, "message"));
	await ensurePrivateDirectoryInsideProject(projectRoot, targetDirectory);
	const filename = `${pathSegment(input.fileId, "file")}${attachmentExtension(input.filename, input.contentType)}`;
	const realTargetDirectory = await realpath(targetDirectory);
	assertInsideProject(projectRoot, realTargetDirectory);
	const targetPath = path.join(realTargetDirectory, filename);
	assertInsideProject(projectRoot, targetPath);
	await writePrivateNewFile(targetPath, input.bytes);
	return targetPath;
}

function resolvedFileContext(input: {
	readonly referenceId: string;
	readonly metadata?: OpenWebUIFileContent;
	readonly original?: OpenWebUIFileBytes;
	readonly localPath?: string;
}): ResolvedOpenWebUIFileContext {
	const id = input.metadata?.id ?? input.original?.id ?? input.referenceId;
	return {
		id,
		...(input.metadata?.filename === undefined ? {} : { filename: input.metadata.filename }),
		...(input.localPath === undefined ? {} : { localPath: input.localPath }),
		...(input.metadata?.content === undefined ? {} : { content: input.metadata.content }),
	};
}

function pathSegment(value: string, fallback: string): string {
	const sanitized = value
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, MAX_SEGMENT_LENGTH);
	return sanitized.length === 0 ? fallback : sanitized;
}

function attachmentExtension(filename: string | undefined, contentType: string | undefined): string {
	const filenameExtension = filename === undefined ? "" : path.extname(filename).toLowerCase();
	if (/^\.[a-z0-9]{1,12}$/.test(filenameExtension)) return filenameExtension;
	const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
	switch (normalizedContentType) {
		case "application/pdf":
			return ".pdf";
		case "image/jpeg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "text/plain":
			return ".txt";
		default:
			return ".bin";
	}
}

function assertInsideProject(projectRoot: string, targetPath: string): void {
	const relative = path.relative(projectRoot, targetPath);
	if (relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new Error("OpenWebUI attachment target escapes project root.");
}

async function ensurePrivateDirectoryInsideProject(projectRoot: string, directoryPath: string): Promise<void> {
	assertInsideProject(projectRoot, directoryPath);
	try {
		const directoryStat = await lstat(directoryPath);
		if (directoryStat.isSymbolicLink()) throw new Error("OpenWebUI attachment cache uses a symbolic link.");
		if (!directoryStat.isDirectory()) throw new Error("OpenWebUI attachment cache path is not a directory.");
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		await mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE });
	}
	const realDirectory = await realpath(directoryPath);
	assertInsideProject(projectRoot, realDirectory);
	await chmod(realDirectory, PRIVATE_DIRECTORY_MODE);
}

async function writePrivateNewFile(targetPath: string, bytes: Uint8Array): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			targetPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			PRIVATE_FILE_MODE,
		);
		const targetStat = await handle.stat();
		if (!targetStat.isFile() || targetStat.nlink !== 1) {
			throw new Error("OpenWebUI attachment target is not a private regular file.");
		}
		await handle.writeFile(bytes);
		await handle.chmod(PRIVATE_FILE_MODE);
	} catch (error) {
		if (!isExistingPathError(error)) throw error;
		await assertExistingPrivateFileMatches(targetPath, bytes);
	} finally {
		await handle?.close();
	}
}

async function assertExistingPrivateFileMatches(targetPath: string, bytes: Uint8Array): Promise<void> {
	const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const targetStat = await handle.stat();
		if (!targetStat.isFile() || targetStat.nlink !== 1) {
			throw new Error("OpenWebUI attachment target is not a private regular file.");
		}
		const existing = await handle.readFile();
		if (!byteArraysEqual(existing, bytes)) {
			throw new Error("OpenWebUI attachment target already exists with different content.");
		}
		await handle.chmod(PRIVATE_FILE_MODE);
	} finally {
		await handle.close();
	}
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function isExistingPathError(error: unknown): boolean {
	return errorCode(error) === "EEXIST";
}

function isMissingPathError(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	return Object.getOwnPropertyDescriptor(error, "code")?.value;
}
