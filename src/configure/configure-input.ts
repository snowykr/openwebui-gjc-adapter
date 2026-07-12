import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateAdapterToken, readSecretRecordFromFd } from "./credentials";
import type { CliDependencies, DeploymentLifecycle, ResetRequest } from "./installed-cli-contracts";
import { buildPendingRecoveryLinkage, validatePendingRecoveryRetry } from "./pending-recovery";
import type { PendingRecoveryStore } from "./pending-recovery-store";
import {
	canonicalizeUrl,
	DEFAULT_EXISTING_PROJECT_ROOT,
	type InstalledConfig,
	readInstalledConfig,
	rejectProjectRootArtifactOverlap,
} from "./private-config";

type ConfigureRequest = {
	readonly mode: "managed" | "existing";
	readonly options: Record<string, string | boolean>;
	readonly path: string;
	readonly deployment: DeploymentLifecycle;
	readonly dependencies: CliDependencies;
	readonly pendingStore: PendingRecoveryStore;
	readonly confirmReset: (mode: "managed" | "existing", proof: string) => Promise<boolean>;
};
type BootstrapState = NonNullable<ReturnType<PendingRecoveryStore["readState"]>>;

export interface ConfigureInput {
	readonly mode: "managed" | "existing";
	readonly path: string;
	readonly config: InstalledConfig;
	readonly previous: InstalledConfig | undefined;
	readonly pendingRecovery: NonNullable<ReturnType<PendingRecoveryStore["read"]>>;
	readonly bootstrapCheckpoint: BootstrapState | undefined;
	readonly adminEmail: string;
	readonly adminPassword: string;
	readonly uiPort: number;
	readonly projectRoot: string | undefined;
	readonly needsExistingValidation: boolean;
	readonly resetRequest: ResetRequest | undefined;
}

function optionValue(options: Record<string, string | boolean>, name: string): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}

function fdOption(options: Record<string, string | boolean>, name: string): string {
	const value = optionValue(options, name);
	if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value))
		throw new Error(`configuration requires a decimal --${name}`);
	return readSecretRecordFromFd(Number(value));
}

