export type AdapterHealthStatus = "ok" | "degraded";

export interface AdapterHealthCheck {
	name: string;
	status: AdapterHealthStatus;
	detail?: string;
}

export interface AdapterHealthReport {
	status: AdapterHealthStatus;
	service: "openwebui-gjc-adapter";
	checks: AdapterHealthCheck[];
}

/** Runtime-owned, non-secret state used by the authenticated readiness probe. */
export interface AdapterReadinessOptions {
	readonly openWebUIAuthenticated: boolean;
	readonly promptHintsSeeded: boolean;
	readonly reason?: string;
	readonly mode?: "managed" | "existing";
	readonly generation?: string;
	readonly model?: string;
}

export interface AdapterReadinessReport {
	status: "ready" | "not_ready";
	service: "openwebui-gjc-adapter";
	identity: { readonly mode: "managed" | "existing" | "unknown" };
	generation: string | null;
	model: string | null;
	seed: { readonly promptHints: "ready" | "pending" };
	readonly reason?: string;
}

export function buildHealthReport(checks: readonly AdapterHealthCheck[] = []): AdapterHealthReport {
	const status: AdapterHealthStatus = checks.some(check => check.status === "degraded") ? "degraded" : "ok";
	return {
		status,
		service: "openwebui-gjc-adapter",
		checks: [...checks],
	};
}

export function buildReadinessReport(options: AdapterReadinessOptions): AdapterReadinessReport {
	const authenticated = options.openWebUIAuthenticated === true;
	const hintsSeeded = options.promptHintsSeeded === true;
	const ready = authenticated && hintsSeeded;
	return {
		status: ready ? "ready" : "not_ready",
		service: "openwebui-gjc-adapter",
		identity: { mode: options.mode ?? "unknown" },
		generation: options.generation ?? null,
		model: options.model ?? null,
		seed: { promptHints: hintsSeeded ? "ready" : "pending" },
		...(ready ? {} : { reason: options.reason ?? "runtime initialization is incomplete" }),
	};
}
