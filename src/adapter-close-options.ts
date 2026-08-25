import type { ResolvedAdapterConfig } from "./config";
import { CliLifecycleBackend } from "./gjc/cli-lifecycle-backend";
import {
	routeGjcSessionClose,
	type SessionCloseIngress,
	type SessionMapping,
	type SessionMappingStore,
} from "./gjc/session-router";
import type { GjcCloseReceipt } from "./gjc/turn-runner";
import type { ManagedSdkRuntimeDependency } from "./live/gjc-routing-lifecycle";
import type { GjcSessionTurnRunner } from "./live/gjc-routing-runner";
import type { SessionCloseResult } from "./projects/link-service";

export interface AdapterCloseOptionsDependencies {
	/** Process-owned managed runtime for mappings with complete managed authority. */
	readonly managedSdkRuntime?: ManagedSdkRuntimeDependency;
	/** Exact managed tenant lease/epoch fence. */
	readonly managedSdkTenantFence?: import("./live/gjc-routing-lifecycle").ManagedSdkTenantFence;
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
	const managedCloseAvailable =
		dependencies.managedSdkRuntime !== undefined && dependencies.managedSdkTenantFence !== undefined;
	if (withLifecycleClosePreflight === undefined && !managedCloseAvailable) return undefined;
	const closeWithOwnedPaneProof = (mapping: SessionMapping, receipt: GjcCloseReceipt) =>
		requestExitAndProveOwnedSessionClosed(config, cliPath, mapping, receipt);
	return async (mapping, ingress) => {
		if (hasCompleteManagedAuthority(mapping)) {
			if (!managedCloseAvailable)
				return {
					status: "uncertain",
					message: "Managed GJC close requires a process-owned runtime and exact tenant fence.",
				};
			return routeGjcSessionClose({
				mapping,
				mappings,
				ingressId: ingress.ingressId,
				ingressHash: ingress.ingressHash,
				legacyIngress: ingress.legacyIngress,
				managedSdkRuntime: dependencies.managedSdkRuntime,
				managedSdkTenantFence: dependencies.managedSdkTenantFence,
				lifecycle: undefined as never,
				close: undefined as never,
			});
		}
		if (withLifecycleClosePreflight === undefined) throw new Error("GJC close lifecycle preflight is unavailable.");
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
					legacyIngress: ingress.legacyIngress,
					lifecycle,
					close: receipt => closeWithOwnedPaneProof(mapping, receipt),
				}),
		);
	};
}

function hasCompleteManagedAuthority(
	mapping: SessionMapping,
): mapping is SessionMapping & { readonly managedAuthority: NonNullable<SessionMapping["managedAuthority"]> } {
	const authority = mapping.managedAuthority;
	return (
		authority !== undefined &&
		authority.chatId === mapping.chatId &&
		authority.projectId === mapping.projectId &&
		authority.sessionId === mapping.sessionId &&
		(typeof mapping.principalId !== "string" || authority.principalId === mapping.principalId) &&
		[
			authority.principalId,
			authority.projectId,
			authority.canonicalWorkspace,
			authority.chatId,
			authority.sessionId,
		].every(value => typeof value === "string" && value.length > 0) &&
		Number.isSafeInteger(authority.generation) &&
		authority.generation > 0 &&
		[authority.leaseId, authority.epoch, authority.requestKey].every(
			value => typeof value === "string" && value.length > 0,
		)
	);
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
