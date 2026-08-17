import type { GjcRuntimeLocations } from "../contracts";
import type { PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import type { routeGjcTurn, SessionMapping } from "../gjc/session-router";
import type {
	GjcCancelTurnInput,
	GjcContinueSessionInput,
	GjcControlResult,
	GjcLifecycleTransaction,
	GjcSessionAddress,
	GjcSessionState,
	GjcSessionStateInput,
	GjcStartNewSessionInput,
	GjcSwitchSessionInput,
	GjcTurnResult,
	GjcTurnRunner,
} from "../gjc/turn-runner";
import type { LiveGatewayRunnerInput } from "./chat-completions";
import { withLifecycle } from "./gjc-public-sdk-close";
import { runControl } from "./gjc-public-sdk-control-ops";
import {
	continueSession,
	getAvailableModels,
	getState,
	type OwnedAbortRegistration,
	respondWorkflowGate,
	startNewSession,
	switchSession,
} from "./gjc-public-sdk-session-ops";
import { attachmentKey } from "./gjc-routing-endpoints";
import {
	createPublicSdkRunnerContext,
	type LifecycleAddress,
	type PublicSdkRunnerContext,
	type PublicSdkRunnerOptions,
} from "./gjc-routing-lifecycle";

export type GjcSessionTurnRunner = Parameters<typeof routeGjcTurn>[0]["runner"];

export interface CreatePublicSdkGjcTurnRunnerInput extends PublicSdkRunnerOptions {
	readonly cliPath: string;
	readonly runtimeLocations: GjcRuntimeLocations;
	readonly turnTimeoutMs: number;
	readonly sessionPortFactory?: () => PublicSdkSessionPort;
}

export function createPublicSdkGjcTurnRunner(input: CreatePublicSdkGjcTurnRunnerInput): GjcSessionTurnRunner {
	return new PublicSdkGjcTurnRunner(input);
}

class PublicSdkGjcTurnRunner implements GjcTurnRunner {
	readonly #context: PublicSdkRunnerContext;
	readonly #ownedAborters = new Map<
		string,
		{ readonly sessionId: string; readonly operationId: string; readonly abort: () => Promise<unknown> }
	>();
	readonly #cancelledOperations = new Set<string>();

	constructor(input: CreatePublicSdkGjcTurnRunnerInput) {
		this.#context = createPublicSdkRunnerContext(input);
	}

	async cancelTurn(input: GjcCancelTurnInput): Promise<void> {
		const key = this.abortKey(input.principalId, input.projectId, input.chatId);
		if (input.operationId === undefined) return;
		const operationKey = this.operationKey(key, input.operationId);
		const active = this.#ownedAborters.get(operationKey);
		if (active !== undefined && input.sessionId !== undefined && input.sessionId !== active.sessionId) return;
		if (active === undefined) {
			this.#cancelledOperations.add(operationKey);
			return;
		}
		try {
			await active.abort();
		} catch {
			// HTTP disconnect cancellation is best-effort; the request signal still
			// prevents the late turn result from being durably published.
		}
	}

	clearTurnCancellation(input: GjcCancelTurnInput): void {
		if (input.operationId === undefined) return;
		this.#cancelledOperations.delete(
			this.operationKey(this.abortKey(input.principalId, input.projectId, input.chatId), input.operationId),
		);
	}

	discardSessionAttachment(cwd: string, sessionId: string): void {
		this.#context.attachments.delete(attachmentKey({ cwd, sessionId }));
	}

	withLifecyclePublication<T>(
		address: LifecycleAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T> {
		return withLifecycle(this.#context, address, effect, true);
	}

	withLifecycleClosePreflight<T>(
		address: LifecycleAddress,
		effect: (lifecycle: GjcLifecycleTransaction) => Promise<T>,
	): Promise<T> {
		return withLifecycle(this.#context, address, effect, false);
	}

	startNewSession<T>(
		input: GjcStartNewSessionInput,
		publish: (result: GjcSessionAddress & GjcTurnResult, lifecycle: GjcLifecycleTransaction) => Promise<T>,
		beforePrompt: Parameters<GjcTurnRunner["startNewSession"]>[2],
		onFailure?: Parameters<GjcTurnRunner["startNewSession"]>[3],
	): Promise<T> {
		return startNewSession(this.#context, input, publish, beforePrompt, onFailure, this.registerOwnedAbort);
	}

	switchSession(input: GjcSwitchSessionInput): Promise<void> {
		return switchSession(this.#context, input);
	}

	getState(input: GjcSessionStateInput): Promise<GjcSessionState> {
		return getState(this.#context, input);
	}

	getAvailableModels(input: GjcSessionStateInput): Promise<readonly unknown[]> {
		return getAvailableModels(this.#context, input);
	}

	respondWorkflowGate(input: import("../gjc/turn-runner").GjcRespondWorkflowGateInput): Promise<GjcTurnResult> {
		return respondWorkflowGate(this.#context, input, this.registerOwnedAbort);
	}
	continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		return continueSession(this.#context, input, this.registerOwnedAbort);
	}

	runControl(
		input: LiveGatewayRunnerInput,
		mapping: SessionMapping,
		lifecycle: GjcLifecycleTransaction,
		onAcknowledgedSuccessor?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[3],
		onDispatch?: Parameters<NonNullable<GjcTurnRunner["runControl"]>>[4],
	): Promise<GjcControlResult> {
		return runControl(
			this.#context,
			input,
			mapping,
			lifecycle,
			onAcknowledgedSuccessor,
			this.registerOwnedAbort,
			onDispatch,
		);
	}

	readonly registerOwnedAbort: OwnedAbortRegistration = (address, principalId, operationId, abort) => {
		const operationKey = this.operationKey(
			this.abortKey(principalId, address.projectId, address.chatId),
			operationId,
		);
		const cancelled = this.#cancelledOperations.delete(operationKey);
		const active = { sessionId: address.sessionId, operationId, abort };
		this.#ownedAborters.set(operationKey, active);
		return {
			cancelled,
			unregister: () => {
				if (this.#ownedAborters.get(operationKey) === active) this.#ownedAborters.delete(operationKey);
			},
		};
	};

	private abortKey(principalId: string | undefined, projectId: string, chatId: string): string {
		return JSON.stringify([principalId ?? null, projectId, chatId]);
	}

	private operationKey(abortKey: string, operationId: string): string {
		return `${abortKey}:${operationId}`;
	}
}
