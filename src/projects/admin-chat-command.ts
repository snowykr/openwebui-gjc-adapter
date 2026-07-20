import type { OpenAIChatCompletionRequest } from "../live/openai-types";
import { ProjectLinkError } from "./project-admission";
import type { ProjectLinkService } from "./link-service";

export async function executeProjectCommand(service: ProjectLinkService, command: string): Promise<string> {
	if (command === "/gjc project list") {
		await service.reconcileOpenWebUIFolderLinks();
		const projects = service.listProjects();
		if (projects.length === 0) return "No GJC projects are linked.";
		return projects.map(project => `${project.status}: ${project.id} ${project.cwd}`).join("\n");
	}
	const linkPrefix = "/gjc project link ";
	if (command.startsWith(linkPrefix)) {
		const cwd = command.slice(linkPrefix.length).trim();
		const result = await service.linkProject({ cwd });
		return `Linked ${result.project.id}. Imported ${result.sync.imported.length} session(s).`;
	}
	const unlinkPrefix = "/gjc project unlink ";
	if (command.startsWith(unlinkPrefix)) {
		const projectId = command.slice(unlinkPrefix.length).trim();
		const result = await service.unlinkProject(projectId);
		const closeSummary =
			result.closeResults.length === 0
				? "No mapped chat sessions required closing."
				: result.closeResults.map(close => `${close.chatId}: ${close.result.status}`).join(", ");
		return `Unlinked ${result.project.id}. ${closeSummary} Local GJC files were left untouched.`;
	}
	throw new ProjectLinkError(
		"Supported commands: /gjc project list, /gjc project link <path>, /gjc project unlink <id>.",
		"invalid_project_command",
	);
}

export function latestUserText(request: OpenAIChatCompletionRequest): string | undefined {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("")
				.trim();
		}
	}
	return undefined;
}
