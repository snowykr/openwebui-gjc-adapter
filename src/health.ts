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

export function buildHealthReport(checks: readonly AdapterHealthCheck[] = []): AdapterHealthReport {
	const status: AdapterHealthStatus = checks.some(check => check.status === "degraded") ? "degraded" : "ok";
	return {
		status,
		service: "openwebui-gjc-adapter",
		checks: [...checks],
	};
}
