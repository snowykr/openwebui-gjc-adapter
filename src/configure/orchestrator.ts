import {
	advanceBootstrapState,
	type BootstrapPhase,
	type BootstrapResetProof,
	type BootstrapState,
	type BootstrapStateStore,
	INITIAL_BOOTSTRAP_STATE,
	resetBootstrapState,
} from "./bootstrap-state";

export type PhaseFacts = Partial<Omit<BootstrapState, "version" | "phase">>;
export interface PhaseAdapters {
	preflight(): Promise<PhaseFacts | undefined>;
	bootstrap(): Promise<PhaseFacts | undefined>;
	apiKey(): Promise<PhaseFacts | undefined>;
	/** Provider mutation and its readback/ownership check. */
	provider(): Promise<PhaseFacts | undefined>;
	readiness(): Promise<PhaseFacts | undefined>;
}
export interface PhaseAwareDeploymentInput {
	readonly state: BootstrapStateStore;
	readonly phases: PhaseAdapters;
	readonly reset?: BootstrapResetProof & { readonly controllerQuiesced?: boolean; readonly recovery?: boolean };
	readonly recovery?: { readonly controllerRecoveryRequired: boolean; readonly controllerQuiesced?: boolean };
}
export interface PhaseAwareDeploymentResult {
	readonly state: BootstrapState;
	readonly completed: true;
}

/** Runs each executable phase with a durable checkpoint; a failed phase is never skipped. */
export async function runPhaseAwareDeployment(input: PhaseAwareDeploymentInput): Promise<PhaseAwareDeploymentResult> {
	let state = (await input.state.read()) ?? INITIAL_BOOTSTRAP_STATE;
	if (input.reset) {
		state = resetBootstrapState(state, input.reset.failedPhase, input.reset);
		await input.state.write(state);
	}
	const startingPhase = state.phase;
	const rerunCompleted = startingPhase === "complete";
	const phases: readonly [BootstrapPhase, keyof PhaseAdapters][] = rerunCompleted
		? [
				["preflight", "preflight"],
				["bootstrap", "bootstrap"],
				["api-key", "apiKey"],
				["route", "readiness"],
				["ownership", "provider"],
			]
		: [
				["preflight", "preflight"],
				["bootstrap", "bootstrap"],
				["api-key", "apiKey"],
				["openai", "provider"],
				["route", "readiness"],
				["ownership", "provider"],
			];
	const restartController =
		!rerunCompleted &&
		(input.recovery?.controllerRecoveryRequired === true ||
			input.recovery?.controllerQuiesced === true ||
			(input.reset !== undefined &&
				(input.reset.controllerQuiesced === true ||
					input.reset.recovery === true ||
					phaseOrder(startingPhase) > phaseOrder("bootstrap"))));
	for (const [phase, adapter] of phases) {
		const completedBeforePhase =
			!rerunCompleted && startingPhase !== "preflight" && phaseOrder(startingPhase) > phaseOrder(phase);
		if (completedBeforePhase) {
			if (phase !== "bootstrap" || !restartController) continue;
			try {
				await input.phases.bootstrap();
			} catch (error) {
				const evidence = error instanceof Error ? error.message : String(error);
				state = (await input.state.read()) ?? state;
				state = { ...state, failedPhase: startingPhase, failureEvidence: evidence };
				await input.state.write(state);
				throw error;
			}
			continue;
		}
		state = rerunCompleted ? checkpointCompletedInstallRerun(state, phase) : advanceBootstrapState(state, phase);
		await input.state.write(state);
		try {
			const facts = await input.phases[adapter]();
			state = (await input.state.read()) ?? state;
			state = advanceBootstrapState(state, phase, { ...phasePatch(phase), ...(facts ?? {}) });
			await input.state.write(state);
		} catch (error) {
			const evidence = error instanceof Error ? error.message : String(error);
			// A phase may persist nested recovery state before reporting failure. Read it
			// back before adding orchestration failure metadata so it is not lost.
			state = (await input.state.read()) ?? state;
			state = { ...state, phase, failedPhase: phase, failureEvidence: evidence };
			await input.state.write(state);
			throw error;
		}
	}
	state = advanceBootstrapState(state, "complete", { routeVerified: true, ownershipVerified: true });
	await input.state.write(state);
	return { state, completed: true };
}
function phaseOrder(phase: BootstrapPhase): number {
	return ["preflight", "bootstrap", "api-key", "openai", "route", "ownership", "complete"].indexOf(phase);
}
function checkpointCompletedInstallRerun(state: BootstrapState, phase: BootstrapPhase): BootstrapState {
	const checkpoint = phaseOrder(phase);
	return advanceBootstrapState(state, phase, {
		bootstrapComplete: checkpoint > phaseOrder("bootstrap"),
		apiKeyCreated: checkpoint > phaseOrder("api-key"),
		openAIConfigured: checkpoint > phaseOrder("openai"),
		routeVerified: checkpoint > phaseOrder("route"),
		ownershipVerified: checkpoint > phaseOrder("ownership"),
	});
}
function phasePatch(phase: BootstrapPhase): Partial<BootstrapState> {
	return phase === "bootstrap"
		? { bootstrapComplete: true }
		: phase === "api-key"
			? { apiKeyCreated: true }
			: phase === "openai"
				? { openAIConfigured: true }
				: phase === "route"
					? { routeVerified: true }
					: phase === "ownership"
						? { ownershipVerified: true }
						: {};
}
