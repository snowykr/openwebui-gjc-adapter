import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureControllerState, createControllerLifecycle, quiesceController } from "./controller-lifecycle";
import { commitDeploymentArtifacts, type DeploymentArtifacts } from "./deployment-artifacts";
import {
	createDeploymentPhaseSetup,
	runExistingDeploymentPhase,
	runManagedDeploymentPhase,
	runResetDeploymentPhase,
} from "./deployment-phases";
import { createDeploymentRuntime, createOpenWebUIHttpClient } from "./deployment-runtime";
import {
	beginDeploymentTransaction,
	commitDeploymentTransaction,
	createDeploymentRecovery,
	type DeploymentRecovery,
	type DeploymentTransaction,
	rollbackDeploymentTransaction,
} from "./deployment-transaction";
import type { CliDependencies, DeploymentLifecycle, ResetRequest } from "./installed-cli-contracts";
import { checkManagedComposePrerequisites } from "./managed-compose";
import { configureOpenWebUI } from "./openwebui-setup";
import { PendingRecoveryStore } from "./pending-recovery-store";
import { readInstalledConfig, validateInstalledConfig, writeInstalledConfig } from "./private-config";

type StateParser = ConstructorParameters<typeof PendingRecoveryStore>[1];
type BootstrapState = ReturnType<StateParser>;
type BootstrapPhase = Exclude<ResetRequest["proof"]["failedPhase"], undefined>;
type SetupOpenWebUI = typeof configureOpenWebUI;

export interface ProductionDeploymentInput {
	readonly path: string;
	readonly parseState: StateParser;
	readonly resetState: (
		state: BootstrapState,
		failedPhase: BootstrapPhase,
		proof: { readonly failedPhase: BootstrapPhase; readonly evidence: string },
	) => BootstrapState;
	readonly setupOpenWebUI?: SetupOpenWebUI;
	readonly managedDocker?: CliDependencies["managedDocker"];
	readonly systemctl?: CliDependencies["systemctl"];
	readonly managedProbe?: CliDependencies["probeManagedAdapter"];
	readonly managedReadinessDelayMs?: number;
}

