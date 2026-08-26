import { resolve } from "node:path";
import type { NormalizedModelSelection } from "../contracts";
import { ManagedSdkOperationError, type ManagedSdkRuntime } from "../gjc/managed-sdk-runtime";
import type { SessionAttachmentProof } from "../gjc/session-authority";
import { SESSION_AUTHORITY_V3_EPOCH } from "../gjc/session-authority-v3";
import { normalizeModelSelection } from "../gjc/session-operation-codec";
import type { SessionMapping } from "../gjc/session-router";
import type {
	GjcCancelTurnInput,
	GjcContinueSessionInput,
	GjcControlResult,
	GjcLifecyclePublicationAddress,
	GjcLifecycleTransaction,
	GjcRespondWorkflowGateInput,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
	ManagedPreparedTurnAuthority,
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
import { createManagedSuccessorFlow, type ManagedSuccessorFlow } from "./gjc-managed-successor";

export type ManagedRunnerStartInput = GjcStartNewSessionInput & {
	readonly preparedManagedAuthority: ManagedPreparedTurnAuthority;
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

/** Managed implementation of the supported GjcTurnRunner surface. */
export interface ManagedGjcTurnRunner extends GjcTurnRunner {
	readonly operations: ManagedSessionOperations;
	readonly forkManagedSuccessor: ManagedSuccessorFlow["fork"];
	create(input: ManagedRunnerStartInput): Promise<GjcTurnResult>;
	resume(input: ManagedLifecycleInput): Promise<unknown>;
	continue(input: ManagedRunnerContinueInput): Promise<GjcTurnResult>;
	continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult>;
	control(input: ManagedRunnerGateInput | ManagedRunnerContinueInput): Promise<GjcControlResult>;
	gate(input: ManagedRunnerGateInput): Promise<GjcTurnResult>;
	respondWorkflowGate(input: GjcRespondWorkflowGateInput): Promise<GjcTurnResult>;
	cancel(input: GjcCancelTurnInput & { readonly authority: ManagedTurnAuthority }): Promise<void>;
	cancelTurn(input: GjcCancelTurnInput): Promise<void>;
	closePreflight(input: ManagedRunnerCloseInput): Promise<unknown>;
	getState(input: GjcSessionStateInput): Promise<GjcSessionState>;
	getAvailableModels(input: GjcSessionStateInput): Promise<readonly unknown[]>;
	withLifecyclePublication<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	withLifecycleClosePreflight<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T>;
	startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress,
			attachment: SessionAttachmentProof,
			lifecycle: GjcLifecycleTransaction,
		) => Promise<void>,
		onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	): Promise<T>;
	startManagedSession<T>(
		input: GjcStartNewSessionInput & { readonly preparedManagedAuthority: ManagedPreparedTurnAuthority },
		publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
		beforePrompt: (
			address: GjcSessionAddress,
			proof: import("../gjc/turn-runner").ManagedGenerationProof,
			lifecycle: GjcLifecycleTransaction,
		) => Promise<void>,
		onFailure?: (lifecycle: GjcLifecycleTransaction, error: unknown) => Promise<void>,
	): Promise<T>;
}

const managedLifecycleAuthorities = new WeakMap<object, ManagedTurnAuthority>();

