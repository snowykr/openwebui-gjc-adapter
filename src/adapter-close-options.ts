import { isAbsolute, resolve } from "node:path";
import type { ResolvedAdapterConfig } from "./config";
import { CliLifecycleBackend } from "./gjc/cli-lifecycle-backend";
import { SESSION_AUTHORITY_V3_EPOCH } from "./gjc/session-authority-v3";
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
	/** Process-owned managed runtime for mappings at the canonical V3 authority epoch. */
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
		if (isCanonicalManagedV3Epoch(mapping)) {
			if (!hasCompleteManagedAuthority(mapping))
				return {
					status: "uncertain",
					message: "Managed V3 close requires complete managed authority at the canonical epoch.",
				};
			if (!managedCloseAvailable)
				return {
					status: "uncertain",
					message: "Managed GJC close requires a process-owned runtime and exact tenant fence.",
				};
			const runtime = dependencies.managedSdkRuntime;
			const tenantFence = dependencies.managedSdkTenantFence;
			if (runtime === undefined || tenantFence === undefined)
				throw new Error("Managed GJC close runtime or exact tenant fence is unavailable.");
			const fencedRuntime = new Proxy(runtime, {
				get(target, property) {
					if (property !== "generationStatus") {
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					}
					return async (tenant: Parameters<ManagedSdkRuntimeDependency["generationStatus"]>[0]) => {
						const status = await target.generationStatus(tenant);
						if (!(await tenantFence(tenant)))
							throw new Error("Managed tenant authority fence was lost after exact generation proof.");
						return status;
					};
				},
			});
			return routeGjcSessionClose({
				mapping,
				mappings,
				ingressId: ingress.ingressId,
				ingressHash: ingress.ingressHash,
				legacyIngress: ingress.legacyIngress,
				managedSdkRuntime: fencedRuntime,
				managedSdkTenantFence: tenantFence,
				lifecycle: undefined as never,
				close: undefined as never,
			});
		}
		if (withLifecycleClosePreflight === undefined) throw new Error("GJC close lifecycle preflight is unavailable.");
		// The legacy router still recognizes any complete managed authority. Strip
		// non-canonical authority before entering that path so only the canonical
		// V3 epoch can select the public managed close flow.
		const legacyMapping =
			mapping.managedAuthority === undefined ? mapping : { ...mapping, managedAuthority: undefined };
		const cwd = legacyMapping.attachment?.expectedCwd;
		if (cwd === undefined) throw new Error("GJC close requires a persisted canonical cwd.");
		return withLifecycleClosePreflight(
			{
				cwd,
				sessionRoot: "",
				projectId: legacyMapping.projectId,
				chatId: legacyMapping.chatId,
				sessionId: legacyMapping.sessionId,
				sessionFile: legacyMapping.sessionFile,
				recoveryAttachment: legacyMapping.attachment,
			},
			lifecycle =>
				routeGjcSessionClose({
					mapping: legacyMapping,
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

function isCanonicalManagedV3Epoch(mapping: SessionMapping): boolean {
	return (
		(mapping.managedAuthority as ManagedTurnAuthorityWithEpoch | undefined)?.authorityEpoch ===
		SESSION_AUTHORITY_V3_EPOCH
	);
}

function hasCompleteManagedAuthority(
	mapping: SessionMapping,
): mapping is SessionMapping & { readonly managedAuthority: NonNullable<SessionMapping["managedAuthority"]> } {
	const authority = mapping.managedAuthority;
	return (
		(authority as ManagedTurnAuthorityWithEpoch | undefined)?.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		authority !== undefined &&
		authority.chatId === mapping.chatId &&
		authority.projectId === mapping.projectId &&
		authority.sessionId === mapping.sessionId &&
		mapping.principalId === authority.principalId &&
		[
			authority.principalId,
			authority.projectId,
			authority.canonicalWorkspace,
			authority.chatId,
			authority.sessionId,
		].every(value => typeof value === "string" && value.length > 0) &&
		isAbsolute(authority.canonicalWorkspace) &&
		resolve(authority.canonicalWorkspace) === authority.canonicalWorkspace &&
		Number.isSafeInteger(authority.generation) &&
		authority.generation > 0 &&
		[authority.leaseId, authority.epoch, authority.requestKey].every(
			value => typeof value === "string" && value.length > 0,
		)
	);
}

type ManagedTurnAuthorityWithEpoch = NonNullable<SessionMapping["managedAuthority"]> & {
	readonly authorityEpoch?: unknown;
};

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
