import type { ResolvedAdapterConfig } from "./config";
import { CliLifecycleBackend } from "./gjc/cli-lifecycle-backend";
import {
	routeGjcSessionClose,
	type SessionCloseIngress,
	type SessionMapping,
	type SessionMappingStore,
} from "./gjc/session-router";
import type { GjcCloseReceipt } from "./gjc/turn-runner";
import type { GjcSessionTurnRunner } from "./live/gjc-routing-runner";
import type { SessionCloseResult } from "./projects/link-service";

export interface AdapterCloseOptionsDependencies {
	readonly turnRunner: GjcSessionTurnRunner;
}

export function createAdapterSessionCloser(
	config: ResolvedAdapterConfig,
	cliPath: string,
	dependencies: AdapterCloseOptionsDependencies,
	mappings: SessionMappingStore,
): ((mapping: SessionMapping, ingress: SessionCloseIngress) => Promise<SessionCloseResult>) | undefined {
	const withLifecycleClosePreflight = dependencies.turnRunner.withLifecycleClosePreflight?.bind(
		dependencies.turnRunner,
	);
	if (withLifecycleClosePreflight === undefined) return undefined;
	const closeWithOwnedPaneProof = (mapping: SessionMapping, receipt: GjcCloseReceipt) =>
		requestExitAndProveOwnedSessionClosed(config, cliPath, mapping, receipt);
	return async (mapping, ingress) => {
		const cwd = mapping.attachment?.expectedCwd;
		if (cwd === undefined) throw new Error("GJC close requires a persisted canonical cwd.");
		return withLifecycleClosePreflight(
			{
				cwd,
				sessionRoot: "",
				projectId: mapping.projectId,
				chatId: mapping.chatId,
				sessionId: mapping.sessionId,
				sessionFile: mapping.sessionFile,
				recoveryAttachment: mapping.attachment,
			},
			lifecycle =>
				routeGjcSessionClose({
					mapping,
					mappings,
					ingressId: ingress.ingressId,
					ingressHash: ingress.ingressHash,
					lifecycle,
					close: receipt => closeWithOwnedPaneProof(mapping, receipt),
				}),
		);
	};
}
function ownedLifecycleBackend(
	config: ResolvedAdapterConfig,
	cliPath: string,
	mapping: SessionMapping,
	receipt?: GjcCloseReceipt,
):
	| {
			readonly backend: CliLifecycleBackend;
			readonly attachment: Parameters<CliLifecycleBackend["requestExitAndProveClosedAfterAcknowledgement"]>[0];
	  }
	| undefined {
	const proof = receipt?.proof ?? mapping.attachment;
	if (
		proof?.tmuxSocket === undefined ||
		proof.tmuxPane === undefined ||
		proof.tmuxPanePid === undefined ||
		proof.tmuxOwnershipTag === undefined
	)
		return undefined;
	return {
		backend: new CliLifecycleBackend({
			cliPath,
			cwd: proof.expectedCwd,
			tmuxSocket: proof.tmuxSocket,
			childEnvironment: config.runtimeLocations.childEnvironment,
		}),
		attachment: {
			sessionId: proof.expectedSessionId,
			sessionPath: receipt?.address.sessionFile ?? mapping.sessionFile ?? "",
			pane: {
				target: proof.tmuxPane,
				panePid: proof.tmuxPanePid,
				ownershipTag: proof.tmuxOwnershipTag,
				socketName: proof.tmuxSocket,
			},
		},
	};
}

async function requestExitAndProveOwnedSessionClosed(
	config: ResolvedAdapterConfig,
	cliPath: string,
	mapping: SessionMapping,
	receipt: GjcCloseReceipt,
): Promise<SessionCloseResult> {
	const owned = ownedLifecycleBackend(config, cliPath, mapping, receipt);
	if (owned === undefined)
		return {
			status: "uncertain",
			message:
				"GJC close acknowledgement has endpoint-only proof; no owned pane/process can be terminated and proven absent.",
		};
	return await owned.backend.requestExitAndProveClosedAfterAcknowledgement(owned.attachment);
}
