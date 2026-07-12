import { existsSync, rmSync } from "node:fs";
import { parseConfigureInput } from "./configure-input";
import type { CliDependencies, DeploymentLifecycle, DeploymentResult } from "./installed-cli-contracts";
import type { PendingRecoveryStore } from "./pending-recovery-store";
import { prepareExistingProjectRoot, writeInstalledConfig } from "./private-config";
import type { createProductionDeployment } from "./production-deployment";

export interface ConfigureCommandInput {
	readonly mode: "managed" | "existing";
	readonly options: Record<string, string | boolean>;
	readonly path: string;
	readonly dependencies: CliDependencies;
	readonly production: ReturnType<typeof createProductionDeployment>;
	readonly confirmReset: (mode: "managed" | "existing", proof: string) => Promise<boolean>;
}

function isDeploymentLifecycle(value: unknown): value is DeploymentLifecycle {
	return (
		value !== null &&
		typeof value === "object" &&
		"managed" in value &&
		typeof value.managed === "function" &&
		"existing" in value &&
		typeof value.existing === "function" &&
		"reset" in value &&
		typeof value.reset === "function" &&
		(!("validateExisting" in value) ||
			value.validateExisting === undefined ||
			typeof value.validateExisting === "function")
	);
}

function selectedDeployment(input: ConfigureCommandInput): DeploymentLifecycle {
	if (input.dependencies.deployment === undefined) return input.production;
	if (!isDeploymentLifecycle(input.dependencies.deployment)) throw new Error("deployment lifecycle is invalid");
	return input.dependencies.deployment;
}

function recoveryValue(pending: NonNullable<ReturnType<PendingRecoveryStore["read"]>>):
	| {
			readonly controllerRecoveryRequired: true;
			readonly controllerQuiesced?: true;
	  }
	| undefined {
	if (!pending.controllerRecoveryRequired) return undefined;
	return { controllerRecoveryRequired: true, ...(pending.controllerQuiesced ? { controllerQuiesced: true } : {}) };
}

function verifyResult(result: DeploymentResult, mode: DeploymentResult["mode"]): void {
	if (result.completed !== true || result.mode !== mode)
		throw new Error(`${mode} deployment lifecycle did not complete successfully`);
}

export async function runConfigureCommand(input: ConfigureCommandInput): Promise<void> {
	const deployment = selectedDeployment(input);
	if (input.mode === "managed" && input.dependencies.deployment === undefined)
		await input.production.checkManagedPrerequisites();
	let pending = input.production.pendingStore.read();
	input.production.recovery.validatePair(pending);
	pending = input.production.pendingStore.read();
	const parsed = await parseConfigureInput({
		mode: input.mode,
		options: input.options,
		path: input.path,
		deployment,
		dependencies: input.dependencies,
		pendingStore: input.production.pendingStore,
		confirmReset: input.confirmReset,
	});
	const existingValidation = parsed.needsExistingValidation
		? await deployment.validateExisting?.({ config: parsed.config })
		: undefined;
	if (parsed.mode === "existing" && parsed.projectRoot !== undefined) prepareExistingProjectRoot(parsed.projectRoot);
	if (!existsSync(`${parsed.path}.recovery.json`))
		input.production.recovery.capture(parsed.pendingRecovery.transactionId);
	input.production.pendingStore.write(parsed.pendingRecovery);
	let recovery = recoveryValue(parsed.pendingRecovery);
	if (parsed.resetRequest !== undefined) {
		const resetResult = await deployment.reset(parsed.resetRequest);
		verifyResult(resetResult, "reset");
		input.production.pendingStore.update({ controllerQuiesced: true, controllerRecoveryRequired: true });
		recovery = { controllerRecoveryRequired: true, controllerQuiesced: true };
	}
	writeInstalledConfig(parsed.config, parsed.path);
	let result: DeploymentResult;
	try {
		result =
			parsed.mode === "managed"
				? await deployment.managed({
						config: parsed.config,
						adminEmail: parsed.adminEmail,
						adminPassword: parsed.adminPassword,
						uiPort: parsed.uiPort,
						recovery,
					})
				: await deployment.existing({
						config: parsed.config,
						...(existingValidation === undefined ? {} : { validation: existingValidation }),
					});
	} catch (error) {
		if (parsed.previous) writeInstalledConfig(parsed.previous, parsed.path);
		else rmSync(parsed.path, { force: true });
		throw error;
	}
	verifyResult(result, parsed.mode);
	writeInstalledConfig(parsed.config, parsed.path);
	input.production.recovery.complete(parsed.pendingRecovery.transactionId);
}
