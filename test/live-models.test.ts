import { describe, expect, test } from "bun:test";
import * as models from "../src/live/models";

function exportedFunction(name: string): (...args: readonly unknown[]) => unknown {
	const value = Reflect.get(models, name);
	expect(value, `expected ${name} to be exported`).toBeFunction();
	if (typeof value !== "function") {
		throw new TypeError(`${name} is not callable`);
	}
	return value;
}

describe("canonical GJC model codec", () => {
	test("round-trips strict RFC3986 bytes when provider and model contain delimiters", () => {
		// Given
		const format = exportedFunction("formatCanonicalModelId");
		const parse = exportedFunction("parseCanonicalModelId");
		const selection = { provider: "p/100%", modelId: "m:n/雪", thinkingLevel: "high" };

		// When
		const canonical = format(selection);
		const decoded = parse(canonical);

		// Then
		expect(canonical).toBe("gjc/p%2F100%25/m%3An%2F%E9%9B%AA:high");
		expect(decoded).toEqual(selection);
	});

	test("rejects non-canonical and unsafe spellings when parsing", () => {
		// Given
		const parse = exportedFunction("parseCanonicalModelId");
		const malformed = [
			"gjc",
			"gjc//model:off",
			"gjc/provider/:off",
			"gjc/provider/model:inherit",
			"gjc/provider/model:%6Fff",
			"gjc/provider%2fsub/model:off",
			"gjc/provider/%252F:off",
			"gjc/./model:off",
			"gjc/provider/..:off",
			"gjc/provider/model%0Aname:off",
			"gjc/provider/model%E2%80%83name:off",
		];

		// When
		const decoded = malformed.map(value => parse(value));

		// Then
		expect(decoded).toEqual(malformed.map(() => null));
	});
});

describe("atomic GJC catalog decoder", () => {
	test("emits off for a non-reasoning descriptor and concrete levels for a complete reasoning descriptor", () => {
		// Given
		const decode = exportedFunction("decodeModelCatalog");
		const catalog = [
			{ provider: "plain", id: "chat", contextWindow: 1000, reasoning: false },
			{
				provider: "reasoning",
				id: "deep",
				contextWindow: 2000,
				reasoning: true,
				thinking: { minLevel: "minimal", maxLevel: "high", mode: "effort" },
			},
		];

		// When
		const tuples = decode(catalog);

		// Then
		expect(tuples).toEqual([
			{ provider: "plain", modelId: "chat", thinkingLevel: "off" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "minimal" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "low" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "medium" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "high" },
		]);
	});

	test("rejects each malformed descriptor atomically without recovering partial tuples", () => {
		// Given
		const decode = exportedFunction("decodeModelCatalog");
		const malformed = [
			{ provider: "plain", id: "chat", reasoning: false, thinking: { minLevel: "off" } },
			{ provider: "reasoning", id: "empty", reasoning: true },
			{
				provider: "reasoning",
				id: "partial",
				reasoning: true,
				thinking: { minLevel: "low", maxLevel: "high", mode: "effort", levels: ["low", "inherit"] },
			},
			{
				provider: "reasoning",
				id: "bounds",
				reasoning: true,
				thinking: { minLevel: "high", maxLevel: "low", mode: "effort" },
			},
		];

		// When
		const tuples = decode(malformed);

		// Then
		expect(tuples).toEqual([]);
	});

	test("deduplicates tuples and sorts provider/model UTF-8 bytes before thinking rank", () => {
		// Given
		const decode = exportedFunction("decodeModelCatalog");
		const catalog = [
			{
				provider: "z",
				id: "m",
				reasoning: true,
				thinking: { minLevel: "minimal", maxLevel: "max", mode: "budget", levels: ["max", "low", "minimal"] },
			},
			{ provider: "ä", id: "m", reasoning: false },
			{
				provider: "z",
				id: "m",
				reasoning: true,
				thinking: { minLevel: "minimal", maxLevel: "max", mode: "budget", levels: ["minimal", "low", "max"] },
			},
		];

		// When
		const tuples = decode(catalog);

		// Then
		expect(tuples).toEqual([
			{ provider: "z", modelId: "m", thinkingLevel: "minimal" },
			{ provider: "z", modelId: "m", thinkingLevel: "low" },
			{ provider: "z", modelId: "m", thinkingLevel: "max" },
			{ provider: "ä", modelId: "m", thinkingLevel: "off" },
		]);
	});

	test("never emits the input-only gjc alias when model list entries are built", () => {
		// Given
		const build = exportedFunction("buildModelList");
		const tuples = [{ provider: "p", modelId: "m", thinkingLevel: "off" }];

		// When
		const response = build(tuples);

		// Then
		expect(response).toEqual({
			object: "list",
			data: [{ id: "gjc/p/m:off", object: "model", created: 1783468800, owned_by: "gjc" }],
		});
	});
});
