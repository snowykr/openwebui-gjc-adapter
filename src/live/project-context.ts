import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenWebUIProjectionRepository } from "../openwebui/client";
import type { RegisteredProject } from "../projects/registry";
import { classifyGjcModelId } from "./models";

export const GJC_OPENWEBUI_MODEL_ID = "gjc";
export const DEFAULT_NEUTRAL_WORKSPACE = path.join(os.homedir(), ".gjc", "openwebui", "workspace");

export type LiveProjectContextResult =
	| { readonly ok: true; readonly project: RegisteredProject }
	| {
			readonly ok: false;
			readonly code: "model_not_found" | "neutral_workspace_unavailable";
			readonly message: string;
	  };

export interface ResolveLiveProjectContextInput {
	readonly projects: readonly RegisteredProject[];
	readonly modelId: string;
	readonly ownerUserId: string;
	readonly chatId: string;
	readonly repository?: OpenWebUIProjectionRepository;
	readonly neutralWorkspace?: string;
	readonly now?: Date;
}

export async function resolveLiveProjectContext(
	input: ResolveLiveProjectContextInput,
): Promise<LiveProjectContextResult> {
	if (!isGjcOpenWebUIModelId(input.modelId)) {
		return { ok: false, code: "model_not_found", message: `Unknown GJC model: ${input.modelId}` };
	}

	const folderProject = await findProjectByOpenWebUIChatFolder(input);
	if (folderProject !== null) return { ok: true, project: folderProject };

	try {
		return {
			ok: true,
			project: await neutralProject(input.neutralWorkspace ?? DEFAULT_NEUTRAL_WORKSPACE, input.now ?? new Date()),
		};
	} catch {
		return {
			ok: false,
			code: "neutral_workspace_unavailable",
			message: "Adapter neutral workspace could not be prepared.",
		};
	}
}

export function isGjcOpenWebUIModelId(modelId: string): boolean {
	const classified = classifyGjcModelId(modelId);
	return classified.kind === "alias" || classified.kind === "canonical";
}

async function findProjectByOpenWebUIChatFolder(
	input: ResolveLiveProjectContextInput,
): Promise<RegisteredProject | null> {
	const chat = await input.repository?.getChat(input.ownerUserId, input.chatId);
	if (chat === undefined || chat.folder_id.length === 0) return null;
	return input.projects.find(project => projectOpenWebUIFolderIds(project).includes(chat.folder_id)) ?? null;
}

function projectOpenWebUIFolderIds(project: RegisteredProject): readonly string[] {
	const defaultFolderId = `gjc-project-${project.id}`;
	if (project.openWebUIFolderId === undefined) return [defaultFolderId];
	return [project.openWebUIFolderId, defaultFolderId];
}

async function neutralProject(workspace: string, now: Date): Promise<RegisteredProject> {
	const cwd = path.resolve(workspace);
	const sessionRoot = path.join(cwd, ".gjc", "sessions");
	await mkdir(sessionRoot, { recursive: true });
	return {
		id: "openwebui",
		name: "OpenWebUI",
		openWebUIFolderName: "OpenWebUI",
		cwd,
		allowedRoot: cwd,
		sessionRoot,
		createdAt: new Date(now),
	};
}
