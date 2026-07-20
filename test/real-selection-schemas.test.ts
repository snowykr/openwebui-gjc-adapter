import { describe, expect, test } from "bun:test";
import { RealSelectionCoordinator } from "./real-selection-coordinator";
import {
	parseCompletion,
	parseCoordinatorCatalog,
	parseCoordinatorPrompt,
	parseCoordinatorSelection,
	parseMappingDocument,
	parseModelList,
	parseSseModels,
} from "./real-selection-schemas";

describe("real selection boundary schemas", () => {
	test("rejects incomplete catalog and SSE objects", () => {
		expect(() =>
			parseModelList({ object: "list", data: [{ id: "gjc", object: "model", created: 1, owned_by: "gjc" }] }),
		).toThrow();
		expect(() =>
			parseCompletion({
				id: "c",
				object: "chat.completion",
				created: 1,
				model: "gjc",
				choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
			}),
		).toThrow();
		expect(() =>
			parseMappingDocument({
				mappings: [
					{
						chatId: "c",
						projectId: "p",
						sessionId: "s",
						operationId: "o",
						modelSelection: { provider: "openai\nTOKEN=secret", modelId: "gpt-5", thinkingLevel: "off" },
					},
				],
			}),
		).toThrow();
		expect(() => parseCoordinatorCatalog({ models: [{ provider: "p", id: "m" }] })).toThrow();
		expect(() =>
			parseCoordinatorCatalog({ models: [{ provider: "openai\nTOKEN=secret", id: "gpt-5", reasoning: false }] }),
		).toThrow();
		expect(() =>
			parseCoordinatorSelection({ provider: "openai\nTOKEN=secret", modelId: "gpt-5", thinkingLevel: "off" }),
		).toThrow();
		expect(() => parseCoordinatorPrompt({ ok: true, gate: "yes" })).toThrow();
		expect(() => parseSseModels('data: {"object":"chat.completion.chunk","model":"gjc","choices":[]}\n\n')).toThrow();
		expect(() =>
			parseSseModels(
				'data: {"object":"chat.completion.chunk","model":"gjc/openai/gpt-5:off","choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n',
			),
		).toThrow();
		expect(() =>
			parseSseModels(
				'data: {"id":"chunk","object":"chat.completion.chunk","created":1,"model":"gjc/openai/gpt-5:off","choices":[{"index":0,"delta":{"role":7},"finish_reason":null}]}\n\n',
			),
		).toThrow();
		expect(() =>
			parseSseModels(
				'data: {"id":"chunk","object":"chat.completion.chunk","created":1,"model":"gjc/openai/gpt-5:off","choices":[{"index":0,"delta":{"content":[{"type":"text","text":7}]},"finish_reason":null}]}\n\n',
			),
		).toThrow();
		expect(() =>
			parseSseModels(
				'data: {"id":"chunk","object":"chat.completion.chunk","created":1,"model":"gjc/openai/gpt-5:off","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
			),
		).toThrow();
		expect(() =>
			parseSseModels(
				'data: not-json\n\ndata: {"id":"chunk","object":"chat.completion.chunk","created":1,"model":"gjc/openai/gpt-5:off","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			),
		).toThrow();
		expect(() => parseSseModels("data: [DONE]\n\n")).toThrow();
	});

	test("rejects unsafe coordinator setter request components", async () => {
		const coordinator = new RealSelectionCoordinator();
		try {
			const response = await fetch(`${coordinator.url}/setter`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "openai\nTOKEN=secret", modelId: "gpt-5", thinkingLevel: "off" }),
			});
			expect(response.status).toBe(400);
			expect(coordinator.snapshot().setters).toEqual([]);
		} finally {
			await coordinator.stop();
		}
	});
});
