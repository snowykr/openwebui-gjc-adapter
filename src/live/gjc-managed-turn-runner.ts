import type { ManagedSdkRuntime } from "../gjc/managed-sdk-runtime";
import type {
	GjcCancelTurnInput,
	GjcControlResult,
	GjcLifecyclePublicationAddress,
	GjcLifecycleTransaction,
	GjcRespondWorkflowGateInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcTurnResult,
	ManagedTurnAuthority,
} from "../gjc/turn-runner";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "./chat-completions";
import {
	createManagedSessionOperations,
	type ManagedGateInput,
	type ManagedLifecycleInput,
	type ManagedSessionOperations,
	type ManagedTurnInput,
} from "./gjc-managed-session-operations";

export type ManagedRunnerStartInput = GjcStartNewSessionInput & {
	readonly authority: Omit<ManagedTurnAuthority, "sessionId" | "generation">;
	/** Create always maps to public lifecycle createExternal existing_path. */
	readonly lifecycleTarget: Readonly<{ path: string }>;
};
export type ManagedRunnerContinueInput = import("../gjc/turn-runner").GjcContinueSessionInput & {
	readonly authority: ManagedTurnAuthority;
};
export type ManagedRunnerGateInput = GjcRespondWorkflowGateInput & { readonly authority: ManagedTurnAuthority };
export type ManagedRunnerStateInput = GjcSessionStateInput & { readonly authority: ManagedTurnAuthority };
export type ManagedRunnerCloseInput = {
	readonly authority: ManagedTurnAuthority;
	readonly target: Readonly<Record<string, unknown>>;
};

/**
 * Deliberately unwired managed equivalent of the supported GjcTurnRunner surface.
 * Session switching is absent: a managed tenant key is exact-generation authority,
 * not a mutable current-session pointer.
 */
