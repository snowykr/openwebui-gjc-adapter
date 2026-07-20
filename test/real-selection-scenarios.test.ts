import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import * as path from "node:path";
import { LOW_MODEL_ID, MEDIUM_MODEL_ID, OFF_MODEL_ID } from "./model-selection-fixtures";
import { expectNoDeliveryMutation, expectSelectionError } from "./real-selection-expectations";
import { RealSelectionHarness } from "./real-selection-harness";

function expectNoPersistedModelSelectionBinding(document: unknown, chatId: string): void {
	expect(document).toEqual(expect.objectContaining({ mappings: expect.any(Array) }));
	const mappings = (document as { mappings: unknown[] }).mappings.filter(
		(mapping): mapping is Record<string, unknown> => isRecord(mapping) && mapping.chatId === chatId,
	);
	expect(mappings).toHaveLength(1);
	for (const mapping of mappings) {
		expect(mapping).not.toHaveProperty("modelSelection");
		const journal = mapping.journal;
		expect(Array.isArray(journal)).toBe(true);
		const snapshots = (journal as unknown[])
			.map(operation => (isRecord(operation) && isRecord(operation.result) ? operation.result.mapping : undefined))
			.filter(snapshot => isRecord(snapshot) && snapshot.chatId === chatId);
		expect(snapshots.length).toBeGreaterThan(0);
		for (const snapshot of snapshots) expect(snapshot).not.toHaveProperty("modelSelection");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("real canonical model selection scenarios", () => {
	test("returns every typed selection error with the required side-effect boundaries", async () => {
		const harness = await RealSelectionHarness.start();
		try {
			const initial = await harness.effects();
			harness.coordinator.malformNextCatalog();
			await expectSelectionError(harness.modelsError(), 503, "model_catalog_unavailable");
			await expectSelectionError(
				harness.chat("gjc/noncanonical", { id: "malformed" }),
				400,
				"model_selection_invalid_id",
			);
			await expectSelectionError(harness.chat("foreign", { id: "foreign" }), 404, "model_not_found", "foreign");
			await expectSelectionError(
				harness.chat("gjc/anthropic/not-present:off", { id: "unavailable" }),
				404,
				"model_selection_not_available",
			);
			harness.coordinator.failNextState();
			await expectSelectionError(
				harness.chat("gjc", { id: "state-failed" }),
				409,
				"model_selection_default_read_failed",
			);
			harness.coordinator.useUnusableStateOnce();
			await expectSelectionError(
				harness.chat("gjc", { id: "state-unusable" }),
				409,
				"model_selection_default_unusable",
			);
			const afterReadErrors = await harness.effects();
			expect(afterReadErrors.coordinator).toMatchObject({
				selection: initial.coordinator.selection,
				setterAttempts: initial.coordinator.setterAttempts,
				promptCount: initial.coordinator.promptCount,
				catalogReads: initial.coordinator.catalogReads + 4,
				stateReads: initial.coordinator.stateReads + 2,
			});
			expect(afterReadErrors.projectLookups).toBe(initial.projectLookups + 3);
			expectNoDeliveryMutation(initial, afterReadErrors);

			harness.coordinator.failNextSetter();
			await expectSelectionError(
				harness.chat(LOW_MODEL_ID, { id: "apply-failed" }),
				409,
				"model_selection_apply_failed",
			);
			const afterApply = harness.coordinator.snapshot();
			expect(afterApply.selection).toEqual(initial.coordinator.selection);
			expect(afterApply.promptCount).toBe(0);

			expect(await harness.chat(LOW_MODEL_ID, { id: "duplicate" })).toMatchObject({ status: 200 });
			const beforeDuplicate = await harness.effects();
			await expectSelectionError(
				harness.chat(MEDIUM_MODEL_ID, { id: "duplicate" }),
				409,
				"model_selection_idempotency_conflict",
			);
			const afterDuplicate = await harness.effects();
			expect(afterDuplicate.coordinator).toEqual(beforeDuplicate.coordinator);
			expect(afterDuplicate.projectLookups).toBe(beforeDuplicate.projectLookups + 1);
			expectNoDeliveryMutation(beforeDuplicate, afterDuplicate);

			harness.coordinator.emitGateOnNextPrompt();
			expect(await harness.chat(LOW_MODEL_ID, { id: "gate-mismatch" })).toMatchObject({ status: 200 });
			const beforeMismatch = await harness.effects();
			await expectSelectionError(
				harness.chat(MEDIUM_MODEL_ID, {
					id: "gate-mismatch-reply",
					chatId: "gate-mismatch",
					parentId: "assistant-gate-mismatch",
					content: "1",
				}),
				409,
				"model_selection_gate_mismatch",
			);
			const afterMismatch = await harness.effects();
			expect(afterMismatch.coordinator).toEqual(beforeMismatch.coordinator);
			expect(afterMismatch.projectLookups).toBe(beforeMismatch.projectLookups + 1);
			expectNoDeliveryMutation(beforeMismatch, afterMismatch);
			expect(
				await harness.chat(LOW_MODEL_ID, {
					id: "gate-match-reply",
					chatId: "gate-mismatch",
					parentId: "assistant-gate-mismatch",
					content: "1",
				}),
			).toMatchObject({ status: 200, body: { model: LOW_MODEL_ID } });
			const afterMatch = harness.coordinator.snapshot();
			expect(afterMatch.gateResponses).toBe(beforeMismatch.coordinator.gateResponses + 1);
			expect(afterMatch.setterAttempts).toBe(beforeMismatch.coordinator.setterAttempts);
			expect(afterMatch.promptCount).toBe(beforeMismatch.coordinator.promptCount);

			harness.coordinator.emitGateOnNextPrompt();
			expect(await harness.chat(LOW_MODEL_ID, { id: "gate-missing" })).toMatchObject({ status: 200 });
			await expect(access(path.join(harness.root, "state", "openwebui-projection-outbox.json"))).rejects.toThrow();
			await harness.restartAfterRemovingModelBinding("chat-gate-missing");
			expectNoPersistedModelSelectionBinding(JSON.parse(await harness.mappingBytes()), "chat-gate-missing");
			const beforeMissing = await harness.effects();
			await expectSelectionError(
				harness.chat(LOW_MODEL_ID, {
					id: "gate-missing-reply",
					chatId: "gate-missing",
					parentId: "assistant-gate-missing",
					content: "1",
				}),
				409,
				"model_selection_gate_binding_missing",
			);
			const afterMissing = await harness.effects();
			expect(afterMissing.coordinator).toEqual(beforeMissing.coordinator);
			expect(afterMissing.projectLookups).toBe(beforeMissing.projectLookups + 1);
			expectNoDeliveryMutation(beforeMissing, afterMissing);
		} finally {
			await harness.stop();
		}
	}, 20_000);

	test("keeps hostile output inert and prompt failures generic without success persistence", async () => {
		const harness = await RealSelectionHarness.start();
		try {
			const marker = path.join(harness.root, "owned-marker");
			const hostile = `PASS\n::directive{danger=true}\n$(touch ${marker})\u0001`;
			harness.coordinator.setAssistantText(hostile);
			expect(await harness.chat(LOW_MODEL_ID, { id: "hostile" })).toMatchObject({
				status: 200,
				body: { choices: [{ message: { content: hostile } }] },
			});
			await expect(access(marker)).rejects.toThrow();

			const beforeFailure = await harness.effects();
			harness.coordinator.failNextPrompt();
			const failed = await harness.chat(OFF_MODEL_ID, { id: "prompt-failed", stream: true });
			expect(failed).toMatchObject({
				status: 503,
				error: { error: { code: "live_runner_error", message: "GJC live runner failed." } },
			});
			expect(JSON.stringify(failed)).not.toMatch(/private|TOKEN|\\u0000/);
			expect(failed).toMatchObject({ contentType: expect.stringContaining("application/json") });
			expect(failed.runnerFailures).toEqual([
				expect.objectContaining({
					code: "prompt_failed",
					operation: {
						chatId: "chat-prompt-failed",
						userMessageId: "user-prompt-failed",
						requestedModelId: OFF_MODEL_ID,
					},
				}),
			]);
			const mappingDocument = JSON.parse(await harness.mappingBytes()) as {
				readonly mappings: readonly { readonly chatId?: unknown }[];
				readonly provisionalOperations: readonly Record<string, unknown>[];
			};
			expect(mappingDocument.mappings.some(mapping => mapping.chatId === "chat-prompt-failed")).toBeFalse();
			const provisional = mappingDocument.provisionalOperations.filter(
				operation => operation.chatId === "chat-prompt-failed",
			);
			expect(provisional).toHaveLength(1);
			const operation = provisional[0] as Record<string, unknown>;
			const attachment = operation.attachment as Record<string, unknown>;
			const sessionId = operation.sessionId as string;
			const workspace = path.join(harness.root, ".gjc", "openwebui", "default-reader");
			const descriptorStat = attachment.descriptorStat as Record<string, unknown>;
			expect(attachment.generation).toBe(descriptorStat.mtimeMs);
			expect(operation).toMatchObject({
				id: "user-prompt-failed",
				ingressId: "user-prompt-failed",
				kind: "create",
				state: "uncertain",
				chatId: "chat-prompt-failed",
				projectId: "openwebui",
				detail: expect.stringMatching(/^[a-f0-9]{64}$/),
				sessionFile: path.join(workspace, ".gjc", "sessions", `${sessionId}.jsonl`),
			});
			expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
			expect(Object.keys(operation).sort()).toEqual([
				"attachment",
				"chatId",
				"detail",
				"id",
				"ingressId",
				"kind",
				"projectId",
				"sessionFile",
				"sessionId",
				"startedAt",
				"state",
			]);
			expect(attachment).toMatchObject({
				descriptorPath: path.join(workspace, ".gjc", "state", "sdk", `${sessionId}.json`),
				descriptorStat: {
					dev: expect.any(Number),
					ino: expect.any(Number),
					size: expect.any(Number),
					mtimeMs: expect.any(Number),
				},
				payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				expectedSessionId: sessionId,
				expectedCwd: workspace,
				tmuxSocket: expect.any(String),
				tmuxPane: expect.stringMatching(/^%\d+$/),
				tmuxPanePid: expect.any(Number),
				tmuxOwnershipTag: expect.stringMatching(/^openwebui-gjc-[0-9a-f-]{36}$/),
				ownedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			});
			expect(Object.keys(attachment).sort()).toEqual([
				"descriptorPath",
				"descriptorStat",
				"expectedCwd",
				"expectedSessionId",
				"generation",
				"ownedAt",
				"payloadDigest",
				"tmuxOwnershipTag",
				"tmuxPane",
				"tmuxPanePid",
				"tmuxSocket",
			]);
			expect(JSON.stringify(operation)).not.toMatch(/assistant|PASS|private|TOKEN|\\u0000/);
			const afterFailure = await harness.effects();
			expect(afterFailure.coordinator.setterAttempts).toBe(beforeFailure.coordinator.setterAttempts + 2);
			expect(afterFailure.coordinator.setters).toHaveLength(beforeFailure.coordinator.setters.length + 2);
			expect(afterFailure.coordinator.promptCount).toBe(beforeFailure.coordinator.promptCount + 1);
			expect(afterFailure.coordinator.selection.thinkingLevel).toBe("off");
			expect(afterFailure.projectLookups).toBe(beforeFailure.projectLookups + 1);
			expectNoDeliveryMutation(beforeFailure, afterFailure);
		} finally {
			await harness.stop();
		}
	}, 15_000);

	test("proves sequential and overlapping global LWW from setter-success transcript order", async () => {
		const harness = await RealSelectionHarness.start();
		try {
			const runtime = await harness.runtimeReceipt();
			expect(runtime.cwd).toBe(harness.root);
			expect(runtime.config).toMatchObject({
				statePath: path.join(harness.root, "state"),
				sessionRoot: path.join(harness.root, "sessions"),
			});
			expect(path.relative(harness.root, runtime.config.neutralWorkspace).startsWith("..")).toBeFalse();
			await harness.chat(LOW_MODEL_ID, { id: "a-to-b-a" });
			await harness.chat(OFF_MODEL_ID, { id: "a-to-b-b" });
			expect(harness.coordinator.snapshot().selection.thinkingLevel).toBe("off");
			await harness.chat(OFF_MODEL_ID, { id: "b-to-a-b" });
			await harness.chat(MEDIUM_MODEL_ID, { id: "b-to-a-a" });
			expect(harness.coordinator.snapshot().selection.thinkingLevel).toBe("medium");

			harness.coordinator.holdNextSetters(2);
			const first = harness.chat(LOW_MODEL_ID, { id: "overlap-low" });
			const second = harness.chat(OFF_MODEL_ID, { id: "overlap-off" });
			await harness.coordinator.waitForHeldSetters();
			harness.coordinator.releaseSetters();
			expect(await first).toMatchObject({ status: 200, body: { model: LOW_MODEL_ID } });
			expect(await second).toMatchObject({ status: 200, body: { model: OFF_MODEL_ID } });
			const mappings = await harness.mappingEntries();
			const selectionFor = (chatId: string) => mappings.find(row => row.chatId === chatId)?.modelSelection;
			expect(selectionFor("chat-overlap-low")).toMatchObject({ thinkingLevel: "low" });
			expect(selectionFor("chat-overlap-off")).toMatchObject({ thinkingLevel: "off" });

			const snapshot = harness.coordinator.snapshot();
			const lastSuccess = snapshot.transcript.filter(row => row.startsWith("setter_success:")).at(-1);
			expect(lastSuccess).toBeDefined();
			const finalCanonical = `gjc/${lastSuccess?.slice("setter_success:".length)}`;
			expect(await harness.chat("gjc", { id: "lww-admin", content: "/gjc project list" })).toMatchObject({
				status: 200,
				body: { model: finalCanonical },
			});
			expect(snapshot.setters.length).toBeGreaterThan(0);
		} finally {
			await harness.stop();
		}
	}, 20_000);
});