export function createManagedGjcTurnRunner(runtime: ManagedSdkRuntime): ManagedGjcTurnRunner {
	const operations = createManagedSessionOperations(runtime);
	const forkManagedSuccessor = createManagedSuccessorFlow(runtime);
	return {
		operations,
		forkManagedSuccessor: forkManagedSuccessor.fork,
		async create(input) {
			throwIfAborted(input.signal);
			const lifecycle = await operations.create({
				authority: input.preparedManagedAuthority,
				target: { path: input.cwd },
			});
			const authority: ManagedTurnAuthority = {
				...input.preparedManagedAuthority,
				sessionId: lifecycle.tenant.sessionId,
				generation: lifecycle.tenant.generation,
			};
			try {
				const modelSelection = await applyManagedModelSelection(operations, authority, input.modelSelection);
				return withManagedProof(
					withManagedModelSelection(
						await operations.prompt(turnInput({ ...input, authority }, "turn.prompt")),
						modelSelection,
					),
					authority,
				);
			} catch (error) {
				await closeAfterPrePromptFailure(operations, authority, { path: input.cwd }, error);
				throw error;
			}
		},
		resume: input => operations.resume(input),
		continue: async input => {
			bindManagedLifecycleAuthority(input.lifecycle, input.authority);
			const modelSelection = await applyManagedModelSelection(operations, input.authority, input.modelSelection);
			const result = await operations.followUp(turnInput(input, "turn.follow_up"));
			await operations.acquire(input.authority);
			return withManagedProof(withManagedModelSelection(result, modelSelection), input.authority);
		},
		continueSession: async input => {
			const authority = managedAuthorityFor(input, "turn.follow_up");
			bindManagedLifecycleAuthority(input.lifecycle, authority);
			const modelSelection = await applyManagedModelSelection(operations, authority, input.modelSelection);
			const result = await operations.followUp(turnInput({ ...input, authority }, "turn.follow_up"));
			await operations.acquire(authority);
			return withManagedProof(withManagedModelSelection(result, modelSelection), authority);
		},
		async control(input) {
			if ("gateId" in input) {
				bindManagedLifecycleAuthority(input.lifecycle, input.authority);
				return { result: await operations.answerGate(gateInput(input)) };
			}
			bindManagedLifecycleAuthority(input.lifecycle, input.authority);
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
		gate: async input => {
			bindManagedLifecycleAuthority(input.lifecycle, input.authority);
			return withManagedProof(await operations.answerGate(gateInput(input)), input.authority);
		},
		respondWorkflowGate: async input => {
			const authority = managedAuthorityFor(input, "workflow.gate_answer");
			bindManagedLifecycleAuthority(input.lifecycle, authority);
			return withManagedProof(await operations.answerGate(gateInput({ ...input, authority })), authority);
		},
		async cancel(input) {
			await operations.abort({
				authority: input.authority,
				operation: "turn.abort",
				idempotencyKey: input.authority.requestKey,
			});
		},
		async cancelTurn(input) {
			const authority = managedAuthorityForCancel(input);
			await operations.abort({
				authority,
				operation: "turn.abort",
				idempotencyKey: authority.requestKey,
			});
		},
		async runControl(input, mapping, lifecycle, _onAcknowledgedSuccessor, onDispatch) {
			const control = input.control;
			if (control === undefined) throw new Error("OpenWebUI control request was not supplied.");
			const authority = managedControlAuthority(input, mapping);
			bindManagedLifecycleAuthority(lifecycle, authority);
			if (control.operation === "branch") {
				const { sessionId: _sessionId, generation: _generation, ...target } = authority;
				const successor = await forkManagedSuccessor.fork({
					source: authority,
					target,
					signal: input.signal,
					publish: () => undefined,
				});
				throwIfAborted(input.signal);
				return {
					sessionId: successor.managedAuthority.sessionId,
					result: withManagedProof(emptyControlResult(), successor.managedAuthority),
				};
			}
			if (control.operation === "session.new" || control.operation === "session.resume") {
				const lifecycleResult =
					control.operation === "session.new"
						? await operations.create({ authority, target: { path: authority.canonicalWorkspace } })
						: await operations.resume({
								authority,
								target: {
									sessionIdOrPrefix: control.sessionId ?? authority.sessionId,
									path: authority.canonicalWorkspace,
								},
							});
				assertResumedExactAuthority(lifecycleResult, authority);
				return {
					sessionId: authority.sessionId,
					result: withManagedProof(emptyControlResult(), authority),
				};
			}
			if (control.operation === "abort_and_prompt") {
				const result = await operations.abortAndPrompt({
					authority,
					operation: "turn.abort_and_prompt",
					text: control.text ?? input.prompt,
					idempotencyKey: authority.requestKey,
					signal: input.signal,
					onDispatch,
				});
				throwIfAborted(input.signal);
				await operations.acquire(authority);
				throwIfAborted(input.signal);
				return { result: withManagedProof(result, authority) };
			}
			const operation = managedControlOperation(control);
			await operations.request({
				authority,
				operation,
				input: managedControlInput(control, input),
				idempotencyKey: authority.requestKey,
				signal: input.signal,
				onDispatch,
			});
			await operations.acquire(authority);
			return { result: withManagedProof(emptyControlResult(), authority) };
		},
		closePreflight: input => operations.close({ authority: input.authority, target: input.target }),
		async getState(input) {
			const authority = managedAuthorityFor(input, "session.state");
			bindManagedLifecycleAuthority(input.lifecycle, authority);
			return {
				...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
				rawFrameCursor: 0,
				eventCursor: 0,
				managedProof: managedProof(authority),
				managedAuthority: authority,
			};
		},
		getAvailableModels: input => {
			const authority = managedAuthorityFor(input, "models.list/current");
			bindManagedLifecycleAuthority(input.lifecycle, authority);
			return operations.getModels(authority);
		},
		withLifecyclePublication: async (address, effect) => effect(managedLifecycleTransaction(address)),
		withLifecycleClosePreflight: async (address, effect) => effect(managedLifecycleTransaction(address)),
		async startNewSession(_input, _publish, _beforePrompt, _onFailure) {
			throw new Error("Managed GJC runner rejects the legacy startNewSession entry point.");
		},
		async startManagedSession(input, publish, beforePrompt, onFailure) {
			const lifecycleResult = await operations.create({
				authority: input.preparedManagedAuthority,
				target: { path: input.cwd },
			});
			const authority: ManagedTurnAuthority = {
				...input.preparedManagedAuthority,
				sessionId: lifecycleResult.tenant.sessionId,
				generation: lifecycleResult.tenant.generation,
				authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			} as ManagedTurnAuthority & { readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH };
			const address = {
				cwd: input.cwd,
				sessionRoot: input.sessionRoot,
				projectId: input.projectId,
				chatId: input.chatId,
				sessionId: authority.sessionId,
			};
			const transaction = managedLifecycleTransaction(address, authority);
			try {
				await beforePrompt(address, managedProof(authority), transaction);
				const modelSelection = await applyManagedModelSelection(operations, authority, input.modelSelection);
				const result = withManagedProof(
					withManagedModelSelection(
						await operations.prompt(
							turnInput(
								{ ...input, preparedManagedAuthority: input.preparedManagedAuthority, authority },
								"turn.prompt",
							),
						),
						modelSelection,
					),
					authority,
				);
				return await publish({ ...address, ...result }, transaction);
			} catch (error) {
				await onFailure?.(transaction, error);
				await closeAfterPrePromptFailure(operations, authority, { path: input.cwd }, error);
				throw error;
			}
		},
	};
}

function managedLifecycleTransaction(
	address: GjcLifecyclePublicationAddress,
	authority?: ManagedTurnAuthority,
): GjcLifecycleTransaction {
	const owner = {};
	const transaction: GjcLifecycleTransaction = {
		address,
		owner,
		assertClosePreflight(): never {
			throw new Error("Managed lifecycle close uses exact generation retirement proof.");
		},
		async publish(): Promise<never> {
			throw new Error("Managed lifecycle cannot publish legacy attachment authority.");
		},
		async publishManaged(proof, write) {
			const bound = managedLifecycleAuthorities.get(transaction);
			if (bound === undefined) throw new Error("Managed lifecycle publication requires complete bound authority.");
			assertManagedLifecyclePublication(address, bound, proof);
			return write();
		},
		async publishClosed(): Promise<never> {
			throw new Error("Managed lifecycle close publication requires managed retirement state.");
		},
		handoff(): Promise<never> {
			throw new Error("Managed successor handoff uses public lifecycle fork authority.");
		},
	};
	if (authority !== undefined) bindManagedLifecycleAuthority(transaction, authority);
	return transaction;
}

function bindManagedLifecycleAuthority(
	lifecycle: GjcLifecycleTransaction | undefined,
	authority: ManagedTurnAuthority,
): void {
	if (lifecycle === undefined) return;
	if (lifecycle.address === undefined) return;
	const current = managedLifecycleAuthorities.get(lifecycle);
	if (current !== undefined && !sameManagedAuthority(current, authority))
		throw new Error("Managed lifecycle transaction authority changed.");
	assertCompleteManagedAuthority(authority);
	assertManagedLifecycleAddress(lifecycle.address, authority);
	managedLifecycleAuthorities.set(lifecycle, authority);
}

function assertManagedLifecyclePublication(
	address: GjcLifecyclePublicationAddress,
	authority: ManagedTurnAuthority,
	proof: import("../gjc/turn-runner").ManagedGenerationProof,
): void {
	assertCompleteManagedAuthority(authority);
	assertManagedLifecycleAddress(address, authority);
	if (
		proof.kind !== "managed-generation" ||
		proof.sessionId !== authority.sessionId ||
		!Number.isSafeInteger(proof.generation) ||
		proof.generation <= 0 ||
		proof.generation !== authority.generation ||
		proof.leaseId !== authority.leaseId ||
		proof.epoch !== authority.epoch
	)
		throw new Error("Managed lifecycle publication proof changed.");
}

function assertManagedLifecycleAddress(address: GjcLifecyclePublicationAddress, authority: ManagedTurnAuthority): void {
	if (
		address.projectId !== authority.projectId ||
		address.chatId !== authority.chatId ||
		address.sessionId !== authority.sessionId ||
		resolve(address.cwd) !== authority.canonicalWorkspace
	)
		throw new Error("Managed lifecycle transaction address does not match exact authority.");
}

function assertCompleteManagedAuthority(authority: ManagedTurnAuthority): void {
	if (
		!authority.principalId ||
		!authority.projectId ||
		!authority.canonicalWorkspace ||
		!authority.chatId ||
		!authority.sessionId ||
		!Number.isSafeInteger(authority.generation) ||
		authority.generation <= 0 ||
		!authority.leaseId ||
		!authority.epoch ||
		!authority.requestKey
	)
		throw new Error("Complete positive ManagedTurnAuthority is required for lifecycle publication.");
}

function sameManagedAuthority(left: ManagedTurnAuthority, right: ManagedTurnAuthority): boolean {
	return (
		left.principalId === right.principalId &&
		left.projectId === right.projectId &&
		left.canonicalWorkspace === right.canonicalWorkspace &&
		left.chatId === right.chatId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation &&
		left.leaseId === right.leaseId &&
		left.epoch === right.epoch &&
		left.requestKey === right.requestKey
	);
}

function managedAuthorityFor(
	input: {
		readonly managedAuthority?: ManagedTurnAuthority;
		readonly cwd: string;
		readonly projectId: string;
		readonly chatId: string;
		readonly sessionId: string;
		readonly principalId?: string;
	},
	operation: string,
): ManagedTurnAuthority {
	const authority = input.managedAuthority;
	if (authority === undefined) throw new Error(`Managed ${operation} requires persisted managed authority.`);
	if (
		authority.projectId !== input.projectId ||
		authority.chatId !== input.chatId ||
		authority.sessionId !== input.sessionId ||
		authority.canonicalWorkspace !== resolve(input.cwd) ||
		(input.principalId !== undefined && authority.principalId !== input.principalId)
	)
		throw new Error(`Managed ${operation} authority does not exactly match the session address.`);
	return authority;
}

function managedAuthorityForCancel(input: GjcCancelTurnInput): ManagedTurnAuthority {
	const authority = input.managedAuthority;
	if (authority === undefined) throw new Error("Managed turn.abort requires persisted managed authority.");
	if (
		authority.projectId !== input.projectId ||
		authority.chatId !== input.chatId ||
		(input.sessionId !== undefined && authority.sessionId !== input.sessionId) ||
		(input.principalId !== undefined && authority.principalId !== input.principalId)
	)
		throw new Error("Managed turn.abort authority does not exactly match the cancellation address.");
	return authority;
}

function assertResumedExactAuthority(
	resumed: Awaited<ReturnType<ManagedSessionOperations["resume"]>>,
	authority: ManagedTurnAuthority,
): void {
	const tenant = resumed.tenant;
	if (
		tenant.principalId !== authority.principalId ||
		tenant.projectId !== authority.projectId ||
		tenant.canonicalWorkspace !== authority.canonicalWorkspace ||
		tenant.chatId !== authority.chatId ||
		tenant.sessionId !== authority.sessionId ||
		tenant.generation !== authority.generation ||
		tenant.leaseId !== authority.leaseId ||
		tenant.epoch !== authority.epoch
	)
		throw new Error("Managed session.resume changed exact managed authority.");
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
		signal: input.signal,
		observer: input.observer,
		onDispatch: input.onDispatch,
		idempotencyKey: input.idempotencyKey,
	};
}

