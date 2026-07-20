import { buildOpenWebUIAuthDiagnostic } from "./adapter-openwebui-options";
import { type AdapterConfig, buildStartupDiagnostics } from "./config";
import type { AdapterHealthCheck } from "./health";

export function buildRuntimeHealthChecks(config: AdapterConfig): AdapterHealthCheck[] {
	const configDiagnostic = buildStartupDiagnostics(config);
	const authDiagnostic = buildOpenWebUIAuthDiagnostic(config);
	return [
		{ name: "config", status: configDiagnostic.status, detail: configDiagnostic.messages.join(" ") },
		{ name: "openwebui-auth", status: authDiagnostic.status, detail: authDiagnostic.messages.join(" ") },
		{
			name: "gjc-live-runner",
			status: "ok",
			detail: "GJC live runner is wired to the authenticated SDK v3 turn runner.",
		},
	];
}
