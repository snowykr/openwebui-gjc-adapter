import type { GjcRuntimeLocations } from "../contracts";
import type { PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import type { routeGjcTurn, SessionMapping } from "../gjc/session-router";
import type {
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

	constructor(input: CreatePublicSdkGjcTurnRunnerInput) {
		this.#context = createPublicSdkRunnerContext(input);
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
		return startNewSession(
			this.#context,
			input,
			publish,
			beforePrompt as (
				address: GjcSessionAddress,
				attachment: import("../gjc/session-authority").SessionAttachmentProof,
				lifecycle: GjcLifecycleTransaction,
			) => Promise<void>,
			onFailure,
		);
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
		return respondWorkflowGate(this.#context, input);
	}
	continueSession(input: GjcContinueSessionInput): Promise<GjcTurnResult> {
		return continueSession(this.#context, input);
	}

	runControl(
		input: LiveGatewayRunnerInput,
		mapping: SessionMapping,
		lifecycle: GjcLifecycleTransaction,
	): Promise<GjcControlResult> {
		return runControl(this.#context, input, mapping, lifecycle);
	}
}
