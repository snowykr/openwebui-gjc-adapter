import type { RegisteredProject } from "../projects/registry";
import type { OpenAIModelListResponse } from "./openai-types";

export const GJC_MODEL_ID = "gjc";

export function buildModelList(): OpenAIModelListResponse {
	return {
		object: "list",
		data: [
			{
				id: GJC_MODEL_ID,
				object: "model",
				created: 0,
				owned_by: "gjc",
			},
		],
	};
}

export function findProjectByModelId(
	projects: readonly RegisteredProject[],
	modelId: string,
): RegisteredProject | null {
	return modelId === GJC_MODEL_ID ? (projects[0] ?? null) : null;
}
