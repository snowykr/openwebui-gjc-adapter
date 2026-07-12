import { type DeploymentArtifacts, stageDeploymentArtifacts } from "./deployment-artifacts";
import type { DeploymentRuntime } from "./deployment-runtime";
import type { CliDependencies, DeploymentLifecycle, ResetRequest } from "./installed-cli-contracts";
import { managedAdapterImagePlan } from "./managed-compose";
import type {
	configureOpenWebUI,
	OpenWebUIHttpClient,
	OpenWebUISetupInput,
	OpenWebUISetupResult,
} from "./openwebui-setup";
import { runPhaseAwareDeployment } from "./orchestrator";
import type { PendingRecoveryStore } from "./pending-recovery-store";
import type { InstalledConfig } from "./private-config";

export interface DeploymentPhaseInput {
	readonly config: InstalledConfig;
	readonly runtime: DeploymentRuntime;
	readonly artifacts: DeploymentArtifacts;
	readonly state: OpenWebUISetupInput["state"];
	readonly managedDocker: CliDependencies["managedDocker"];
	readonly writeConfig: (config: InstalledConfig) => void;
	readonly setup: (input: { readonly stopAfter?: "api-key" | "provider" }) => Promise<OpenWebUISetupResult>;
	readonly adminEmail?: string;
	readonly adminPassword?: string;
	readonly uiPort: number;
	readonly recovery?: Parameters<DeploymentLifecycle["managed"]>[0]["recovery"];
	readonly validation?: { readonly apiKey: string; readonly ownerUserId: string };
	readonly packageRoot: string;
}

type DeploymentSetupInput = {
	readonly setupOpenWebUI: typeof configureOpenWebUI;
	readonly state: OpenWebUISetupInput["state"];
	readonly http: (config: InstalledConfig) => OpenWebUIHttpClient;
};

export function createDeploymentPhaseSetup(input: DeploymentSetupInput) {
	const setup =
		(config: InstalledConfig, email: string, password: string) =>
		async (phase: { readonly stopAfter?: "api-key" | "provider" }) =>
			input.setupOpenWebUI({
				http: input.http(config),
				state: input.state,
				writeCheckpoints: config.mode === "managed",
				...(phase.stopAfter === undefined ? {} : { stopAfter: phase.stopAfter }),
				maintenance: { begin: async () => {}, end: async () => {} },
				adapterUrl: config.adapterProviderUrl,
				adapterToken: config.adapterToken,
				adminEmail: email,
				adminPassword: password,
				installationId: config.installationId,
				openWebUIApiToken: config.openWebUIApiToken,
				mode: config.mode,
			});
	const validateExisting = async (config: InstalledConfig) => {
		const configured = await input.setupOpenWebUI({
			http: input.http(config),
			state: input.state,
			writeCheckpoints: false,
			maintenance: { begin: async () => {}, end: async () => {} },
			adapterUrl: config.adapterProviderUrl,
			adapterToken: config.adapterToken,
			adminEmail: "",
			adminPassword: "",
			installationId: config.installationId,
			openWebUIApiToken: config.openWebUIApiToken,
			mode: "existing",
		});
		if (config.ownerUserId !== undefined && config.ownerUserId !== configured.ownerUserId)
			throw new Error("OpenWebUI API token belongs to a different owner");
		return { apiKey: configured.apiKey, ownerUserId: configured.ownerUserId };
	};
	return { setup, validateExisting };
}

