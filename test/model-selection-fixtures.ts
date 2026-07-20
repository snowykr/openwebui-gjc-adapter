import type { NormalizedModelSelection } from "../src/contracts";
import type { ModelReader, ModelReaderFactory } from "../src/live/model-reader";

export const LOW_SELECTION: NormalizedModelSelection = {
	provider: "anthropic",
	modelId: "claude-sonnet-4",
	thinkingLevel: "low",
};
export const MEDIUM_SELECTION: NormalizedModelSelection = { ...LOW_SELECTION, thinkingLevel: "medium" };
export const REASONING_OFF_SELECTION: NormalizedModelSelection = { ...LOW_SELECTION, thinkingLevel: "off" };
export const OFF_SELECTION: NormalizedModelSelection = {
	provider: "openai",
	modelId: "gpt-5",
	thinkingLevel: "off",
};

export const MODEL_DESCRIPTORS: readonly unknown[] = Object.freeze([
	Object.freeze({
		provider: "anthropic",
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		contextWindow: 200_000,
		maxTokens: 64_000,
		reasoning: true,
		thinking: Object.freeze({
			validLevels: Object.freeze(["off", "low", "medium"]),
			minLevel: "low",
			maxLevel: "medium",
			mode: "effort",
			levels: Object.freeze(["low", "medium"]),
			defaultLevel: "low",
		}),
		current: true,
		currentThinkingLevel: "low",
	}),
	Object.freeze({
		provider: "openai",
		id: "gpt-5",
		name: "GPT-5",
		contextWindow: 400_000,
		maxTokens: 128_000,
		reasoning: false,
		thinking: Object.freeze({ validLevels: Object.freeze(["off"]) }),
		current: false,
	}),
]);

export const REASONING_OFF_MODEL_ID = "gjc/anthropic/claude-sonnet-4:off";
export const LOW_MODEL_ID = "gjc/anthropic/claude-sonnet-4:low";
export const MEDIUM_MODEL_ID = "gjc/anthropic/claude-sonnet-4:medium";
export const OFF_MODEL_ID = "gjc/openai/gpt-5:off";

export const CANONICAL_MODEL_IDS = [REASONING_OFF_MODEL_ID, LOW_MODEL_ID, MEDIUM_MODEL_ID, OFF_MODEL_ID] as const;

export function staticModelReaderFactory(
	transcript: string[] = [],
	state: unknown = { model: { provider: "anthropic", id: "claude-sonnet-4" }, thinkingLevel: "low" },
): ModelReaderFactory {
	return async (): Promise<ModelReader> => ({
		async getAvailableModels(): Promise<readonly unknown[]> {
			transcript.push("catalog");
			return MODEL_DESCRIPTORS;
		},
		async getState(): Promise<unknown> {
			transcript.push("state");
			return state;
		},
		stop(): void {
			transcript.push("stop");
		},
	});
}