export interface ManagedGjcTurnRunner {
	readonly operations: ManagedSessionOperations;
	create(input: ManagedRunnerStartInput): Promise<GjcTurnResult>;
	resume(input: ManagedLifecycleInput): Promise<unknown>;
	continue(input: ManagedRunnerContinueInput): Promise<GjcTurnResult>;
	continueSession(input: ManagedRunnerContinueInput): Promise<GjcTurnResult>;
	control(input: ManagedRunnerGateInput | ManagedRunnerContinueInput): Promise<GjcControlResult>;
	gate(input: ManagedRunnerGateInput): Promise<GjcTurnResult>;
	respondWorkflowGate(input: ManagedRunnerGateInput): Promise<GjcTurnResult>;
	cancel(input: GjcCancelTurnInput & { readonly authority: ManagedTurnAuthority }): Promise<void>;
	cancelTurn(input: GjcCancelTurnInput & { readonly authority: ManagedTurnAuthority }): Promise<void>;
	closePreflight(input: ManagedRunnerCloseInput): Promise<unknown>;
	getState(input: ManagedRunnerStateInput): Promise<GjcSessionState>;
	getAvailableModels(input: ManagedRunnerStateInput): Promise<readonly unknown[]>;
	withLifecyclePublication?<T>(
		_address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	withLifecycleClosePreflight?<T>(
		_address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	startNewSession?<T>(
		input: ManagedRunnerStartInput,
		publish: (result: GjcSessionAddress & GjcTurnResult) => Promise<T>,
		beforePrompt: (address: GjcSessionAddress) => Promise<void>,
	): Promise<T>;
}

export function createManagedGjcTurnRunner(runtime: ManagedSdkRuntime): ManagedGjcTurnRunner {
	const operations = createManagedSessionOperations(runtime);
	return {
		operations,
		async create(input) {
			throwIfAborted(input.signal);
			const lifecycle = await operations.create({
				authority: input.authority as ManagedTurnAuthority,
				target: input.lifecycleTarget,
			});
			const authority = {
				...input.authority,
				sessionId: lifecycle.tenant.sessionId,
				generation: lifecycle.tenant.generation,
			};
			try {
				return await operations.prompt(turnInput({ ...input, authority }, "turn.prompt"));
			} catch (error) {
				await closeAfterPrePromptFailure(operations, authority, input.lifecycleTarget, error);
				throw error;
			}
		},
		resume: input => operations.resume(input),
		continue: input => operations.followUp(turnInput(input, "turn.follow_up")),
		continueSession: input => operations.followUp(turnInput(input, "turn.follow_up")),
		async control(input) {
			if ("gateId" in input) return { result: await operations.answerGate(gateInput(input)) };
			return {
				result: await operations
					.request({ ...turnInput(input, "turn.steer"), operation: "turn.steer", input: { text: input.text } })
					.then(result => ({
						text: typeof result.text === "string" ? result.text : "",
						events: [],
						rawFrameCursor: 0,
						eventCursor: 0,
					})),
			};
		},
		gate: input => operations.answerGate(gateInput(input)),
		respondWorkflowGate: input => operations.answerGate(gateInput(input)),
		async cancel(input) {
			await operations.abort({
				authority: input.authority,
				operation: "turn.abort",
				idempotencyKey: input.authority.requestKey,
			});
		},
		async cancelTurn(input) {
			await operations.abort({
				authority: input.authority,
				operation: "turn.abort",
				idempotencyKey: input.authority.requestKey,
			});
		},
		closePreflight: input => operations.close({ authority: input.authority, target: input.target }),
		async getState(input) {
			await operations.getState(input.authority);
			return {
				...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
				rawFrameCursor: 0,
				eventCursor: 0,
			};
		},
		getAvailableModels: input => operations.getModels(input.authority),
		async startNewSession(input, publish, beforePrompt) {
			const lifecycle = await operations.create({
				authority: input.authority as ManagedTurnAuthority,
				target: input.lifecycleTarget,
			});
			const authority = {
				...input.authority,
				sessionId: lifecycle.tenant.sessionId,
				generation: lifecycle.tenant.generation,
			};
			const address = {
				cwd: input.cwd,
				sessionRoot: input.sessionRoot,
				projectId: input.projectId,
				chatId: input.chatId,
				sessionId: authority.sessionId,
			};
			await beforePrompt(address);
			const result = await operations.prompt(turnInput({ ...input, authority }, "turn.prompt"));
			return await publish({ ...address, ...result });
		},
	};
}

function turnInput(
	input: (ManagedRunnerStartInput & { readonly authority: ManagedTurnAuthority }) | ManagedRunnerContinueInput,
	operation: string,
): ManagedTurnInput {
	return {
		authority: input.authority,
		operation,
		text: input.text,
		signal: input.signal,
		observer: input.observer,
		onDispatch: "onDispatch" in input ? input.onDispatch : undefined,
	};
}
function gateInput(input: ManagedRunnerGateInput): ManagedGateInput {
	return {
		authority: input.authority,
		operation: "workflow.gate_answer",
		gateId: input.gateId,
		answer: input.answer,
		correlation: input.gateCorrelation ?? {
			commandId: input.operationId,
			turnId: input.operationId,
			sessionId: input.sessionId,
		},
		signal: input.signal,
		observer: input.observer,
		onDispatch: input.onDispatch,
		idempotencyKey: input.idempotencyKey,
	};
}
async function closeAfterPrePromptFailure(
	operations: ManagedSessionOperations,
	authority: ManagedTurnAuthority,
	target: Readonly<Record<string, unknown>>,
	original: unknown,
): Promise<void> {
	try {
		await operations.close({
			authority,
			target: { ...target, sessionId: authority.sessionId, endpointGeneration: authority.generation },
		});
	} catch (closeError) {
		throw new AggregateError([original, closeError], "Managed pre-prompt failure cleanup is uncertain.");
	}
}
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

// Keeps the import contract visible to the eventual routing cutover without wiring it today.
export type ManagedControlInput = LiveGatewayRunnerInput;