export function createProductionDeployment(input: ProductionDeploymentInput) {
	const userUnitDirectory = join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"systemd",
		"user",
	);
	const artifacts: DeploymentArtifacts = {
		path: input.path,
		directory: dirname(input.path),
		composeFile: `${input.path}.compose.yml`,
		unitFile: `${input.path}.service`,
		userUnitDirectory,
		sourceRoot: dirname(dirname(fileURLToPath(import.meta.url))),
	};
	const runtime = createDeploymentRuntime({
		composeFile: artifacts.composeFile,
		managedDocker: input.managedDocker,
		systemctl: input.systemctl,
		probeManagedAdapter: input.managedProbe,
		managedReadinessDelayMs: input.managedReadinessDelayMs,
	});
	const pendingStore = new PendingRecoveryStore(input.path, input.parseState);
	const state = {
		read: async () => pendingStore.readState(),
		write: async (value: BootstrapState) => pendingStore.writeState(value),
	};
	const recovery = createDeploymentRecovery({
		path: input.path,
		userUnitDirectory,
		parseState: input.parseState,
		pendingFromState: value => value.pendingRecovery,
		validateConfig: validateInstalledConfig,
		readConfig: readInstalledConfig,
		removePending: () => pendingStore.remove(),
	});
	const deploymentSetup = createDeploymentPhaseSetup({
		setupOpenWebUI: input.setupOpenWebUI ?? configureOpenWebUI,
		state,
		http: config => createOpenWebUIHttpClient(config, input.managedReadinessDelayMs),
	});
	let transaction: DeploymentTransaction | undefined;
	const transactionFromDisk = () => recovery.restoreTransaction(pendingStore.read());
	const controller = createControllerLifecycle({ runtime, artifacts });
	const rollback = async (
		tx: DeploymentTransaction | undefined,
		attemptedMode: "managed" | "existing",
	): Promise<Error[]> => {
		const checkpoint = await state.read();
		const pendingBeforeRollback = tx?.previous ? pendingStore.read() : undefined;
		return rollbackDeploymentTransaction({
			transaction: tx,
			attemptedMode,
			path: input.path,
			artifacts,
			controller,
			checkpoint,
			writeCheckpoint: async value => state.write(input.parseState(value)),
			pendingBeforeRollback,
			finishDurableRollback: recovery.finishRollback,
		});
	};
	const begin = (priorMode: "managed" | "existing") => {
		const pending = pendingStore.read();
		const controllers =
			pending === undefined || !pending.controllerRecoveryRequired
				? captureControllerState({ mode: priorMode, runtime, artifacts })
				: { enabled: pending.priorControllerEnabled, active: pending.priorControllerActive };
		const tx =
			transaction ??
			beginDeploymentTransaction({
				path: input.path,
				artifacts,
				priorMode,
				controllers,
				restored: transactionFromDisk(),
			});
		pendingStore.update({
			controllerRecoveryRequired: true,
			controllerQuiesced: pending?.controllerQuiesced ?? false,
			priorControllerEnabled: tx.controllers.enabled,
			priorControllerActive: tx.controllers.active,
		});
		return tx;
	};
	const commit = (tx: DeploymentTransaction, targetMode: "managed" | "existing") =>
		commitDeploymentTransaction({
			transaction: tx,
			targetMode,
			commitArtifacts: (priorMode, nextMode) =>
				commitDeploymentArtifacts({ artifacts, runtime, priorMode, targetMode: nextMode }),
		});
	const fail = async (
		error: unknown,
		tx: DeploymentTransaction | undefined,
		mode: "managed" | "existing",
	): Promise<never> => {
		const errors = await rollback(tx, mode);
		transaction = undefined;
		if (errors.length)
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; rollback failed: ${errors.map(item => item.message).join("; ")}`,
			);
		throw error;
	};
	return {
		pendingStore,
		recovery,
		validateExisting: async value => deploymentSetup.validateExisting(value.config),
		checkManagedPrerequisites: async () => {
			const checks = await checkManagedComposePrerequisites({ docker: runtime.docker });
			if (!checks.passed) throw new Error(checks.failures.join("; "));
		},
		managed: async value => {
			const tx = begin(pendingStore.read()?.priorMode ?? "managed");
			try {
				await runManagedDeploymentPhase({
					config: value.config,
					runtime,
					artifacts,
					state,
					managedDocker: input.managedDocker,
					writeConfig: config => writeInstalledConfig(config, input.path),
					setup: deploymentSetup.setup(value.config, value.adminEmail, value.adminPassword),
					adminEmail: value.adminEmail,
					adminPassword: value.adminPassword,
					uiPort: value.uiPort,
					recovery: value.recovery,
					packageRoot: dirname(artifacts.sourceRoot),
				});
				commit(tx, "managed");
				transaction = undefined;
				return { completed: true, mode: "managed" };
			} catch (error) {
				return fail(error, tx, "managed");
			}
		},
		existing: async value => {
			const tx = begin(pendingStore.read()?.priorMode ?? "existing");
			try {
				await runExistingDeploymentPhase({
					config: value.config,
					runtime,
					artifacts,
					state,
					managedDocker: input.managedDocker,
					writeConfig: config => writeInstalledConfig(config, input.path),
					setup: deploymentSetup.setup(value.config, "", ""),
					uiPort: 8080,
					validation: value.validation,
					packageRoot: dirname(artifacts.sourceRoot),
				});
				commit(tx, "existing");
				transaction = undefined;
				return { completed: true, mode: "existing" };
			} catch (error) {
				return fail(error, tx, "existing");
			}
		},
		reset: async value => {
			if (!value.proof.evidence.trim()) throw new Error("reset requires proof for the persisted failed phase");
			const pending = pendingStore.read();
			const resumed = pending?.controllerRecoveryRequired === true;
			const tx = resumed
				? transactionFromDisk()
				: beginDeploymentTransaction({
						path: input.path,
						artifacts,
						priorMode: value.priorMode,
						controllers: captureControllerState({ mode: value.priorMode, runtime, artifacts }),
						previous: existsSync(input.path) ? readInstalledConfig(input.path) : undefined,
					});
			if (tx === undefined) throw new Error("reset recovery requires a durable deployment snapshot");
			transaction = tx;
			if (!resumed)
				pendingStore.update({
					controllerRecoveryRequired: true,
					controllerQuiesced: false,
					priorControllerEnabled: tx.controllers.enabled,
					priorControllerActive: tx.controllers.active,
				});
			try {
				await runResetDeploymentPhase({
					request: value,
					pendingStore,
					state,
					controllerState: tx.controllers,
					alreadyQuiesced: pending?.controllerQuiesced ?? false,
					quiesce: () => quiesceController({ mode: value.priorMode, runtime, artifacts }),
					resetState: input.resetState,
				});
				return { completed: true, mode: "reset" };
			} catch (error) {
				return fail(error, transaction, value.targetMode);
			}
		},
		probeInstalled: async () => {
			const config = readInstalledConfig(input.path);
			if (config.mode === "managed") await runtime.probeManagedAdapter(artifacts.composeFile);
			else await runtime.probeAdapter(config);
		},
	} satisfies DeploymentLifecycle & {
		readonly pendingStore: PendingRecoveryStore;
		readonly recovery: DeploymentRecovery;
		readonly probeInstalled: () => Promise<void>;
		readonly checkManagedPrerequisites: () => Promise<void>;
	};
}