function assertRegularOrAbsent(path: string): void {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) throw new Error(`configuration artifact must be a regular file or absent: ${path}`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

export async function parseConfigureInput(input: ConfigureRequest): Promise<ConfigureInput> {
	const userUnitDirectory = join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"systemd",
		"user",
	);
	for (const artifact of [
		input.path,
		`${input.path}.compose.yml`,
		`${input.path}.service`,
		`${input.path}.bootstrap.json`,
		`${input.path}.recovery.json`,
		join(dirname(input.path), "adapter-token"),
		join(userUnitDirectory, "openwebui-gjc-adapter.service"),
		join(userUnitDirectory, "openwebui-gjc-adapter-existing.service"),
	])
		assertRegularOrAbsent(artifact);
	const pending = input.pendingStore.read();
	const previous = existsSync(input.path) ? readInstalledConfig(input.path) : undefined;
	const runtimeLocationIdentity = validatePendingRecoveryRetry({
		mode: input.mode,
		options: input.options,
		pending,
		previous,
	});
	if (existsSync(input.path) && (lstatSync(input.path).isSymbolicLink() || lstatSync(input.path).isDirectory()))
		throw new Error("config artifact must be a regular file or absent");
	if (previous && previous.mode !== input.mode && input.options.reset !== true)
		throw new Error("changing the deployment route requires --reset");
	const bindHost = input.mode === "managed" ? "0.0.0.0" : "127.0.0.1";
	const bindPort = Number(optionValue(input.options, "bind-port") ?? pending?.bindPort ?? "8765");
	if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535)
		throw new Error("bind-port must be between 1 and 65535");
	const requestedUiPort = optionValue(input.options, "ui-port");
	const uiPort = Number(requestedUiPort ?? pending?.uiPort ?? "8080");
	if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535)
		throw new Error("ui-port must be between 1 and 65535");
	if (pending !== undefined && requestedUiPort !== undefined && uiPort !== pending.uiPort)
		throw new Error("pending recovery UI port does not match retry input");
	const openWebUIApiUrl =
		pending?.targetUrl ??
		canonicalizeUrl(
			optionValue(input.options, "openwebui-url") ?? (input.mode === "managed" ? `http://localhost:${uiPort}` : ""),
			"openwebui-url",
		);
	let bootstrapCheckpoint: BootstrapState | undefined;
	try {
		bootstrapCheckpoint = input.pendingStore.readState();
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	let openWebUIApiToken: string | undefined;
	let adapterProviderUrl: string;
	let adminEmail = "";
	let adminPassword = "";
	if (input.mode === "managed") {
		adminEmail = fdOption(input.options, "admin-email-fd");
		adminPassword = fdOption(input.options, "admin-password-fd");
		adapterProviderUrl = pending?.providerUrl ?? "http://adapter:8765/v1";
	} else {
		openWebUIApiToken = fdOption(input.options, "openwebui-api-token-fd");
		const raw = optionValue(input.options, "adapter-ingress-url");
		if (!raw) throw new Error("existing configuration requires --adapter-ingress-url");
		adapterProviderUrl = pending?.providerUrl ?? canonicalizeUrl(raw, "adapter-ingress-url");
		if (!adapterProviderUrl.endsWith("/v1")) adapterProviderUrl += "/v1";
	}
	if (previous && previous.openWebUIApiUrl !== openWebUIApiUrl && input.options.reset !== true)
		throw new Error("changing the OpenWebUI URL requires --reset");
	const projectRoot =
		input.mode === "existing"
			? (optionValue(input.options, "project-root") ??
				pending?.projectRoot ??
				previous?.projectRoot ??
				DEFAULT_EXISTING_PROJECT_ROOT)
			: undefined;
	if (
		pending?.mode === "existing" &&
		optionValue(input.options, "project-root") !== undefined &&
		projectRoot !== pending.projectRoot
	)
		throw new Error("pending recovery project root does not match retry input");
	if (input.mode === "existing" && projectRoot !== undefined)
		rejectProjectRootArtifactOverlap(projectRoot, input.path);
	const retainsTargetOwner = previous === undefined || previous.openWebUIApiUrl === openWebUIApiUrl;
	const config: InstalledConfig = {
		version: 1,
		mode: input.mode,
		installationId: pending?.installationId ?? previous?.installationId ?? generateAdapterToken(),
		...(retainsTargetOwner && (previous?.ownerUserId ?? bootstrapCheckpoint?.ownerUserId) !== undefined
			? { ownerUserId: previous?.ownerUserId ?? bootstrapCheckpoint?.ownerUserId }
			: {}),
		adapterToken:
			pending?.adapterToken ?? (previous?.mode === input.mode ? previous.adapterToken : generateAdapterToken()),
		readinessToken: pending?.readinessToken ?? previous?.readinessToken ?? generateAdapterToken(),
		openWebUIApiToken:
			input.mode === "managed"
				? (previous?.openWebUIApiToken ??
					(bootstrapCheckpoint?.apiKeyCreated ? bootstrapCheckpoint.openWebUIApiToken : undefined))
				: openWebUIApiToken,
		openWebUIApiUrl,
		adapterProviderUrl,
		bindHost,
		bindPort,
		projectRoot,
		...runtimeLocationIdentity,
	};
	const pendingRecovery = pending ?? {
		version: 1,
		mode: input.mode,
		priorMode: previous?.mode ?? input.mode,
		installationId: config.installationId,
		transactionId: randomUUID(),
		adapterToken: config.adapterToken,
		readinessToken: config.readinessToken,
		targetUrl: config.openWebUIApiUrl,
		providerUrl: config.adapterProviderUrl,
		uiPort,
		...(input.mode === "existing" ? { bindPort } : {}),
		...(projectRoot === undefined ? {} : { projectRoot }),
		...runtimeLocationIdentity,
		priorControllerEnabled: false,
		priorControllerActive: false,
		controllerRecoveryRequired:
			input.options.reset === true && (input.mode === "managed" || previous?.mode === "managed"),
		controllerQuiesced: false,
		linkage: "",
	};
	const linkedRecovery = pending ?? { ...pendingRecovery, linkage: buildPendingRecoveryLinkage(pendingRecovery) };
	let resetRequest: ResetRequest | undefined;
	if (input.options.reset === true) {
		const proof = optionValue(input.options, "reset-proof");
		if (!proof) throw new Error("reset requires --reset-proof evidence");
		if (!(await input.confirmReset(input.mode, proof)))
			throw new Error("reset requires confirmation of the failed phase on the controlling /dev/tty");
		const failedPhase =
			bootstrapCheckpoint?.failedPhase ??
			(bootstrapCheckpoint?.phase !== undefined && bootstrapCheckpoint.phase !== "complete"
				? bootstrapCheckpoint.phase
				: bootstrapCheckpoint?.phase === "complete" &&
						bootstrapCheckpoint.apiKeyCreated &&
						bootstrapCheckpoint.ownerUserId !== undefined &&
						bootstrapCheckpoint.openWebUIApiToken !== undefined
					? "route"
					: undefined);
		resetRequest = {
			priorMode: linkedRecovery.priorMode,
			targetMode: input.mode,
			proof: { evidence: proof, ...(failedPhase === undefined ? {} : { failedPhase }) },
		};
	}
	return {
		mode: input.mode,
		path: input.path,
		config,
		previous,
		pendingRecovery: linkedRecovery,
		bootstrapCheckpoint,
		adminEmail,
		adminPassword,
		uiPort,
		projectRoot,
		needsExistingValidation:
			input.mode === "existing" && previous === undefined && pending === undefined && input.options.reset !== true,
		resetRequest,
	};
}
