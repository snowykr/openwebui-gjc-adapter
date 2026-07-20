import type { ResolvedAdapterConfig } from "./config";
import { CliLifecycleBackend } from "./gjc/cli-lifecycle-backend";
import type { PublicSdkSessionCoordinatorOwner, PublicSdkSessionPort } from "./gjc/public-sdk-contract";
import { PublicSdkSessionClient } from "./gjc/public-sdk-session-port";
import { SdkV3OperationError } from "./gjc/sdk-v3-protocol";
import type { GjcCloseReceipt } from "./gjc/turn-runner";
import {
	routeGjcSessionClose,
	type SessionCloseIngress,
	type SessionMapping,
	type SessionMappingStore,
} from "./gjc/session-router";
import type { GjcSessionTurnRunner } from "./live/gjc-routing-runner";
import type { PublicSdkSessionPortFactory } from "./live/model-reader";
import type { SessionCloseResult } from "./projects/link-service";

export interface AdapterCloseOptionsDependencies {
	readonly turnRunner: GjcSessionTurnRunner;
	readonly sessionPortFactory?: PublicSdkSessionPortFactory;
	/** Post-ack proof must observe endpoint disappearance and the persisted owned pane/process; it must never kill. */
	readonly proveClosedSession?: (mapping: SessionMapping, receipt: GjcCloseReceipt) => Promise<SessionCloseResult>;
}

export function createAdapterSessionCloser(
	config: ResolvedAdapterConfig,
	cliPath: string,
	dependencies: AdapterCloseOptionsDependencies,
	mappings: SessionMappingStore,
): ((mapping: SessionMapping, ingress: SessionCloseIngress) => Promise<SessionCloseResult>) | undefined {
	const withLifecycleClosePreflight = dependencies.turnRunner.withLifecycleClosePreflight;
	if (withLifecycleClosePreflight === undefined) return undefined;
	const closeAcknowledgedSession = dependencies.proveClosedSession === undefined
		? ((mapping: SessionMapping, receipt: GjcCloseReceipt) => requestExitAndProveOwnedSessionClosed(config, cliPath, mapping, receipt))
		: undefined;
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
			lifecycle => routeGjcSessionClose({
				mapping,
				mappings,
				ingressId: ingress.ingressId,
				ingressHash: ingress.ingressHash,
				lifecycle,
				close: async receipt => closeAcknowledgedSessionWithProof(dependencies, closeAcknowledgedSession, mapping, receipt, lifecycle.owner),
			}),
		);
	};
}

async function closeAcknowledgedSessionWithProof(
	dependencies: AdapterCloseOptionsDependencies,
	closeAcknowledgedSession: ((mapping: SessionMapping, receipt: GjcCloseReceipt) => Promise<SessionCloseResult>) | undefined,
	mapping: SessionMapping,
	receipt: GjcCloseReceipt,
	owner: PublicSdkSessionCoordinatorOwner,
): Promise<SessionCloseResult> {
	let port: PublicSdkSessionPort | undefined;
	let closeInvoked = false;
	try {
		port = (dependencies.sessionPortFactory?.() ?? new PublicSdkSessionClient()) as PublicSdkSessionPort;
		await port.attach(receipt.attachment, undefined, owner);
		closeInvoked = true;
		await port.closeSession();
		if (dependencies.proveClosedSession !== undefined) return await dependencies.proveClosedSession(mapping, receipt);
		if (closeAcknowledgedSession === undefined)
			return { status: "uncertain", message: "GJC public SDK acknowledged close, but no persisted owned-pane closure lifecycle is available." };
		return await closeAcknowledgedSession(mapping, receipt);
	} catch (error) {
		if (closeInvoked) return { status: "uncertain", message: error instanceof Error ? error.message : "GJC close acknowledgement could not be proven." };
		if (error instanceof SdkV3OperationError && error.code === "endpoint_stale") return { status: "unavailable", message: error.message };
		return {
			status: "unavailable",
			message: error instanceof Error
				? `GJC public SDK could not attach for close acknowledgement: ${error.message}`
				: "GJC public SDK could not attach for close acknowledgement.",
		};
	} finally {
		port?.detach();
	}
}

function ownedLifecycleBackend(
	config: ResolvedAdapterConfig,
	cliPath: string,
	mapping: SessionMapping,
	receipt?: GjcCloseReceipt,
): { readonly backend: CliLifecycleBackend; readonly attachment: Parameters<CliLifecycleBackend["requestExitAndProveClosedAfterAcknowledgement"]>[0] } | undefined {
	const proof = receipt?.proof ?? mapping.attachment;
	if (proof?.tmuxSocket === undefined || proof.tmuxPane === undefined || proof.tmuxPanePid === undefined || proof.tmuxOwnershipTag === undefined) return undefined;
	return {
		backend: new CliLifecycleBackend({ cliPath, cwd: proof.expectedCwd, tmuxSocket: proof.tmuxSocket, childEnvironment: config.runtimeLocations.childEnvironment }),
		attachment: { sessionId: proof.expectedSessionId, sessionPath: receipt?.address.sessionFile ?? mapping.sessionFile ?? "", pane: { target: proof.tmuxPane, panePid: proof.tmuxPanePid, ownershipTag: proof.tmuxOwnershipTag, socketName: proof.tmuxSocket } },
	};
}

async function requestExitAndProveOwnedSessionClosed(config: ResolvedAdapterConfig, cliPath: string, mapping: SessionMapping, receipt: GjcCloseReceipt): Promise<SessionCloseResult> {
	const owned = ownedLifecycleBackend(config, cliPath, mapping, receipt);
	if (owned === undefined)
		return { status: "uncertain", message: "GJC close acknowledgement has endpoint-only proof; no owned pane/process can be terminated and proven absent." };
	return await owned.backend.requestExitAndProveClosedAfterAcknowledgement(owned.attachment);
}
