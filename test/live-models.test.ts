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
	test("classifies alias base canonical malformed and foreign ids", () => {
		const classify = exportedFunction("classifyGjcModelId");
		expect(classify("gjc")).toEqual({ kind: "alias" });
		expect(classify("gjc/openai/gpt-5")).toEqual({
			kind: "base",
			model: { provider: "openai", modelId: "gpt-5" },
		});
		expect(classify("gjc/openai/gpt-5:off")).toMatchObject({ kind: "canonical" });
		expect(classify("gjc/noncanonical")).toEqual({ kind: "malformed" });
		expect(classify("openai/gpt-5")).toEqual({ kind: "foreign" });
	});

	test("round-trips strict RFC3986 bytes when a model id contains delimiters and Unicode", () => {
		// Given
		const format = exportedFunction("formatCanonicalModelId");
		const parse = exportedFunction("parseCanonicalModelId");
		const selection = { provider: "p-100%", modelId: "m:n/雪", thinkingLevel: "high" };

		// When
		const canonical = format(selection);
		const decoded = parse(canonical);

		// Then
		expect(canonical).toBe("gjc/p-100%25/m%3An%2F%E9%9B%AA:high");
		expect(decoded).toEqual(selection);
	});

	test("rejects a provider containing slash at normalized and canonical codec admission", () => {
		// Given
		const format = exportedFunction("formatCanonicalModelId");
		const parse = exportedFunction("parseCanonicalModelId");
		const build = exportedFunction("buildModelList");
		const selection = { provider: "proxy/openai", modelId: "model:雪/preview", thinkingLevel: "off" };

		// When / Then
		expect(() => format(selection)).toThrow();
		expect(parse("gjc/proxy%2Fopenai/model%3A%E9%9B%AA%2Fpreview:off")).toBeNull();
		expect(build([selection])).toEqual({ object: "list", data: [] });
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

test("round-trips base model ids without embedding thinking level", () => {
	const format = exportedFunction("formatBaseModelId");
	const parse = exportedFunction("parseBaseModelId");
	const model = { provider: "openai-codex", modelId: "gpt-5.6/terra" };
	expect(format(model)).toBe("gjc/openai-codex/gpt-5.6%2Fterra");
	expect(parse(format(model))).toEqual(model);
});

describe("atomic GJC catalog decoder", () => {
	test("strict decoding distinguishes a valid empty catalog from malformed descriptors", () => {
		const decode = exportedFunction("decodeStrictModelCatalog");
		expect(decode([])).toEqual([]);
		expect(decode([{ provider: "broken" }])).toBeNull();
	});

	test("uses Q10 thinking.validLevels as the authoritative settable menu for every row", () => {
		// Given
		const decode = exportedFunction("decodeModelCatalog");
		const catalog = [
			{
				provider: "plain",
				id: "chat:雪/preview",
				contextWindow: 1000,
				reasoning: false,
				thinking: { validLevels: ["off"] },
			},
			{
				provider: "reasoning",
				id: "deep",
				contextWindow: 2000,
				reasoning: true,
				thinking: {
					validLevels: ["off", "minimal", "medium", "xhigh", "max"],
					minLevel: "minimal",
					maxLevel: "max",
					mode: "effort",
					levels: ["max", "minimal", "max"],
				},
			},
		];

		// When
		const tuples = decode(catalog);

		// Then
		expect(tuples).toEqual([
			{ provider: "plain", modelId: "chat:雪/preview", thinkingLevel: "off" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "off" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "minimal" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "medium" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "xhigh" },
			{ provider: "reasoning", modelId: "deep", thinkingLevel: "max" },
		]);
	});

	test.each([
		["missing thinking", { provider: "reasoning", id: "missing", reasoning: true }],
		["missing validLevels", { provider: "reasoning", id: "missing-levels", reasoning: true, thinking: {} }],
		["empty validLevels", { provider: "reasoning", id: "empty", reasoning: true, thinking: { validLevels: [] } }],
		[
			"inherit readback",
			{ provider: "reasoning", id: "inherit", reasoning: true, thinking: { validLevels: ["off", "inherit"] } },
		],
		[
			"unknown level",
			{ provider: "reasoning", id: "unknown", reasoning: true, thinking: { validLevels: ["off", "ultra"] } },
		],
		[
			"duplicate level",
			{ provider: "reasoning", id: "duplicate", reasoning: true, thinking: { validLevels: ["off", "low", "low"] } },
		],
		[
			"noncanonical order",
			{ provider: "reasoning", id: "order", reasoning: true, thinking: { validLevels: ["low", "off"] } },
		],
		[
			"nonreasoning level",
			{ provider: "plain", id: "chat", reasoning: false, thinking: { validLevels: ["off", "low"] } },
		],
		[
			"provider slash",
			{ provider: "provider/sub", id: "model", reasoning: false, thinking: { validLevels: ["off"] } },
		],
	] as const)("rejects %s atomically after a valid Q10 row", (_name, invalid) => {
		// Given
		const decode = exportedFunction("decodeStrictModelCatalog");
		const valid = { provider: "plain", id: "chat", reasoning: false, thinking: { validLevels: ["off"] } };

		// When
		const tuples = decode([valid, invalid]);

		// Then
		expect(tuples).toBeNull();
	});

	test("deduplicates tuples and sorts provider/model UTF-8 bytes before thinking rank", () => {
		// Given
		const decode = exportedFunction("decodeModelCatalog");
		const catalog = [
			{
				provider: "z",
				id: "m",
				reasoning: true,
				thinking: { validLevels: ["off", "minimal", "low", "max"] },
			},
			{ provider: "ä", id: "m", reasoning: false, thinking: { validLevels: ["off"] } },
			{
				provider: "z",
				id: "m",
				reasoning: true,
				thinking: { validLevels: ["off", "minimal", "low", "max"] },
			},
		];

		// When
		const tuples = decode(catalog);

		// Then
		expect(tuples).toEqual([
			{ provider: "z", modelId: "m", thinkingLevel: "off" },
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

describe("base model catalog", () => {
	test("deduplicates thinking tuples into one advertised model", () => {
		const build = exportedFunction("buildBaseModelList");
		expect(
			build([
				{ provider: "openai-codex", modelId: "gpt-5.6-terra" },
				{ provider: "openai-codex", modelId: "gpt-5.6-terra" },
			]),
		).toEqual({
			object: "list",
			data: [
				{
					id: "gjc/openai-codex/gpt-5.6-terra",
					object: "model",
					created: 1783468800,
					owned_by: "gjc",
				},
			],
		});
	});
});
