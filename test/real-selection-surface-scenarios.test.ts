import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { FailedStartCleanupReceipt } from "./cli-fixtures";
import { CANONICAL_MODEL_IDS, LOW_MODEL_ID, MEDIUM_MODEL_ID } from "./model-selection-fixtures";
import { expectNoDeliveryMutation, expectSelectionError } from "./real-selection-expectations";
import { RealSelectionHarness } from "./real-selection-harness";

describe("real canonical model selection surfaces", () => {
	test("fails invalid shipped runner results before JSON SSE or persistence success", async () => {
		const harness = await RealSelectionHarness.start({ invalidRunnerModel: "gjc" });
		try {
			const before = await harness.effects();
			const json = await harness.chat(LOW_MODEL_ID, { id: "invalid-json" });
			const stream = await harness.chat(LOW_MODEL_ID, { id: "invalid-stream", stream: true });
			for (const result of [json, stream]) {
				expect(result).toMatchObject({
					status: 503,
					contentType: expect.stringContaining("application/json"),
					error: { error: { code: "live_runner_error" } },
				});
			}
			const after = await harness.effects();
			expect(after.coordinator).toEqual(before.coordinator);
			expect(after.projectLookups).toBe(before.projectLookups + 2);
			expectNoDeliveryMutation(before, after);
		} finally {
			await harness.stop();
		}
	}, 15_000);

	test("reaps an induced startup failure before root cleanup and port reuse", async () => {
		let receipt: FailedStartCleanupReceipt | undefined;
		await expect(
			RealSelectionHarness.start({ failStartup: true, onFailedCleanup: value => (receipt = value) }),
		).rejects.toThrow("induced selection fixture startup failure");
		expect(receipt).toMatchObject({ deadlineMs: 5_000, processExited: true });
		if (receipt === undefined) throw new Error("expected failed-start cleanup receipt");
		await expect(access(receipt.root)).rejects.toThrow();
		const rebound = Bun.serve({ hostname: "127.0.0.1", port: receipt.port, fetch: () => new Response("ok") });
		await rebound.stop();
	}, 15_000);

	test("exposes Q10 capabilities without advertising current inherit readback", async () => {
		const harness = await RealSelectionHarness.start({ catalogMode: "current-inherit" });
		try {
			const models = await harness.models();
			expect(models).toMatchObject({ status: 200 });
			expect(models.body.data.map(model => model.id)).toEqual([...CANONICAL_MODEL_IDS]);
			expect(models.body.data.map(model => model.id)).not.toContain("gjc/anthropic/claude-sonnet-4:inherit");
			expect(await harness.chat("gjc", { id: "current-alias" })).toMatchObject({
				status: 200,
				body: { model: LOW_MODEL_ID },
			});
		} finally {
			await harness.stop();
		}
	}, 15_000);

	test("drives catalog JSON SSE background normalization admin and setter failure without durable projection rows", async () => {
		const harness = await RealSelectionHarness.start();
		try {
			const models = await harness.models();
			expect(models).toMatchObject({ status: 200 });
			expect(models.body.data.map(model => model.id)).toEqual([...CANONICAL_MODEL_IDS]);
			expect(await harness.chat("gjc", { id: "alias" })).toMatchObject({
				status: 200,
				body: { model: LOW_MODEL_ID },
			});
			harness.coordinator.normalizeNextToMedium();
			expect(await harness.chat(LOW_MODEL_ID, { id: "normalized" })).toMatchObject({
				status: 200,
				body: { model: MEDIUM_MODEL_ID },
			});
			const mapping = await harness.mappingBytes();
			expect(mapping).toContain('"thinkingLevel": "medium"');
			expect(mapping).not.toContain(LOW_MODEL_ID);
			expect(await harness.eventModels("chat-normalized")).toEqual([MEDIUM_MODEL_ID]);
			const normalizedEffects = await harness.effects();
			// Without an OpenWebUIProjectionRepository, live event sink delivery still occurs but durable projection rows are disabled.
			expect(normalizedEffects.outbox).toEqual([]);
			expect(await harness.chat("gjc", { id: "alias-admin", content: "/gjc project list" })).toMatchObject({
				status: 200,
				body: { model: MEDIUM_MODEL_ID },
			});
			harness.coordinator.normalizeNextToMedium();
			expect(await harness.chat(LOW_MODEL_ID, { id: "stream", stream: true })).toMatchObject({
				status: 200,
				sseModels: [MEDIUM_MODEL_ID],
			});
			const beforeBackground = await harness.effects();
			expect(await harness.chat("gjc", { id: "background", task: "title" })).toMatchObject({
				status: 200,
				body: { model: MEDIUM_MODEL_ID },
			});
			expect(await harness.chat(LOW_MODEL_ID, { id: "canonical-background", task: "title" })).toMatchObject({
				status: 200,
				body: { model: LOW_MODEL_ID },
			});
			expect(await harness.chat(LOW_MODEL_ID, { id: "admin", content: "/gjc project list" })).toMatchObject({
				status: 200,
				body: { model: LOW_MODEL_ID },
			});
			const afterBackground = await harness.effects();
			expect(afterBackground.coordinator).toMatchObject({
				...beforeBackground.coordinator,
				catalogReads: beforeBackground.coordinator.catalogReads + 3,
				stateReads: beforeBackground.coordinator.stateReads + 1,
			});
			expect(afterBackground.projectLookups).toBe(beforeBackground.projectLookups);
			expectNoDeliveryMutation(beforeBackground, afterBackground);
			const beforeFailure = await harness.effects();
			harness.coordinator.failNextSetter();
			await expectSelectionError(
				harness.chat(LOW_MODEL_ID, { id: "setter-failure" }),
				409,
				"model_selection_apply_failed",
			);
			const afterFailure = await harness.effects();
			expect(afterFailure.coordinator).toMatchObject({
				selection: beforeFailure.coordinator.selection,
				setters: beforeFailure.coordinator.setters,
				promptCount: beforeFailure.coordinator.promptCount,
				setterAttempts: beforeFailure.coordinator.setterAttempts + 1,
			});
			expectNoDeliveryMutation(beforeFailure, afterFailure);
		} finally {
			await harness.stop();
		}
	}, 15_000);
});
