import type { AdapterReadinessOptions } from "./health";
import {
	mergePromptHints,
	OPENWEBUI_CONFIG_ENDPOINT,
	OPENWEBUI_PROMPT_HINTS_ENDPOINT,
	promptHintsFromConfig,
} from "./openwebui/prompt-hints";

export interface AdapterRuntimeConfig {
	/** The token OpenWebUI presents to the adapter provider. */
	readonly adapterToken: string;
	/** A distinct token used only by the readiness probe. */
	readonly readinessToken: string;
	/** Non-secret state recorded by the authenticated setup flow. */
	readonly readiness?: AdapterReadinessOptions;
	/** Runtime OpenWebUI peer URL used for bounded startup authentication. */
	readonly openWebUIBaseUrl?: string;
	/** Persisted OpenWebUI API token; never included in responses or diagnostics. */
	readonly openWebUIApiToken?: string;
	readonly initialize?: () => Promise<void>;
}

/** Validates the persisted token and reconciles config-suggestion hints without exposing credentials. */
export async function initializeRuntimeReadiness(runtime: AdapterRuntimeConfig): Promise<AdapterReadinessOptions> {
	if (!runtime.openWebUIApiToken?.trim())
		return {
			...(runtime.readiness ?? {}),
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI API token is missing",
		};
	if (!runtime.openWebUIBaseUrl?.trim())
		return {
			...(runtime.readiness ?? {}),
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI runtime URL is not configured",
		};

	const baseUrl = runtime.openWebUIBaseUrl.trim().replace(/\/+$/, "");
	let result: AdapterReadinessOptions = {
		...(runtime.readiness ?? {}),
		openWebUIAuthenticated: false,
		promptHintsSeeded: false,
	};
	for (let attempt = 0; attempt < 3; attempt += 1) {
		result = await initializeRuntimeReadinessAttempt(baseUrl, runtime.openWebUIApiToken, result);
		if (result.openWebUIAuthenticated && result.promptHintsSeeded) {
			try {
				await runtime.initialize?.();
				return result;
			} catch {
				result = {
					...result,
					promptHintsSeeded: false,
					reason: "OpenWebUI runtime initialization is pending",
				};
			}
		}
		if (attempt < 2) await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 100 : 250));
	}
	return result;
}

async function initializeRuntimeReadinessAttempt(
	baseUrl: string,
	token: string,
	fallback: AdapterReadinessOptions,
): Promise<AdapterReadinessOptions> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2_000);
	try {
		const authResponse = await fetch(`${baseUrl}/api/v1/auths/`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!authResponse.ok)
			return {
				...fallback,
				openWebUIAuthenticated: false,
				promptHintsSeeded: false,
				reason: "OpenWebUI API token was rejected",
			};
		const authUser: unknown = await authResponse.json();
		if (!hasAuthenticatedUserId(authUser))
			return {
				...fallback,
				openWebUIAuthenticated: false,
				promptHintsSeeded: false,
				reason: "OpenWebUI authentication response was invalid",
			};

		const configResponse = await fetch(`${baseUrl}${OPENWEBUI_CONFIG_ENDPOINT}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!configResponse.ok)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint read was not verified",
			};
		let config: unknown;
		try {
			config = await configResponse.json();
		} catch {
			config = undefined;
		}
		const payload = mergePromptHints(promptHintsFromConfig(config));
		if (payload === undefined)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint read was invalid",
			};

		const seedResponse = await fetch(`${baseUrl}${OPENWEBUI_PROMPT_HINTS_ENDPOINT}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!seedResponse.ok)
			return {
				...fallback,
				openWebUIAuthenticated: true,
				promptHintsSeeded: false,
				reason: "OpenWebUI prompt-hint seed was not verified",
			};
		let readback: unknown;
		try {
			readback = await seedResponse.json();
		} catch {
			readback = undefined;
		}
		const seeded = JSON.stringify(readback) === JSON.stringify(payload.suggestions);
		return {
			...fallback,
			openWebUIAuthenticated: true,
			promptHintsSeeded: seeded,
			...(seeded ? {} : { reason: "OpenWebUI prompt-hint readback did not match the merged seed" }),
		};
	} catch {
		return {
			...fallback,
			openWebUIAuthenticated: false,
			promptHintsSeeded: false,
			reason: "OpenWebUI authentication or prompt-hint probe failed",
		};
	} finally {
		clearTimeout(timeout);
	}
}

function hasAuthenticatedUserId(value: unknown): boolean {
	if (Array.isArray(value)) return hasAuthenticatedUserId(value[0]);
	if (typeof value !== "object" || value === null) return false;
	const id = Reflect.get(value, "id");
	return typeof id === "string" && id.trim().length > 0;
}

export function createRuntimeReadinessReconciler(
	runtime: AdapterRuntimeConfig,
	state: AdapterReadinessOptions,
): () => Promise<void> {
	let inFlight: Promise<void> | undefined;
	let retryCount = 0;
	let retryAt = 0;
	const ready = (): boolean => state.openWebUIAuthenticated === true && state.promptHintsSeeded === true;
	return () => {
		if (ready() || inFlight !== undefined || Date.now() < retryAt) return inFlight ?? Promise.resolve();
		inFlight = initializeRuntimeReadiness(runtime)
			.then(next => Object.assign(state, next))
			.catch(() =>
				Object.assign(state, {
					openWebUIAuthenticated: false,
					promptHintsSeeded: false,
					reason: "OpenWebUI runtime reconciliation failed",
				}),
			)
			.then(() => {
				if (ready()) {
					retryCount = 0;
					retryAt = 0;
				} else {
					retryAt = Date.now() + Math.min(2_000, 100 * 2 ** retryCount);
					retryCount += 1;
				}
			})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};
}
