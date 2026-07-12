import { expect, test } from "bun:test";
import type {
	BootstrapPhase,
	BootstrapResetProof,
	BootstrapState,
	BootstrapStateStore,
	ExclusiveMaintenanceBoundary,
	PendingRecoveryRecord,
} from "../src/configure/bootstrap-state";
import {
	advanceBootstrapState,
	BOOTSTRAP_PHASES,
	INITIAL_BOOTSTRAP_STATE,
	isBootstrapPhaseComplete,
	parseBootstrapState,
	recoverBootstrapState,
	resetBootstrapState,
	withExclusiveMaintenance,
} from "../src/configure/bootstrap-state";
import type {
	CliDependencies,
	DeploymentLifecycle,
	DeploymentResult,
	ResetRequest,
} from "../src/configure/installed-cli";
import { runInstalledCli } from "../src/configure/installed-cli";
import { configureOpenWebUI } from "../src/configure/openwebui-setup";

const phase: BootstrapPhase = "preflight";
const proof: BootstrapResetProof = { failedPhase: phase, evidence: "pinned" };
const boundary: ExclusiveMaintenanceBoundary = { begin: async () => {}, end: async () => {} };
const store: BootstrapStateStore = {
	read: async () => INITIAL_BOOTSTRAP_STATE,
	write: async (_state: BootstrapState) => {},
};
const result: DeploymentResult = { completed: true, mode: "existing" };
const reset: ResetRequest = {
	priorMode: "existing",
	targetMode: "managed",
	proof: { evidence: "reset", failedPhase: phase },
};
const deployment: DeploymentLifecycle = {
	managed: input => {
		const recovery =
			input.recovery?.controllerRecoveryRequired === true && input.recovery.controllerQuiesced === true;
		expect([input.config.installationId, input.adminEmail, input.adminPassword, input.uiPort, recovery]).toHaveLength(
			5,
		);
		return { completed: true, mode: "managed" };
	},
	existing: input => {
		const validation: readonly string[] =
			input.validation === undefined ? [] : [input.validation.apiKey, input.validation.ownerUserId];
		expect([input.config.installationId, validation]).toHaveLength(2);
		return { completed: true, mode: "existing" };
	},
	validateExisting: input => ({ apiKey: input.config.adapterToken, ownerUserId: "owner" }),
	reset: input => {
		expect([input.priorMode, input.targetMode, input.proof.evidence, input.proof.failedPhase]).toHaveLength(4);
		return { completed: true, mode: "reset" };
	},
};
const dependencies: CliDependencies = {
	stdout: { write: (_value: string) => true, isTTY: false },
	stderr: { write: (_value: string) => true },
	stdin: process.stdin,
	terminal: { input: process.stdin, output: process.stdout },
	managedDocker: {
		run: async (_command, _args, _options) => ({ exitCode: 0, stdout: "", stderr: "" }),
	},
	startServer: async config => ({
		url: `http://${config.bindHost}:${config.bindPort}`,
		stop: async () => {},
	}),
	deployment,
	systemctl: (_args: readonly string[]) => undefined,
	probeManagedAdapter: async (_composeFile: string) => {},
	managedReadinessDelayMs: 0,
	confirmAdapterToken: async (_token: string) => true,
	confirmReset: async (_mode: "managed" | "existing", _evidence: string) => true,
	configureOpenWebUI,
};
const pending: PendingRecoveryRecord = {
	version: 1,
	mode: "existing",
	priorMode: "existing",
	installationId: "install",
	transactionId: "transaction",
	adapterToken: "adapter",
	readinessToken: "ready",
	targetUrl: "http://localhost:8080",
	providerUrl: "http://localhost:8765/v1",
	uiPort: 8080,
	bindPort: 8765,
	projectRoot: "/tmp/project",
	priorControllerEnabled: false,
	priorControllerActive: false,
	controllerRecoveryRequired: false,
	controllerQuiesced: false,
	linkage:
		"existing:install:http://localhost:8080:http://localhost:8765/v1:8080:/tmp/project:8765:existing:disabled:inactive:controller-live:controller-live",
};

const parseSignature: (value: unknown) => BootstrapState = parseBootstrapState;
const completeSignature: (state: BootstrapState, phase: BootstrapPhase) => boolean = isBootstrapPhaseComplete;
const recoverSignature: (state: BootstrapState) => BootstrapState = recoverBootstrapState;
const advanceSignature: (
	state: BootstrapState,
	phase: BootstrapPhase,
	patch?: Partial<Omit<BootstrapState, "version" | "phase">>,
) => BootstrapState = advanceBootstrapState;
const resetSignature: (
	state: BootstrapState,
	failedPhase: BootstrapPhase,
	proof: BootstrapResetProof,
) => BootstrapState = resetBootstrapState;
const exclusiveSignature: <T>(boundary: ExclusiveMaintenanceBoundary, action: () => Promise<T>) => Promise<T> =
	withExclusiveMaintenance;
const cliSignature: (argv?: readonly string[], dependencies?: CliDependencies) => Promise<number> = runInstalledCli;

test("public configure facade preserves every runtime value and compile-time consumer", async () => {
	const state: BootstrapState = {
		...INITIAL_BOOTSTRAP_STATE,
		ownerUserId: "owner",
		openWebUIApiToken: "openwebui-token",
		pendingRecovery: pending,
		failedPhase: phase,
		failureEvidence: "evidence",
	};
	expect(BOOTSTRAP_PHASES).toEqual(["preflight", "bootstrap", "api-key", "openai", "route", "ownership", "complete"]);
	expect(INITIAL_BOOTSTRAP_STATE).toEqual({
		version: 1,
		phase: "preflight",
		bootstrapComplete: false,
		apiKeyCreated: false,
		openAIConfigured: false,
		routeVerified: false,
		ownershipVerified: false,
		openAIConnectionIds: [],
	});
	expect(parseSignature(state)).toEqual(state);
	expect(completeSignature(state, phase)).toBeTrue();
	expect(recoverSignature(state).phase).toBe("preflight");
	expect(advanceSignature(state, "bootstrap", { bootstrapComplete: true }).phase).toBe("bootstrap");
	expect(() => resetSignature(state, phase, proof)).not.toThrow();
	expect(await exclusiveSignature(boundary, async () => result)).toBe(result);
	expect(typeof store.read).toBe("function");
	expect(reset.proof.failedPhase).toBe(phase);
	expect(dependencies.deployment).toBe(deployment);
	expect(dependencies.stdin).toBe(process.stdin);
	expect(dependencies.terminal?.output).toBe(process.stdout);
	expect(typeof dependencies.managedDocker?.run).toBe("function");
	expect(typeof dependencies.startServer).toBe("function");
	expect(dependencies.configureOpenWebUI).toBe(configureOpenWebUI);
	expect(typeof cliSignature).toBe("function");
	expect(runInstalledCli.length).toBe(0);
});
