import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ControllerState } from "./controller-lifecycle";
import type { DeploymentArtifacts } from "./deployment-artifacts";
import { rollbackDeploymentArtifacts } from "./deployment-artifacts";
import {
	captureDurableDeploymentSnapshot,
	type DurableDeploymentSnapshot,
	restoreDurableDeploymentSnapshot,
} from "./durable-deployment-snapshot";
import type { FileSnapshot } from "./file-snapshots";
import type { InstalledConfig } from "./private-config";

export interface DeploymentTransaction {
	readonly snapshots: readonly FileSnapshot[];
	readonly previous?: InstalledConfig;
	readonly priorMode: "managed" | "existing";
	readonly controllers: ControllerState;
}

type BeginInput = {
	readonly path: string;
	readonly artifacts: DeploymentArtifacts;
	readonly priorMode: "managed" | "existing";
	readonly controllers: ControllerState;
	readonly previous?: InstalledConfig;
	readonly restored?: DeploymentTransaction;
};

type RollbackInput = {
	readonly transaction: DeploymentTransaction | undefined;
	readonly attemptedMode: "managed" | "existing";
	readonly path: string;
	readonly artifacts: DeploymentArtifacts;
	readonly controller: {
		readonly stop: (mode: "managed" | "existing") => void;
		readonly disable: (mode: "managed" | "existing") => void;
		readonly reload: () => void;
		readonly restore: (mode: "managed" | "existing", state: ControllerState) => void;
	};
	readonly checkpoint: unknown;
	readonly writeCheckpoint: (checkpoint: unknown) => Promise<void>;
	readonly pendingBeforeRollback: unknown;
	readonly finishDurableRollback: (pending: unknown) => void;
};

type RecoveryRecord = {
	readonly mode: "managed" | "existing";
	readonly priorMode: "managed" | "existing";
	readonly installationId: string;
	readonly transactionId: string;
	readonly adapterToken: string;
	readonly readinessToken: string;
	readonly targetUrl: string;
	readonly providerUrl: string;
	readonly bindPort?: number;
	readonly projectRoot?: string;
	readonly priorControllerEnabled: boolean;
	readonly priorControllerActive: boolean;
};

type RecoveryInput<State> = {
	readonly path: string;
	readonly userUnitDirectory: string;
	readonly parseState: (value: unknown) => State;
	readonly pendingFromState: (state: State) => RecoveryRecord | undefined;
	readonly validateConfig: (value: unknown) => InstalledConfig;
	readonly readConfig: (path: string) => InstalledConfig;
	readonly removePending: () => void;
};

export interface DeploymentRecovery {
	readonly restoreValidated: () => DurableDeploymentSnapshot | undefined;
	readonly validatePair: (pending: RecoveryRecord | undefined) => void;
	readonly capture: (transactionId: string) => void;
	readonly complete: (transactionId: string) => void;
	readonly finishRollback: (pending: unknown) => void;
	readonly restoreTransaction: (pending: RecoveryRecord | undefined) => DeploymentTransaction | undefined;
}

function captureBootstrap(path: string): Buffer | undefined {
	const bootstrapPath = `${path}.bootstrap.json`;
	return existsSync(bootstrapPath) ? readFileSync(bootstrapPath) : undefined;
}

function attempt(errors: Error[], action: () => void): void {
	try {
		action();
	} catch (error) {
		errors.push(error instanceof Error ? error : new Error(String(error)));
	}
}