async function applyManagedModelSelection(
	operations: ManagedSessionOperations,
	authority: ManagedTurnAuthority,
	selection: NormalizedModelSelection | undefined,
): Promise<NormalizedModelSelection | undefined> {
	if (selection === undefined) return undefined;
	const requested = normalizeModelSelection(selection);
	if (requested === undefined)
		throw new ManagedSdkOperationError("invalid_result", "Managed model selection is not normalized.");

	let modelResult: Readonly<Record<string, unknown>>;
	try {
		modelResult = await operations.setModel(authority, requested);
	} catch (error) {
		throw managedSelectionMutationError("model_set_failed", "model.set", error);
	}
	const modelSelection = normalizeModelSelection(modelResult);
	if (!sameModelSelection(modelSelection, requested))
		throw new ManagedSdkOperationError("invalid_result", "model.set did not confirm the requested selection.");

	let thinkingResult: Readonly<Record<string, unknown>>;
	try {
		thinkingResult = await operations.setThinking(authority, requested.thinkingLevel);
	} catch (error) {
		throw managedSelectionMutationError("thinking_set_failed", "thinking.set", error);
	}
	const currentSelection = normalizeModelSelection(thinkingResult);
	if (currentSelection !== undefined) {
		if (!sameModelSelection(currentSelection, requested))
			throw new ManagedSdkOperationError("invalid_result", "thinking.set did not confirm the requested selection.");
	} else if (!isChangedAcknowledgement(thinkingResult)) {
		throw new ManagedSdkOperationError(
			"invalid_result",
			"thinking.set returned an invalid selection acknowledgement.",
		);
	}
	return requested;
}

