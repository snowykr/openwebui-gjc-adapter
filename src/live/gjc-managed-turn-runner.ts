import { resolve } from "node:path";
import type { ManagedSdkRuntime } from "../gjc/managed-sdk-runtime";
import type { SessionAttachmentProof } from "../gjc/session-authority";
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
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
	ManagedPreparedTurnAuthority,
	ManagedTurnAuthority,
} from "../gjc/turn-runner";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import {
	createManagedSessionOperations,
	type ManagedGateInput,
	type ManagedLifecycleInput,
	type ManagedSessionOperations,
	type ManagedTurnInput,
} from "./gjc-managed-session-operations";

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
	switchSession(input: GjcSwitchSessionInput): Promise<void>;
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

export function createManagedGjcTurnRunner(runtime: ManagedSdkRuntime): ManagedGjcTurnRunner {
	const operations = createManagedSessionOperations(runtime);
	return {
		operations,
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
				return withManagedProof(
					await operations.prompt(turnInput({ ...input, authority }, "turn.prompt")),
					authority,
				);
			} catch (error) {
				await closeAfterPrePromptFailure(operations, authority, { path: input.cwd }, error);
				throw error;
			}
		},
		resume: input => operations.resume(input),
		continue: async input =>
			withManagedProof(await operations.followUp(turnInput(input, "turn.follow_up")), input.authority),
		continueSession: async input => {
			const authority = managedAuthorityFor(input, "turn.follow_up");
			return withManagedProof(
				await operations.followUp(turnInput({ ...input, authority }, "turn.follow_up")),
				authority,
			);
		},
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
		gate: async input => withManagedProof(await operations.answerGate(gateInput(input)), input.authority),
		respondWorkflowGate: async input => {
			const authority = managedAuthorityFor(input, "workflow.gate_answer");
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
		closePreflight: input => operations.close({ authority: input.authority, target: input.target }),
		async getState(input) {
			const authority = managedAuthorityFor(input, "session.state");
			await operations.getState(authority);
			return {
				...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
				rawFrameCursor: 0,
				eventCursor: 0,
				managedProof: managedProof(authority),
				managedAuthority: authority,
			};
		},
		getAvailableModels: input => operations.getModels(managedAuthorityFor(input, "models.list/current")),
		async switchSession(input) {
			const authority = managedAuthorityFor(input, "session.resume");
			const resumed = await operations.resume({
				authority,
				target: { sessionIdOrPrefix: authority.sessionId, path: input.cwd },
			});
			assertResumedExactAuthority(resumed, authority);
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
			};
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
				const result = withManagedProof(
					await operations.prompt(
						turnInput(
							{ ...input, preparedManagedAuthority: input.preparedManagedAuthority, authority },
							"turn.prompt",
						),
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
	return {
		address,
		owner,
		assertClosePreflight(): never {
			throw new Error("Managed lifecycle close uses exact generation retirement proof.");
		},
		async publish(): Promise<never> {
			throw new Error("Managed lifecycle cannot publish legacy attachment authority.");
		},
		async publishManaged(proof, write) {
			if (
				proof.sessionId !== address.sessionId ||
				(authority !== undefined &&
					(proof.sessionId !== authority.sessionId || proof.generation !== authority.generation))
			)
				throw new Error("Managed lifecycle publication proof changed.");
			return write();
		},
		async publishClosed(): Promise<never> {
			throw new Error("Managed lifecycle close publication requires managed retirement state.");
		},
		async handoff(): Promise<never> {
			throw new Error("Managed successor handoff uses public lifecycle fork authority.");
		},
	};
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
