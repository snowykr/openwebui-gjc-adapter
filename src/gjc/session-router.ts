import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { RegisteredProject } from "../projects/registry";
import { type GjcTurnEvent, type GjcTurnRunner, getProjectSessionRoot } from "./rpc-runner";

export interface SessionMapping {
	readonly chatId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly activeLeaf?: string;
	readonly rawFrameCursor: number;
	readonly eventCursor: number;
	readonly operationId: string;
	readonly assistantText?: string;
	readonly events?: readonly GjcTurnEvent[];
}

export class SessionMappingStore {
	readonly #mappings = new Map<string, SessionMapping>();

	get(chatId: string): SessionMapping | undefined {
		const mapping = this.#mappings.get(chatId);
		return mapping === undefined ? undefined : copySessionMapping(mapping);
	}

	set(mapping: SessionMapping): SessionMapping {
		this.#mappings.set(mapping.chatId, copySessionMapping(mapping));
		return copySessionMapping(mapping);
	}

	upsert(mapping: SessionMapping): SessionMapping {
		const current = this.#mappings.get(mapping.chatId);
		const next = current === undefined ? mapping : { ...current, ...mapping };
		this.#mappings.set(mapping.chatId, copySessionMapping(next));
		return copySessionMapping(next);
	}

	entries(): readonly SessionMapping[] {
		return [...this.#mappings.values()].map(copySessionMapping);
	}
}

export class FileBackedSessionMappingStore extends SessionMappingStore {
	constructor(private readonly filePath: string) {
		super();
		this.load();
	}

	override set(mapping: SessionMapping): SessionMapping {
		const next = super.set(mapping);
		this.persist();
		return next;
	}

	override upsert(mapping: SessionMapping): SessionMapping {
		const next = super.upsert(mapping);
		this.persist();
		return next;
	}

	private load(): void {
		if (!existsSync(this.filePath)) return;
		const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
			readonly mappings?: readonly SessionMapping[];
		};
		for (const mapping of parsed.mappings ?? []) {
			super.set(mapping);
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify({ mappings: this.entries() }, null, 2));
	}
}

export interface RouteGjcTurnInput {
	readonly project: RegisteredProject;
	readonly chatId: string;
	readonly userMessageId: string;
	readonly parentId?: string;
	readonly text: string;
	readonly runner: GjcTurnRunner;
	readonly mappings: SessionMappingStore;
}

export interface RouteGjcTurnResult {
	readonly assistantText: string;
	readonly events: readonly GjcTurnEvent[];
	readonly mapping: SessionMapping;
}

export async function routeGjcTurn(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	const existing = input.mappings.get(input.chatId);
	if (existing?.operationId === input.userMessageId) {
		return {
			assistantText: existing.assistantText ?? "",
			events: existing.events ?? [],
			mapping: existing,
		};
	}

	if (existing === undefined || existing.projectId !== input.project.id) {
		return startNewMappedSession(input);
	}

	const sessionRoot = getProjectSessionRoot(input.project);
	const existingSessionFile = validateSessionFile(input.project, existing.sessionFile);
	const address = {
		cwd: input.project.cwd,
		sessionRoot,
		projectId: input.project.id,
		sessionId: existing.sessionId,
		chatId: input.chatId,
	};

	await input.runner.switchSession({
		...address,
		sessionFile: existingSessionFile,
	});
	const state = await input.runner.getState({
		...address,
		sessionFile: existingSessionFile,
	});
	const result = await input.runner.continueSession({
		...address,
		userMessageId: input.userMessageId,
		parentId: input.parentId,
		text: input.text,
		activeLeaf: state.activeLeaf,
		rawFrameCursor: state.rawFrameCursor,
		eventCursor: state.eventCursor,
		operationId: input.userMessageId,
	});
	const mapping = input.mappings.upsert({
		chatId: input.chatId,
		projectId: input.project.id,
		sessionId: existing.sessionId,
		sessionFile: firstDefinedValidSessionFile(
			input.project,
			result.sessionFile,
			state.sessionFile,
			existingSessionFile,
		),
		activeLeaf: result.activeLeaf ?? state.activeLeaf,
		rawFrameCursor: result.rawFrameCursor,
		eventCursor: result.eventCursor,
		operationId: input.userMessageId,
		assistantText: result.text,
		events: result.events,
	});

	return {
		assistantText: result.text,
		events: result.events,
		mapping,
	};
}

async function startNewMappedSession(input: RouteGjcTurnInput): Promise<RouteGjcTurnResult> {
	const result = await input.runner.startNewSession({
		cwd: input.project.cwd,
		sessionRoot: getProjectSessionRoot(input.project),
		projectId: input.project.id,
		chatId: input.chatId,
		userMessageId: input.userMessageId,
		parentId: input.parentId,
		text: input.text,
	});
	const mapping = input.mappings.upsert({
		chatId: input.chatId,
		projectId: input.project.id,
		sessionId: result.sessionId,
		sessionFile: validateSessionFile(input.project, result.sessionFile),
		activeLeaf: result.activeLeaf,
		rawFrameCursor: result.rawFrameCursor,
		eventCursor: result.eventCursor,
		operationId: input.userMessageId,
		assistantText: result.text,
		events: result.events,
	});

	return {
		assistantText: result.text,
		events: result.events,
		mapping,
	};
}

function firstDefinedValidSessionFile(
	project: RegisteredProject,
	...sessionFiles: readonly (string | undefined)[]
): string | undefined {
	for (const sessionFile of sessionFiles) {
		if (sessionFile !== undefined) return validateSessionFile(project, sessionFile);
	}
	return undefined;
}

export function validateSessionFile(project: RegisteredProject, sessionFile: string | undefined): string | undefined {
	if (sessionFile === undefined) return undefined;
	const sessionRoot = getProjectSessionRoot(project);
	const resolvedSessionRoot = resolveExistingOrProspectivePath(sessionRoot);
	const resolvedSessionFile = resolveExistingOrProspectivePath(sessionFile);
	if (!isPathInsideRoot(resolvedSessionFile, resolvedSessionRoot)) {
		throw new Error(`Stored GJC session file is outside project session root: ${sessionFile}`);
	}
	return resolvedSessionFile;
}

function resolveExistingOrProspectivePath(targetPath: string): string {
	const absoluteTargetPath = resolve(targetPath);
	try {
		return realpathSync(absoluteTargetPath);
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}

	const segments = splitAbsolutePath(absoluteTargetPath);
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const parentCandidate = resolve(...segments.slice(0, index + 1));
		try {
			const realParent = realpathSync(parentCandidate);
			return resolve(realParent, ...segments.slice(index + 1));
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
		}
	}
	throw new Error(`No existing parent found for path: ${targetPath}`);
}

function splitAbsolutePath(absolutePath: string): string[] {
	const parsedPath = parse(absolutePath);
	const relativePath = relative(parsedPath.root, absolutePath);
	return [parsedPath.root, ...relativePath.split(sep).filter(segment => segment.length > 0)];
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
	const relativePath = relative(rootPath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function copySessionMapping(mapping: SessionMapping): SessionMapping {
	return {
		...mapping,
		events: mapping.events === undefined ? undefined : [...mapping.events],
	};
}