export function createDeploymentRecovery<State>(input: RecoveryInput<State>): DeploymentRecovery {
	const restoreValidated = () =>
		restoreDurableDeploymentSnapshot(input.path, (snapshotPath, content) => {
			if (snapshotPath === input.path) input.validateConfig(JSON.parse(content.toString("utf8")));
			if (snapshotPath === `${input.path}.bootstrap.json`) {
				const captured = input.parseState(JSON.parse(content.toString("utf8")));
				if (input.pendingFromState(captured) !== undefined)
					throw new Error("captured bootstrap state contains nested pending recovery");
			}
		});
	const validatePair = (pending: RecoveryRecord | undefined): void => {
		const snapshot = restoreValidated();
		if (pending === undefined && snapshot === undefined) return;
		if (pending === undefined && snapshot !== undefined) {
			restoreDurableDeploymentSnapshot({ remove: input.path });
			return;
		}
		if (pending === undefined || snapshot === undefined)
			throw new Error("pending recovery and recovery snapshot must be present together");
		if (snapshot.transactionId !== pending.transactionId)
			throw new Error("pending recovery and recovery snapshot transaction IDs do not match");
		if (snapshot.status === "complete") {
			input.removePending();
			restoreDurableDeploymentSnapshot({ remove: input.path });
			return;
		}
		const configSnapshot = snapshot.snapshots.find(item => item.path === input.path && item.content !== undefined);
		let captured: InstalledConfig | undefined;
		if (configSnapshot?.content !== undefined) {
			try {
				captured = input.validateConfig(JSON.parse(configSnapshot.content.toString("utf8")));
			} catch (error) {
				throw new Error(`invalid captured config: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (
			captured !== undefined &&
			(captured.mode !== pending.priorMode || captured.installationId !== pending.installationId)
		)
			throw new Error("captured config identity does not match pending recovery");
		if (!existsSync(input.path)) return;
		let live: InstalledConfig;
		try {
			live = input.readConfig(input.path);
		} catch (error) {
			throw new Error(
				`invalid live config during recovery: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const targetMatches =
			live.mode === pending.mode &&
			live.installationId === pending.installationId &&
			live.adapterToken === pending.adapterToken &&
			live.readinessToken === pending.readinessToken &&
			live.openWebUIApiUrl === pending.targetUrl &&
			live.adapterProviderUrl === pending.providerUrl &&
			live.bindPort === (pending.bindPort ?? live.bindPort) &&
			live.projectRoot === pending.projectRoot;
		const priorMatches =
			captured !== undefined &&
			live.mode === captured.mode &&
			live.installationId === captured.installationId &&
			live.adapterToken === captured.adapterToken &&
			live.readinessToken === captured.readinessToken &&
			live.openWebUIApiUrl === captured.openWebUIApiUrl &&
			live.adapterProviderUrl === captured.adapterProviderUrl &&
			live.bindHost === captured.bindHost &&
			live.bindPort === captured.bindPort &&
			live.projectRoot === captured.projectRoot;
		if (!targetMatches && !priorMatches)
			throw new Error("live config does not match captured prior or pending recovery target");
	};
	return {
		restoreValidated,
		validatePair,
		capture: transactionId => {
			captureDurableDeploymentSnapshot(input.path, input.userUnitDirectory, transactionId);
		},
		complete: transactionId => {
			const durable = restoreValidated();
			if (durable === undefined) throw new Error("recovery snapshot is missing");
			if (durable.transactionId !== transactionId) throw new Error("recovery snapshot transaction IDs do not match");
			durable.markComplete();
			input.removePending();
			restoreDurableDeploymentSnapshot({ remove: input.path });
		},
		finishRollback: pending => {
			if (pending === undefined) throw new Error("rollback recovery journal is missing");
			const durable = restoreValidated();
			if (durable === undefined) throw new Error("recovery snapshot is missing");
			durable.markComplete();
			input.removePending();
			durable.remove();
		},
		restoreTransaction: pending => {
			const journal = restoreValidated();
			if (pending === undefined && journal === undefined) return undefined;
			if (pending === undefined || journal === undefined)
				throw new Error("pending recovery and recovery snapshot must be present together");
			if (journal.transactionId !== pending.transactionId)
				throw new Error("pending recovery and recovery snapshot transaction IDs do not match");
			const prior = journal.snapshots.find(
				snapshot => snapshot.path === input.path && snapshot.content !== undefined,
			)?.content;
			const previous = prior === undefined ? undefined : input.validateConfig(JSON.parse(prior.toString("utf8")));
			if (
				previous !== undefined &&
				(previous.mode !== pending.priorMode || previous.installationId !== pending.installationId)
			)
				throw new Error("captured config identity does not match pending recovery");
			return {
				snapshots: journal.snapshots,
				...(previous === undefined ? {} : { previous }),
				priorMode: pending.priorMode,
				controllers: { enabled: pending.priorControllerEnabled, active: pending.priorControllerActive },
			};
		},
	};
}

export function beginDeploymentTransaction(input: BeginInput): DeploymentTransaction {
	if (input.restored !== undefined) return input.restored;
	return {
		snapshots: captureDurableDeploymentSnapshot(input.path, input.artifacts.userUnitDirectory).snapshots,
		...(input.previous === undefined ? {} : { previous: input.previous }),
		priorMode: input.priorMode,
		controllers: input.controllers,
	};
}

export function commitDeploymentTransaction(input: {
	readonly transaction: DeploymentTransaction;
	readonly targetMode: "managed" | "existing";
	readonly commitArtifacts: (priorMode: "managed" | "existing", targetMode: "managed" | "existing") => void;
}): void {
	input.commitArtifacts(input.transaction.priorMode, input.targetMode);
}

export async function rollbackDeploymentTransaction(input: RollbackInput): Promise<Error[]> {
	const tx = input.transaction;
	if (tx === undefined) return [];
	const errors: Error[] = [];
	const bootstrapBeforeRollback = captureBootstrap(input.path);
	attempt(errors, () => input.controller.stop(input.attemptedMode));
	attempt(errors, () => input.controller.disable(input.attemptedMode));
	if (tx.previous !== undefined)
		attempt(errors, () =>
			rollbackDeploymentArtifacts({ snapshots: tx.snapshots, restore: restoreDurableDeploymentSnapshot }),
		);
	if (input.checkpoint !== undefined && tx.previous === undefined) {
		try {
			await input.writeCheckpoint(input.checkpoint);
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (bootstrapBeforeRollback !== undefined && tx.previous === undefined)
		attempt(errors, () => writeFileSync(`${input.path}.bootstrap.json`, bootstrapBeforeRollback, { mode: 0o600 }));
	attempt(errors, input.controller.reload);
	attempt(errors, () => input.controller.restore(tx.priorMode, tx.controllers));
	if (errors.length === 0 && tx.previous !== undefined)
		attempt(errors, () => input.finishDurableRollback(input.pendingBeforeRollback));
	return errors;
}
