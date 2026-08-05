import { buildOpenWebUIAuthDiagnostic } from "./adapter-openwebui-options";
import { type AdapterConfig, buildStartupDiagnostics } from "./config";
import type { AdapterHealthCheck } from "./health";

export interface RuntimeIsolationDiagnostic {
	readonly name:
		| "session-authority-migration"
		| "openwebui-prompt-hints"
		| "openwebui-project-projection"
		| "openwebui-projection-outbox";
	readonly status: "ok" | "degraded";
	/** Sanitized status only: never include credentials, prompt bodies, or raw user IDs. */
	readonly detail: string;
}

export function buildRuntimeHealthChecks(
	config: AdapterConfig,
	isolationDiagnostics: readonly RuntimeIsolationDiagnostic[] = [],
): AdapterHealthCheck[] {
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
		...isolationDiagnostics.map(diagnostic => ({
			name: diagnostic.name,
			status: diagnostic.status,
			detail: diagnostic.detail,
		})),
	];
}
