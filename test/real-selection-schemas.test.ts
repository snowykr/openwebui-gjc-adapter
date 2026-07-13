import { describe, expect, test } from "bun:test";
import { RealSelectionCoordinator } from "./real-selection-coordinator";
import {
	parseCompletion,
	parseCoordinatorCatalog,
	parseCoordinatorPrompt,
	parseCoordinatorSelection,
	parseMappingDocument,
	parseModelList,
	parseRpcRequest,
	parseSseModels,
	parseTranscriptEntry,
} from "./real-selection-schemas";

describe("real selection boundary schemas", () => {
	test("rejects incomplete catalog, RPC, transcript, and SSE objects", () => {
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
		expect(() => parseRpcRequest({ id: "1", type: "set_default_model_selection" })).toThrow();
		expect(() => parseRpcRequest({ id: "1", type: "unknown_command" })).toThrow();
		expect(() => parseRpcRequest({ id: "1", type: "switch_session" })).toThrow();
		expect(() => parseRpcRequest({ id: "1", type: "workflow_gate_response", gate_id: "gate" })).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					id: "1",
					type: "response",
					command: "workflow_gate_response",
					success: true,
					data: { gate_id: "g", status: "bogus", answer_hash: "h", resolved_at: "2026-07-13T00:00:00Z" },
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					id: "1",
					type: "response",
					command: "workflow_gate_response",
					success: true,
					data: {
						gate_id: "g",
						status: "rejected",
						answer_hash: "h",
						resolved_at: "2026-07-13T00:00:00Z",
						error: { errors: [] },
					},
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({ direction: "request", payload: { id: "1", type: "set_default_model_selection" } }),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: { id: "1", type: "response", command: "get_state", success: true },
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					id: "1",
					type: "response",
					command: "get_state",
					success: true,
					data: {
						model: { provider: "openai\nTOKEN=secret", id: "gpt-5" },
						thinkingLevel: "off",
						sessionId: "s",
						messageCount: 0,
					},
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: { type: "workflow_gate", gate_id: "g", schema_hash: "h", schema: {}, required: true },
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					type: "workflow_gate",
					gate_id: "g",
					stage: "ralplan",
					kind: "approval",
					schema_hash: "h",
					schema: {},
					context: { prompt: 7 },
					created_at: "2026-07-13T00:00:00.000Z",
					required: true,
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "frame",
				payload: {
					type: "event",
					protocol_version: 2,
					session_id: "s",
					seq: 1,
					frame_id: "f",
					payload: { event_type: "agent_end", event: { type: "agent_start" } },
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					id: "1",
					type: "response",
					command: "get_available_models",
					success: true,
					data: { models: [{}] },
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					id: "1",
					type: "response",
					command: "get_state",
					success: true,
					data: {
						model: { provider: "openai", id: "gpt-5" },
						thinkingLevel: "off",
						sessionId: "s",
						messageCount: -1,
					},
				},
			}),
		).toThrow();
		expect(() =>
			parseTranscriptEntry({
				direction: "response",
				payload: {
					id: "1",
					type: "response",
					command: "set_default_model_selection",
					success: true,
					data: { provider: "openai\nTOKEN=secret", modelId: "gpt-5", thinkingLevel: "off" },
				},
			}),
		).toThrow();
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
