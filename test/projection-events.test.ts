import { describe, expect, test } from "bun:test";
import { projectAgentFrame } from "../src/projection/events";

const sse = { id: "chatcmpl-test", created: 123, model: "gjc/test" };

describe("projectAgentFrame", () => {
	test("maps assistant text to an OpenAI SSE chunk content delta", () => {
		const projected = projectAgentFrame({ kind: "assistant_text", text: "hello" }, sse);
		expect(projected.events).toEqual([]);
		expect(projected.sseChunks).toHaveLength(1);
		const payload = JSON.parse(projected.sseChunks[0]?.slice("data: ".length).trim() ?? "{}");
		expect(payload.choices[0].delta.content).toBe("hello");
		expect(payload.choices[0].delta.role).toBe("assistant");
	});

	test("maps tool progress start and end to status events", () => {
		expect(projectAgentFrame({ kind: "tool_progress", label: "Reading files", phase: "start" }, sse).events).toEqual([
			{
				type: "status",
				data: {
					description: "Reading files",
					done: false,
					gjc_adapter: { frameKind: "tool_progress", phase: "start", metadata: {} },
				},
			},
		]);
		expect(
			projectAgentFrame({ kind: "tool_progress", label: "Reading files", phase: "end" }, sse).events[0],
		).toMatchObject({
			type: "status",
			data: { done: true },
		});
	});

	test("maps subagent progress to visible status events", () => {
		expect(
			projectAgentFrame({ kind: "subagent_progress", label: "GJC agent started", phase: "start" }, sse).events,
		).toEqual([
			{
				type: "status",
				data: {
					description: "GJC agent started",
					done: false,
					gjc_adapter: { frameKind: "subagent_progress", phase: "start", metadata: {} },
				},
			},
		]);
	});

	test("maps source and citation as single documented event objects", () => {
		const source = { source: { name: "README" }, metadata: { line: 4 } };
		const citation = { document: ["doc"], metadata: { score: 0.8 } };
		expect(projectAgentFrame({ kind: "source", source }, sse).events).toEqual([{ type: "source", data: source }]);
		expect(projectAgentFrame({ kind: "citation", citation }, sse).events).toEqual([
			{ type: "citation", data: citation },
		]);
	});

	test("maps unsupported frames to a bounded hidden diagnostic status event", () => {
		expect(
			projectAgentFrame({ kind: "unsupported", eventType: "raw_debug", id: "frame-1", textPresent: false }, sse)
				.events,
		).toEqual([
			{
				type: "status",
				data: {
					description: "Unsupported GJC frame",
					done: true,
					hidden: true,
					gjc_adapter: {
						diagnostic: "unsupported_frame",
						metadata: { eventType: "raw_debug", id: "frame-1", textPresent: false },
					},
				},
			},
		]);
	});

	test("bounds long unsupported frame diagnostics", () => {
		const projected = projectAgentFrame(
			{
				kind: "unsupported",
				eventType: "x".repeat(500),
				id: "i".repeat(500),
				textPresent: true,
			},
			sse,
		);
		const event = projected.events[0];

		expect(event?.type).toBe("status");
		if (event?.type !== "status") throw new Error("expected status event");
		expect(event.data.hidden).toBe(true);
		expect(event.data.description.length).toBeLessThanOrEqual(110);
		expect(String(event.data.gjc_adapter?.frameType)).toBe("undefined");
		expect(event.data.gjc_adapter?.metadata).toEqual({
			eventType: `${"x".repeat(77)}...`,
			id: `${"i".repeat(77)}...`,
			textPresent: true,
		});
	});
});