function managedSelectionMutationError(
	code: "model_set_failed" | "thinking_set_failed",
	operation: string,
	error: unknown,
): ManagedSdkOperationError | GjcTurnCancelledError {
	if (error instanceof GjcTurnCancelledError) return error;
	if (
		error instanceof ManagedSdkOperationError &&
		["model_set_failed", "thinking_set_failed", "invalid_result"].includes(error.code)
	)
		return error;
	const message = error instanceof Error ? error.message : String(error);
	return new ManagedSdkOperationError(
		code,
		`Managed ${operation} failed${message.length === 0 ? "" : `: ${message}`}`,
	);
}

function isChangedAcknowledgement(value: Readonly<Record<string, unknown>>): boolean {
	return Object.keys(value).length === 1 && value.changed === true;
}

function sameModelSelection(left: NormalizedModelSelection | undefined, right: NormalizedModelSelection): boolean {
	return (
		left !== undefined &&
		left.provider === right.provider &&
		left.modelId === right.modelId &&
		left.thinkingLevel === right.thinkingLevel
	);
}

function withManagedModelSelection(
	result: GjcTurnResult,
	selection: NormalizedModelSelection | undefined,
): GjcTurnResult {
	return selection === undefined ? result : { ...result, modelSelection: selection };
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

function managedProof(authority: ManagedTurnAuthority) {
	return {
		kind: "managed-generation" as const,
		sessionId: authority.sessionId,
		generation: authority.generation,
		leaseId: authority.leaseId,
		epoch: authority.epoch,
	};
}

function withManagedProof(result: GjcTurnResult, authority: ManagedTurnAuthority): GjcTurnResult {
	return { ...result, managedProof: managedProof(authority), managedAuthority: authority };
}

function managedControlAuthority(input: LiveGatewayRunnerInput, mapping: SessionMapping): ManagedTurnAuthority {
	const authority = mapping.managedAuthority;
	if (authority === undefined) throw new Error("Managed control requires persisted managed authority.");
	if (
		authority.projectId !== mapping.projectId ||
		authority.chatId !== mapping.chatId ||
		authority.sessionId !== mapping.sessionId ||
		authority.canonicalWorkspace !== resolve(input.project.cwd) ||
		authority.principalId !== input.ownerUserId
	)
		throw new Error("Managed control authority does not exactly match the session mapping.");
	return authority;
}

function managedControlOperation(control: NonNullable<LiveGatewayRunnerInput["control"]>): string {
	switch (control.operation) {
		case "abort":
			return "turn.abort";
		case "steer":
			return "turn.steer";
		case "follow_up":
			return "turn.follow_up";
		case "abort_and_prompt":
			return "turn.abort_and_prompt";
		case "action_reply":
			return "ask.answer";
		case "workflow.plan_approve":
			return "workflow.plan_approve";
		default:
			throw new Error(`Unsupported managed control surface: ${control.operation}.`);
	}
}

function managedControlInput(
	control: NonNullable<LiveGatewayRunnerInput["control"]>,
	input: LiveGatewayRunnerInput,
): Readonly<Record<string, unknown>> {
	if (control.operation === "abort") return { mode: "terminal", scope: "turn" };
	if (control.operation === "action_reply") return { id: control.actionId, answer: control.answer };
	if (control.operation === "workflow.plan_approve") return control.input;
	return { text: "text" in control && control.text !== undefined ? control.text : input.prompt };
}

function emptyControlResult(): GjcTurnResult {
	return { text: "", events: [], rawFrameCursor: 0, eventCursor: 0 };
}
