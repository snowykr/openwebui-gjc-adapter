import { describe, expect, test } from "bun:test";
import { parseObservations, parseOutbox } from "./real-selection-effect-schemas";

describe("real selection effect boundary schemas", () => {
	test("rejects noncanonical events and preserves every outbox mutation field", () => {
		for (const event of [
			{ type: "status", data: { description: "x", done: false, gjc_adapter: { model: "gjc" } } },
			{ type: "files", data: { files: [], gjc_adapter: { model: "gjc" } } },
			{ type: "source", data: { gjc_adapter: { model: "gjc" } } },
			{ type: "citation", data: { gjc_adapter: { model: "gjc" } } },
			{ type: "status", data: { description: 7, done: false } },
			{ type: "arbitrary" },
			{ type: "status" },
			{ type: "files" },
			{ type: "source" },
			{ type: "citation" },
		]) {
			expect(() => parseObservations(observation(event))).toThrow();
		}
		expect(() =>
			parseOutbox(
				JSON.stringify({ operations: [{ operationId: "o", chatId: "c", kind: "event", payloadHash: "h" }] }),
			),
		).toThrow();
		const pending = parseOutbox(JSON.stringify({ operations: [outboxOperation("pending", 0)] }));
		const applied = parseOutbox(JSON.stringify({ operations: [outboxOperation("applied", 1)] }));
		expect(applied).not.toEqual(pending);
	});
});

function observation(event: object): string {
	return `${JSON.stringify({
		type: "event",
		input: {
			chatId: "c",
			messageId: "m",
			ownerUserId: "u",
			projectId: "p",
			events: [event],
		},
	})}\n`;
}

function outboxOperation(state: "pending" | "applied", attempts: number) {
	return {
		operationId: "o",
		ownerUserId: "u",
		projectId: "p",
		chatId: "c",
		kind: "event",
		state,
		payloadHash: "h",
		attempts,
		createdAt: "2026-07-13T00:00:00.000Z",
		updatedAt: "2026-07-13T00:00:01.000Z",
	};
}