export async function runManagedDeploymentPhase(input: DeploymentPhaseInput): Promise<void> {
	stageDeploymentArtifacts(input);
	stageDeploymentArtifacts(input);
	await runPhaseAwareDeployment({
		state: input.state,
		recovery: input.recovery,
		phases: {
			preflight: async () => {
				const image = process.env.GJC_ADAPTER_IMAGE ?? "openwebui-gjc-adapter:local";
				const plan = managedAdapterImagePlan(image, `${input.packageRoot}/Dockerfile.adapter`, input.packageRoot);
				const result = await input.runtime.docker.run(plan.build[0], plan.build[1], { output: "inherit" });
				if (result.exitCode !== 0)
					throw new Error(`docker build failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
			},
			bootstrap: async () => {
				input.runtime.run(["systemctl", "--user", "daemon-reload"]);
				input.runtime.run(["systemctl", "--user", "enable", "--now", "openwebui-gjc-adapter.service"]);
			},
			apiKey: async () => {
				await input.runtime.waitForManagedOpenWebUITarget();
				const setup = await input.setup({ stopAfter: "api-key" });
				await input.state.write(setup.state);
				if (input.config.ownerUserId !== undefined && input.config.ownerUserId !== setup.ownerUserId)
					throw new Error("OpenWebUI API token belongs to a different owner");
				input.config.openWebUIApiToken = setup.apiKey;
				input.config.ownerUserId = setup.ownerUserId;
				input.writeConfig(input.config);
				input.runtime.run(["systemctl", "--user", "restart", "openwebui-gjc-adapter.service"]);
				return {
					bootstrapComplete: setup.state.bootstrapComplete,
					apiKeyCreated: setup.state.apiKeyCreated,
					ownerUserId: setup.ownerUserId,
					openWebUIApiToken: setup.apiKey,
				};
			},
			readiness: async () => {
				await input.runtime.waitForAdapterReady(
					() => input.runtime.probeManagedAdapter(input.artifacts.composeFile),
					10,
					input.runtime.managedReadinessDelayMs,
				);
			},
			provider: async () => {
				await input.runtime.waitForManagedOpenWebUITarget();
				const setup = await input.setup({ stopAfter: "provider" });
				if (input.config.ownerUserId !== undefined && input.config.ownerUserId !== setup.ownerUserId)
					throw new Error("OpenWebUI API token belongs to a different owner");
				return {
					openAIConfigured: setup.state.openAIConfigured,
					openAIConnectionIds: setup.state.openAIConnectionIds,
					ownerUserId: setup.ownerUserId,
					openWebUIApiToken: setup.apiKey,
				};
			},
		},
	});
}

export async function runExistingDeploymentPhase(input: DeploymentPhaseInput): Promise<void> {
	const setup = input.validation ?? (await input.setup({}));
	input.config.ownerUserId = setup.ownerUserId;
	input.config.openWebUIApiToken = setup.apiKey;
	input.writeConfig(input.config);
	stageDeploymentArtifacts(input);
	input.runtime.run(["systemctl", "--user", "daemon-reload"]);
	input.runtime.run(["systemctl", "--user", "enable", "openwebui-gjc-adapter-existing.service"]);
	input.runtime.run(["systemctl", "--user", "restart", "openwebui-gjc-adapter-existing.service"]);
	await input.runtime.waitForAdapterReady(() => input.runtime.probeAdapter(input.config));
}

export async function runResetDeploymentPhase(input: {
	readonly request: ResetRequest;
	readonly pendingStore: PendingRecoveryStore;
	readonly state: OpenWebUISetupInput["state"];
	readonly resetState: (
		state: NonNullable<Awaited<ReturnType<OpenWebUISetupInput["state"]["read"]>>>,
		phase: NonNullable<ResetRequest["proof"]["failedPhase"]>,
		proof: { readonly failedPhase: NonNullable<ResetRequest["proof"]["failedPhase"]>; readonly evidence: string },
	) => NonNullable<Awaited<ReturnType<OpenWebUISetupInput["state"]["read"]>>>;
	readonly quiesce: () => void;
	readonly controllerState: { readonly enabled: boolean; readonly active: boolean };
	readonly alreadyQuiesced: boolean;
}): Promise<void> {
	if (!input.request.proof.evidence.trim()) throw new Error("reset requires proof for the persisted failed phase");
	if (input.request.priorMode === "managed") {
		const current = await input.state.read();
		if (current === undefined) throw new Error("reset requires a persisted failed bootstrap phase");
		const failed =
			input.request.proof.failedPhase ??
			current.failedPhase ??
			(current.phase === "complete" &&
			current.apiKeyCreated &&
			current.ownerUserId !== undefined &&
			current.openWebUIApiToken !== undefined
				? "route"
				: current.phase);
		if (failed === "complete" || (current.phase !== "complete" && failed !== current.phase))
			throw new Error("reset requires proof for the persisted failed phase");
		await input.state.write(
			input.resetState(current, failed, { failedPhase: failed, evidence: input.request.proof.evidence }),
		);
	}
	if (!input.alreadyQuiesced) input.quiesce();
	input.pendingStore.update({
		controllerRecoveryRequired: true,
		controllerQuiesced: true,
		priorControllerEnabled: input.controllerState.enabled,
		priorControllerActive: input.controllerState.active,
	});
}
