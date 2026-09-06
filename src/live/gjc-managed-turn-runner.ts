import { resolve } from "node:path";
import type { NormalizedModelSelection } from "../contracts";
import { ManagedOperationDeadline } from "../gjc/managed-operation-deadline";
import { ManagedSdkOperationError, type ManagedSdkRuntime } from "../gjc/managed-sdk-runtime";
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
	ManagedLifecycleControlOwner,
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
import { controlOperationHash, lifecycleControlRequestKey } from "./gjc-routing-publication";

export type ManagedRunnerStartInput = GjcStartNewSessionInput & {
	readonly preparedManagedAuthority: ManagedPreparedTurnAuthority;
};
export type ManagedRunnerContinueInput = import("../gjc/turn-runner").GjcContinueSessionInput & {
	readonly authority: ManagedTurnAuthority;
};
export type ManagedRunnerGateInput = GjcRespondWorkflowGateInput & { readonly authority: ManagedTurnAuthority };
export type ManagedRunnerStateInput = GjcSessionStateInput & { readonly authority: ManagedTurnAuthority };

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
	getState(input: GjcSessionStateInput): Promise<GjcSessionState>;
	getAvailableModels(input: GjcSessionStateInput): Promise<readonly unknown[]>;
	withLifecyclePublication<T>(
		address: GjcLifecyclePublicationAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
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

export function createManagedGjcTurnRunner(runtime: ManagedSdkRuntime, turnTimeoutMs?: number): ManagedGjcTurnRunner {
	const operations = createManagedSessionOperations(runtime, turnTimeoutMs);
	const forkManagedSuccessor = createManagedSuccessorFlow(runtime, turnTimeoutMs);
	return {
		operations,
		forkManagedSuccessor: forkManagedSuccessor.fork,
		async create(input) {
			throwIfAborted(input.signal);
			const deadline = new ManagedOperationDeadline(turnTimeoutMs, "session.create/prompt");
			try {
				const lifecycle = await operations.create({
					authority: input.preparedManagedAuthority,
					target: { path: input.cwd },
					timeoutMs: deadline.remaining(),
					signal: input.signal,
					onAcknowledged: input.onLifecycleAcknowledged,
					onInvoking: input.onLifecycleInvoking,
					lifecycleOperation: input.lifecycleOperation,
				});
				const authority: ManagedTurnAuthority = {
					...input.preparedManagedAuthority,
					sessionId: lifecycle.tenant.sessionId,
					generation: lifecycle.tenant.generation,
				};
				try {
					const modelSelection = await deadline.wait(
						applyManagedModelSelection(operations, authority, input.modelSelection, deadline, input.signal),
					);
					return withManagedProof(
						withManagedModelSelection(
							await operations.prompt({
								...turnInput({ ...input, authority }, "turn.prompt"),
								timeoutMs: deadline.remaining(),
								beforeDispatch: () => {
									deadline.remaining();
								},
							}),
							modelSelection,
						),
						authority,
					);
				} catch (error) {
					await closeAfterPrePromptFailure(operations, authority, { path: input.cwd }, error, deadline);
					throw error;
				}
			} finally {
				deadline.close();
			}
		},
		resume: input => operations.resume(input),
		continue: async input => {
			bindManagedLifecycleAuthority(input.lifecycle, input.authority);
			return continueManagedTurn(operations, input, turnTimeoutMs);
		},
		continueSession: async input => {
			const authority = managedAuthorityFor(input, "turn.follow_up");
			bindManagedLifecycleAuthority(input.lifecycle, authority);
			return continueManagedTurn(operations, { ...input, authority }, turnTimeoutMs);
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
		async runControl(input, mapping, lifecycle, _onAcknowledgedSuccessor, onDispatch, lifecycleOwner, execution) {
			const control = input.control;
			if (control === undefined) throw new Error("OpenWebUI control request was not supplied.");
			throwIfAborted(input.signal);
			const deadline = new ManagedOperationDeadline(execution?.timeoutMs ?? turnTimeoutMs, "control");
			const beforeDispatch = () => {
				deadline.remaining();
				throwIfAborted(input.signal);
				execution?.beforeDispatch();
			};
			try {
				beforeDispatch();
				const authority = managedControlAuthority(input, mapping);
				bindManagedLifecycleAuthority(lifecycle, authority);
				if (control.operation === "branch") {
					throw new Error("Managed branch requires the gateway-owned forkManagedSuccessor flow.");
				}
				if (control.operation === "session.new" || control.operation === "session.resume") {
					if (control.operation === "session.resume" && control.sessionId !== authority.sessionId)
						throw new Error(
							"Managed selected resume requires persisted exact target authority before invocation.",
						);
					const owner = requireLifecycleControlOwner(input, authority, lifecycleOwner);
					const creating = control.operation === "session.new";
					const lifecycleResult = await (creating ? operations.create : operations.resume)({
						authority: creating ? owner.preparedAuthority : owner.source,
						target: creating
							? { path: authority.canonicalWorkspace }
							: { sessionIdOrPrefix: authority.sessionId, path: authority.canonicalWorkspace },
						timeoutMs: deadline.remaining(),
						signal: input.signal,
						lifecycleOperation: owner.lifecycleOperation,
						onInvoking: () => {
							beforeDispatch();
							return owner.onInvoking();
						},
						onAcknowledged: async acknowledged => {
							if (creating && acknowledged.sessionId === authority.sessionId)
								throw new Error("Managed session.new returned the source session.");
							if (!creating) assertResumedExactAuthority({ tenant: acknowledged }, owner.source);
							await owner.onAcknowledged(acknowledged);
						},
					});
					beforeDispatch();
					if (!creating) assertResumedExactAuthority(lifecycleResult, owner.source);
					if (!lifecycleResult.attachment.isCurrent())
						throw new Error("Managed lifecycle control proof is stale.");
					const proven = {
						...lifecycleResult.tenant,
						requestKey: owner.lifecycleOperation.requestKey,
						authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
					};
					assertResumedExactAuthority({ tenant: lifecycleResult.attachment.tenant }, proven);
					if (lifecycleResult.attachment.generation !== proven.generation)
						throw new Error("Managed lifecycle token generation changed.");
					return {
						sessionId: proven.sessionId,
						result: withManagedProof(emptyControlResult(), proven),
					};
				}
				if (control.operation === "abort_and_prompt" || control.operation === "follow_up") {
					const run = control.operation === "follow_up" ? operations.followUp : operations.abortAndPrompt;
					const result = await run({
						authority,
						operation: control.operation === "follow_up" ? "turn.follow_up" : "turn.abort_and_prompt",
						text: control.text ?? input.prompt,
						idempotencyKey: authority.requestKey,
						signal: input.signal,
						timeoutMs: deadline.remaining(),
						beforeDispatch,
						onDispatch,
					});
					beforeDispatch();
					return { result: withManagedProof(result, authority) };
				}
				const operation = managedControlOperation(control);
				await operations.request({
					authority,
					operation,
					input: managedControlInput(control, input),
					idempotencyKey: authority.requestKey,
					signal: input.signal,
					timeoutMs: deadline.remaining(),
					beforeDispatch,
					onDispatch,
				});
				beforeDispatch();
				await operations.acquire(authority, deadline.remaining(), beforeDispatch);
				beforeDispatch();
				return { result: withManagedProof(emptyControlResult(), authority) };
			} finally {
				deadline.close();
			}
		},
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
		async startManagedSession(input, publish, beforePrompt, onFailure) {
			throwIfAborted(input.signal);
			const deadline = new ManagedOperationDeadline(turnTimeoutMs, "session.create/prompt");
			try {
				const lifecycleResult = await operations.create({
					authority: input.preparedManagedAuthority,
					target: { path: input.cwd },
					timeoutMs: deadline.remaining(),
					signal: input.signal,
					onAcknowledged: input.onLifecycleAcknowledged,
					onInvoking: input.onLifecycleInvoking,
					lifecycleOperation: input.lifecycleOperation,
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
				const transaction = managedLifecycleTransaction(address, authority, deadline);
				let publicationStarted = false;
				try {
					deadline.remaining();
					await deadline.wait(beforePrompt(address, managedProof(authority), transaction));
					throwIfAborted(input.signal);
					const modelSelection = await deadline.wait(
						applyManagedModelSelection(operations, authority, input.modelSelection, deadline, input.signal),
					);
					const result = withManagedProof(
						withManagedModelSelection(
							await operations.prompt({
								...turnInput(
									{ ...input, preparedManagedAuthority: input.preparedManagedAuthority, authority },
									"turn.prompt",
								),
								timeoutMs: deadline.remaining(),
								beforeDispatch: () => {
									deadline.remaining();
								},
							}),
							modelSelection,
						),
						authority,
					);
					deadline.remaining();
					publicationStarted = true;
					return await deadline.wait(publish({ ...address, ...result }, transaction));
				} catch (error) {
					if (onFailure !== undefined) {
						try {
							deadline.remaining();
							await deadline.wait(onFailure(transaction, error));
						} catch (failureError) {
							throw new AggregateError(
								[error, failureError],
								"Managed startup failure persistence is uncertain.",
							);
						}
					}
					if (!publicationStarted)
						await closeAfterPrePromptFailure(operations, authority, { path: input.cwd }, error, deadline);
					throw error;
				}
			} finally {
				deadline.close();
			}
		},
	};
}

function managedLifecycleTransaction(
	address: GjcLifecyclePublicationAddress,
	authority?: ManagedTurnAuthority,
	deadline?: ManagedOperationDeadline,
): GjcLifecycleTransaction {
	const transaction: GjcLifecycleTransaction = {
		address,
		async publishManaged(proof, write) {
			deadline?.remaining();
			const bound = managedLifecycleAuthorities.get(transaction);
			if (bound === undefined) throw new Error("Managed lifecycle publication requires complete bound authority.");
			assertManagedLifecyclePublication(address, bound, proof);
			return write();
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
	resumed: Pick<Awaited<ReturnType<ManagedSessionOperations["resume"]>>, "tenant">,
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

function requireLifecycleControlOwner(
	input: LiveGatewayRunnerInput,
	authority: ManagedTurnAuthority,
	owner: ManagedLifecycleControlOwner | undefined,
): ManagedLifecycleControlOwner {
	const operation = input.control?.operation === "session.new" ? "session.create" : "session.resume";
	const payloadHash = controlOperationHash(input);
	const requestKey = lifecycleControlRequestKey(authority, operation, input.userMessageId, payloadHash);
	if (
		owner === undefined ||
		owner.operation !== operation ||
		typeof owner.onInvoking !== "function" ||
		typeof owner.onAcknowledged !== "function" ||
		owner.lifecycleOperation.operationId !== input.userMessageId ||
		owner.lifecycleOperation.requestKey !== requestKey ||
		owner.lifecycleOperation.payloadHash !== payloadHash ||
		!sameManagedAuthority(owner.source, { ...authority, requestKey })
	)
		throw new Error("Managed lifecycle control requires exact durable operation ownership.");
	for (const field of [
		"principalId",
		"projectId",
		"canonicalWorkspace",
		"chatId",
		"leaseId",
		"epoch",
		"requestKey",
	] as const)
		if (owner.preparedAuthority[field] !== owner.source[field])
			throw new Error("Managed lifecycle prepared authority changed.");
	return Object.freeze({
		...owner,
		source: Object.freeze({ ...owner.source }),
		preparedAuthority: Object.freeze({ ...owner.preparedAuthority }),
		lifecycleOperation: Object.freeze({ ...owner.lifecycleOperation }),
	});
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
	deadline?: ManagedOperationDeadline,
	signal?: AbortSignal,
	beforeDispatch?: () => void,
): Promise<NormalizedModelSelection | undefined> {
	throwIfAborted(signal);
	deadline?.remaining();
	const assertDispatch = () => {
		deadline?.remaining();
		throwIfAborted(signal);
		beforeDispatch?.();
	};
	if (selection === undefined) return undefined;
	const requested = normalizeModelSelection(selection);
	if (requested === undefined)
		throw new ManagedSdkOperationError("invalid_result", "Managed model selection is not normalized.");

	let modelResult: Readonly<Record<string, unknown>>;
	try {
		modelResult = await operations.setModel(authority, requested, deadline?.remaining(), assertDispatch);
	} catch (error) {
		throw managedSelectionMutationError("model_set_failed", "model.set", error);
	}
	const modelSelection = normalizeModelSelection(modelResult);
	if (!sameModelSelection(modelSelection, requested))
		throw new ManagedSdkOperationError("invalid_result", "model.set did not confirm the requested selection.");

	let thinkingResult: Readonly<Record<string, unknown>>;
	try {
		throwIfAborted(signal);
		thinkingResult = await operations.setThinking(
			authority,
			requested.thinkingLevel,
			deadline?.remaining(),
			assertDispatch,
		);
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

async function continueManagedTurn(
	operations: ManagedSessionOperations,
	input: ManagedRunnerContinueInput,
	timeoutMs: number | undefined,
): Promise<GjcTurnResult> {
	throwIfAborted(input.signal);
	const deadline = new ManagedOperationDeadline(input.timeoutMs ?? timeoutMs, "turn.follow_up");
	const assertDispatch = () => {
		deadline.remaining();
		input.beforeDispatch?.();
	};
	const onAbort = () => deadline.fail(new GjcTurnCancelledError());
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const selection = await deadline.wait(
			applyManagedModelSelection(
				operations,
				input.authority,
				input.modelSelection,
				deadline,
				input.signal,
				assertDispatch,
			),
		);
		const result = await operations.followUp({
			...turnInput(input, "turn.follow_up"),
			timeoutMs: deadline.remaining(),
			beforeDispatch: assertDispatch,
		});
		deadline.remaining();
		return withManagedProof(withManagedModelSelection(result, selection), input.authority);
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
		deadline.close();
	}
}

function managedSelectionMutationError(
	code: "model_set_failed" | "thinking_set_failed",
	operation: string,
	error: unknown,
): ManagedSdkOperationError | GjcTurnCancelledError {
	if (error instanceof GjcTurnCancelledError) return error;
	if (
		error instanceof ManagedSdkOperationError &&
		["model_set_failed", "thinking_set_failed", "invalid_result", "timeout", "operation_closed"].includes(error.code)
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
	deadline: ManagedOperationDeadline,
): Promise<void> {
	try {
		const timeoutMs = deadline.remaining();
		await deadline.wait(
			operations.close({
				authority,
				target: { ...target, sessionId: authority.sessionId, endpointGeneration: authority.generation },
				timeoutMs,
			}),
		);
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
