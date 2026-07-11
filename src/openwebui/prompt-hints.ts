/** Contract pinned to OpenWebUI v0.10's backend/open_webui/routers/configs.py. */
export const OPENWEBUI_PROMPT_HINTS_ENDPOINT = "/api/v1/configs/suggestions";
export const OPENWEBUI_CONFIG_ENDPOINT = "/api/config";
export const OPENWEBUI_PROMPT_HINTS_CONTRACT = "openwebui-v0.10-configs-suggestions" as const;

export interface OpenWebUIPromptSuggestion {
	readonly title: readonly string[];
	readonly content: string;
}

export interface OpenWebUIPromptHintsPayload {
	readonly suggestions: readonly OpenWebUIPromptSuggestion[];
}

/** Adapter-owned hints are deliberately version-scoped and contain no credentials. */
export const GJC_PROMPT_HINTS_PAYLOAD: OpenWebUIPromptHintsPayload = {
	suggestions: [
		{
			title: ["GJC"],
			content: "Use the GJC coding agent to work on this project.",
		},
	],
};

export function promptHintsPayloadMatches(value: unknown): boolean {
	return JSON.stringify(value) === JSON.stringify(GJC_PROMPT_HINTS_PAYLOAD);
}
export function promptHintsFromConfig(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return (value as { default_prompt_suggestions?: unknown }).default_prompt_suggestions;
}

export function mergePromptHints(existing: unknown): OpenWebUIPromptHintsPayload | undefined {
	if (!Array.isArray(existing)) return undefined;
	const suggestions = existing.filter(isPromptSuggestion);
	if (suggestions.length !== existing.length) return undefined;
	const ownedTitle = GJC_PROMPT_HINTS_PAYLOAD.suggestions[0]?.title;
	const replacement = GJC_PROMPT_HINTS_PAYLOAD.suggestions[0];
	const ownedIndex = suggestions.findIndex(
		suggestion => JSON.stringify(suggestion.title) === JSON.stringify(ownedTitle),
	);
	if (ownedIndex === -1) return { suggestions: [...suggestions, replacement] };
	return { suggestions: suggestions.map((suggestion, index) => (index === ownedIndex ? replacement : suggestion)) };
}

function isPromptSuggestion(value: unknown): value is OpenWebUIPromptSuggestion {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const suggestion = value as { title?: unknown; content?: unknown };
	return (
		Array.isArray(suggestion.title) &&
		suggestion.title.every(item => typeof item === "string") &&
		typeof suggestion.content === "string"
	);
}
