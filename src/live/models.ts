import type { RegisteredProject } from "../projects/registry";
import type { OpenAIModelEntry, OpenAIModelListResponse } from "./openai-types";

export type LiveGatewayModelEntry = OpenAIModelEntry;

export function buildModelList(
	input: readonly RegisteredProject[] | readonly LiveGatewayModelEntry[],
): OpenAIModelListResponse {
	return {
		object: "list",
		data: input.map(entry => (isRegisteredProject(entry) ? modelFromProject(entry) : entry)),
	};
}

export function findProjectByModelId(
	projects: readonly RegisteredProject[],
	modelId: string,
): RegisteredProject | null {
	return projects.find(project => project.modelId === modelId) ?? null;
}

function modelFromProject(project: RegisteredProject): OpenAIModelEntry {
	return {
		id: project.modelId,
		object: "model",
		created: Math.floor(project.createdAt.getTime() / 1000),
		owned_by: "gjc",
	};
}

function isRegisteredProject(entry: RegisteredProject | LiveGatewayModelEntry): entry is RegisteredProject {
	return "modelId" in entry;
}
