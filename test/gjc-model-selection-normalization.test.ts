import { describe, expect, test } from "bun:test";
import { normalizeModelSelection } from "../src/gjc/session-router";

describe("normalizeModelSelection", () => {
	test("rejects slash-delimited providers", () => {
		const invalid = { provider: "proxy/openai", modelId: "model:雪/preview", thinkingLevel: "off" } as const;

		const normalizedInvalid = normalizeModelSelection(invalid);

		expect(normalizedInvalid).toBeUndefined();
	});

	test("preserves safe provider punctuation and model identifier syntax", () => {
		const valid = { provider: "p-100%", modelId: "model:雪/preview", thinkingLevel: "off" } as const;

		const normalizedValid = normalizeModelSelection(valid);

		expect(normalizedValid).toEqual(valid);
	});
});
