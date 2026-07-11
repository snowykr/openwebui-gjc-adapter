import * as path from "node:path";

export type RunnerConfig = {
	readonly openWebUIBaseUrl: string;
	readonly openWebUIToken: string;
	readonly outputRoot: string;
	readonly runId: string;
};

export type HttpJson = { readonly status: number; readonly body: unknown };

export function readRunnerConfig(env: Record<string, string | undefined> = process.env): RunnerConfig {
	const openWebUIBaseUrl = requireLoopbackUrl(env.E2E_RUNNER_OPENWEBUI_BASE_URL ?? "http://127.0.0.1:3000");
	const outputRoot = requireOutputRoot(requireEnv(env, "E2E_OUTPUT_ROOT"));
	return {
		openWebUIBaseUrl,
		openWebUIToken: requireEnv(env, "E2E_OPENWEBUI_API_TOKEN"),
		outputRoot,
		runId: sanitizeRunId(requireEnv(env, "E2E_RUN_ID")),
	};
}

export async function requestJson(url: string, init: RequestInit, timeoutMs = 30_000): Promise<HttpJson> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		let body: unknown;
		try {
			body = text.length === 0 ? null : JSON.parse(text);
		} catch {
			throw new Error("E2E_INVALID_JSON_RESPONSE");
		}
		return { status: response.status, body };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw new Error("E2E_REQUEST_TIMEOUT");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export function requireOnlyGjcModel(value: unknown): void {
	const ids =
		isRecord(value) && Array.isArray(value.data)
			? value.data.map(item => (isRecord(item) ? item.id : undefined))
			: [];
	if (ids.length !== 1 || ids[0] !== "gjc") throw new Error("E2E_UNEXPECTED_MODELS");
}

export function requireProjectListCompletion(value: unknown): void {
	const text =
		isRecord(value) &&
		Array.isArray(value.choices) &&
		isRecord(value.choices[0]) &&
		isRecord(value.choices[0].message)
			? value.choices[0].message.content
			: undefined;
	if (text !== "No GJC projects are linked.") throw new Error("E2E_UNEXPECTED_COMPLETION");
}

export function redactLiterals(value: string, secrets: readonly string[]): string {
	let result = value.replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
	for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[REDACTED]");
	return result;
}

export function containsSecretLiteral(value: string, secrets: readonly string[]): boolean {
	return secrets.filter(Boolean).some(secret => value.includes(secret));
}

export function sanitizeRunId(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	if (safe.length === 0 || safe.length > 120) throw new Error("E2E_INVALID_RUN_ID");
	return safe;
}

function requireLoopbackUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("E2E_INVALID_OPENWEBUI_URL");
	}
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== "3000" || url.pathname !== "/") {
		throw new Error("E2E_OPENWEBUI_URL_MUST_BE_LOOPBACK");
	}
	return url.toString().replace(/\/$/, "");
}

function requireOutputRoot(value: string): string {
	const resolved = path.resolve(value);
	if (!path.isAbsolute(value) || resolved === path.parse(resolved).root) throw new Error("E2E_INVALID_OUTPUT_ROOT");
	return resolved;
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
