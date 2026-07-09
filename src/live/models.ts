import type { OpenAIModelEntry, OpenAIModelListResponse } from "./openai-types";
import { GJC_OPENWEBUI_MODEL_ID } from "./project-context";

export type LiveGatewayModelEntry = OpenAIModelEntry;

export function buildModelList(
	input: readonly unknown[] | readonly LiveGatewayModelEntry[] = [],
): OpenAIModelListResponse {
	void input;
	return {
		object: "list",
		data: [defaultGjcModelEntry()],
	};
}

function defaultGjcModelEntry(): OpenAIModelEntry {
	return {
		id: GJC_OPENWEBUI_MODEL_ID,
		object: "model",
		created: 1783468800,
		owned_by: "gjc",
	};
}
