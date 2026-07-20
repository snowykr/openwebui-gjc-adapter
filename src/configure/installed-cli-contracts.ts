import type { loadInstalledAdapterConfig } from "../config";
import type { AdapterServerHandle } from "../server";
import type { BootstrapPhase } from "./bootstrap-state";
import type { CommandRunner } from "./managed-compose";
import type { configureOpenWebUI } from "./openwebui-setup";
import type { InstalledConfig } from "./private-config";

export interface DeploymentResult {
	readonly completed: true;
	readonly mode: "managed" | "existing" | "reset";
}

export interface ResetRequest {
	readonly priorMode: "managed" | "existing";
	readonly targetMode: "managed" | "existing";
	readonly proof: { readonly evidence: string; readonly failedPhase?: BootstrapPhase };
}

export interface DeploymentLifecycle {
	managed(input: {
		config: InstalledConfig;
		adminEmail: string;
		adminPassword: string;
		uiPort: number;
		recovery?: { readonly controllerRecoveryRequired: boolean; readonly controllerQuiesced?: boolean };
	}): Promise<DeploymentResult> | DeploymentResult;
	existing(input: {
		config: InstalledConfig;
		validation?: { readonly apiKey: string; readonly ownerUserId: string };
	}): Promise<DeploymentResult> | DeploymentResult;
	validateExisting?(input: {
		config: InstalledConfig;
	}):
		| Promise<{ readonly apiKey: string; readonly ownerUserId: string }>
		| { readonly apiKey: string; readonly ownerUserId: string };
	reset(input: ResetRequest): Promise<DeploymentResult> | DeploymentResult;
}

export interface CliDependencies {
	readonly stdout?: { write(value: string): boolean; isTTY?: boolean };
	readonly stderr?: { write(value: string): boolean };
	readonly stdin?: NodeJS.ReadStream;
	readonly terminal?: { readonly input: NodeJS.ReadStream; readonly output: NodeJS.WriteStream };
	readonly managedDocker?: CommandRunner;
	readonly startServer?: (
		config: ReturnType<typeof loadInstalledAdapterConfig>,
	) => AdapterServerHandle | Promise<AdapterServerHandle>;
	readonly deployment?: unknown;
	readonly systemctl?: (args: readonly string[]) => string | undefined;
	readonly probeManagedAdapter?: (composeFile: string) => void | Promise<void>;
	readonly managedReadinessDelayMs?: number;
	readonly confirmAdapterToken?: (token: string) => Promise<boolean> | boolean;
	readonly confirmReset?: (mode: "managed" | "existing", proof: string) => Promise<boolean> | boolean;
	readonly configureOpenWebUI?: typeof configureOpenWebUI;
}
