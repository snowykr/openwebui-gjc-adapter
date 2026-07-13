import type { NormalizedModelSelection } from "../src/contracts";
import type { ModelReader, ModelReaderFactory } from "../src/live/model-reader";

export const LOW_SELECTION: NormalizedModelSelection = {
	provider: "anthropic",
	modelId: "claude-sonnet-4",
	thinkingLevel: "low",
};
export const MEDIUM_SELECTION: NormalizedModelSelection = { ...LOW_SELECTION, thinkingLevel: "medium" };
export const OFF_SELECTION: NormalizedModelSelection = {
	provider: "openai",
	modelId: "gpt-5",
	thinkingLevel: "off",
};

export const MODEL_DESCRIPTORS: readonly unknown[] = Object.freeze([
	Object.freeze({
		provider: "anthropic",
		id: "claude-sonnet-4",
		reasoning: true,
		thinking: Object.freeze({
			minLevel: "low",
			maxLevel: "medium",
			mode: "effort",
			levels: Object.freeze(["low", "medium"]),
			defaultLevel: "low",
		}),
	}),
	Object.freeze({ provider: "openai", id: "gpt-5", reasoning: false }),
]);

export const CANONICAL_MODEL_IDS = [
	"gjc/anthropic/claude-sonnet-4:low",
	"gjc/anthropic/claude-sonnet-4:medium",
	"gjc/openai/gpt-5:off",
] as const;

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
