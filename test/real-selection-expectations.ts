import { expect } from "bun:test";
import { type ModelSelectionErrorCode, modelSelectionError } from "../src/live/model-selection-errors";
import type { RealSelectionHarness } from "./real-selection-harness";

type Effects = Awaited<ReturnType<RealSelectionHarness["effects"]>>;

export async function expectSelectionError(
	result: Promise<{ readonly status: number; readonly error?: { readonly error: { readonly code: string } } }>,
	status: number,
	code: ModelSelectionErrorCode,
	requestedModelId?: string,
): Promise<void> {
	const expected = modelSelectionError(code, requestedModelId);
	expect(await result).toMatchObject({
		status,
		error: { error: { code, type: expected.type, message: expected.message } },
	});
}

export function expectNoDeliveryMutation(before: Effects, after: Effects): void {
	expect(after.events).toEqual(before.events);
	expect(after.messages).toEqual(before.messages);
	expect(after.outbox).toEqual(before.outbox);
}
