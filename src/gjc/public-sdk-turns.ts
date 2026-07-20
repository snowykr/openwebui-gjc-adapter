import type { PublicSdkGate, PublicSdkSessionAttachment, PublicSdkTurnOutcome } from "./public-sdk-contract";
import { createPublicSdkDeadline } from "./public-sdk-deadline";
import type { SdkV3Client } from "./sdk-v3-client";
import {
	parseLastAssistant,
	parseRecord,
	requiredString,
	type SdkRecord,
	SdkV3OperationError,
} from "./sdk-v3-protocol";
import { SdkTerminalWindow } from "./sdk-v3-terminal";

export interface PublicSdkTurnContext {
	readonly client: SdkV3Client;
	readonly attachment: PublicSdkSessionAttachment;
	readonly authority: <T>(timeoutMs: number, effect: (client: SdkV3Client) => Promise<T>) => Promise<T>;
	readonly mutate: (operation: string, input: SdkRecord, key?: string, timeoutMs?: number) => Promise<unknown>;
}

export async function runTurn(
	context: PublicSdkTurnContext,
	operation: string,
	input: SdkRecord,
	key: string | undefined,
	timeoutMs: number,
): Promise<PublicSdkTurnOutcome> {
	const { attachment, client } = context;
	const deadline = createPublicSdkDeadline(timeoutMs, `${operation} timed out after ${timeoutMs}ms`);
	const window = new SdkTerminalWindow(client, attachment.sessionId);
	try {
		await window.captureGateBaseline(deadline.remaining());
		window.beginMutation();
		const accepted = parseRecord(
			await context.authority(deadline.remaining(), () =>
				context.mutate(operation, input, key, deadline.remaining()),
			),
			`${operation} result`,
		);
		const correlation = {
			sessionId: attachment.sessionId,
			commandId: requiredString(accepted, "commandId", `${operation} result`),
			turnId: requiredString(accepted, "turnId", `${operation} result`),
		};
		window.accept(correlation);
		const value = await addAssistantFallback(context, window.wait(correlation, deadline.remaining()), deadline);
		await context.authority(deadline.remaining(), async () => undefined);
		return value;
	} finally {
		window.close();
	}
}

export async function runGateTurn(
	context: PublicSdkTurnContext,
	gate: PublicSdkGate,
	answer: unknown,
	key: string | undefined,
	timeoutMs: number,
): Promise<PublicSdkTurnOutcome> {
	const { attachment, client } = context;
	if (gate.correlation.sessionId !== attachment.sessionId) {
		throw new SdkV3OperationError("endpoint_stale", "Workflow gate belongs to another session");
	}
	const deadline = createPublicSdkDeadline(timeoutMs, `workflow.gate_answer timed out after ${timeoutMs}ms`);
	const window = new SdkTerminalWindow(client, attachment.sessionId);
	try {
		await window.captureGateBaseline(deadline.remaining());
		window.beginMutation();
		await context.authority(deadline.remaining(), () =>
			context.mutate(
				"workflow.gate_answer",
				{ id: gate.gateId, response: answer, expectedSessionId: attachment.sessionId },
				key,
				deadline.remaining(),
			),
		);
		window.accept(gate.correlation);
		const value = await addAssistantFallback(context, window.wait(gate.correlation, deadline.remaining()), deadline);
		await context.authority(deadline.remaining(), async () => undefined);
		return value;
	} finally {
		window.close();
	}
}

export function waitForReply(
	client: SdkV3Client,
	sessionId: string,
	actionId: string,
	timeoutMs: number,
): { readonly promise: Promise<void>; readonly cancel: () => void } {
	let unsubscribe: (() => void) | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const cleanup = () => {
		if (timeout !== undefined) clearTimeout(timeout);
		unsubscribe?.();
		unsubscribe = undefined;
	};
	const settle = (effect: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		effect();
	};
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void promise.catch(() => undefined);
	timeout = setTimeout(() => {
		settle(() => reject(new SdkV3OperationError("timeout", `Reply resolution timed out after ${timeoutMs}ms`)));
	}, timeoutMs);
	timeout.unref?.();
	unsubscribe = client.onFrame(frame => {
		const event =
			frame.type === "event" && typeof frame.payload === "object" && frame.payload !== null
				? parseRecord(frame.payload, "event payload")
				: frame;
		if (event.type !== "action_resolved" && event.type !== "reply_rejected") return;
		if (event.sessionId !== sessionId || (event.actionId !== actionId && event.id !== actionId)) return;
		if (event.type === "reply_rejected") {
			settle(() =>
				reject(
					new SdkV3OperationError(
						"reply_rejected",
						typeof event.message === "string" ? event.message : "SDK rejected reply",
					),
				),
			);
			return;
		}
		settle(resolve);
	});
	if (settled) cleanup();
	return { promise, cancel: () => settle(resolve) };
}

async function addAssistantFallback(
	context: PublicSdkTurnContext,
	outcome: Promise<PublicSdkTurnOutcome>,
	deadline: ReturnType<typeof createPublicSdkDeadline>,
): Promise<PublicSdkTurnOutcome> {
	const value = await outcome;
	if (value.finalizedAssistantText !== undefined) return value;
	const text = parseLastAssistant(await context.client.queryAll("session.last_assistant", {}, deadline.remaining()));
	return text === null ? value : { ...value, finalizedAssistantText: text };
}
