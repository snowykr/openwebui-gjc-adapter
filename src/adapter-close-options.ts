import { isAbsolute, resolve } from "node:path";
import { SESSION_AUTHORITY_V3_EPOCH } from "./gjc/session-authority-v3";
import {
	routeGjcSessionClose,
	type SessionCloseIngress,
	type SessionMapping,
	type SessionMappingStore,
} from "./gjc/session-router";
import type { ManagedSdkRuntimeDependency } from "./live/gjc-routing-lifecycle";
import type { SessionCloseResult } from "./projects/link-service";

export interface AdapterCloseOptionsDependencies {
	/** Process-owned managed runtime for mappings at the canonical V3 authority epoch. */
	readonly managedSdkRuntime?: ManagedSdkRuntimeDependency;
	/** Exact managed tenant lease/epoch fence. */
	readonly managedSdkTenantFence?: import("./live/gjc-routing-lifecycle").ManagedSdkTenantFence;
}

export function createAdapterSessionCloser(
	dependencies: AdapterCloseOptionsDependencies,
	mappings: SessionMappingStore,
): ((mapping: SessionMapping, ingress: SessionCloseIngress) => Promise<SessionCloseResult>) | undefined {
	const managedCloseAvailable =
		dependencies.managedSdkRuntime !== undefined && dependencies.managedSdkTenantFence !== undefined;
	if (!managedCloseAvailable) return undefined;
	return async (mapping, ingress) => {
		if (!isCanonicalManagedV3Epoch(mapping) || !hasCompleteManagedAuthority(mapping))
			return {
				status: "uncertain",
				message: "Managed V3 close requires complete managed authority at the canonical epoch.",
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
