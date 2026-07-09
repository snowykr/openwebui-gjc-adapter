import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type JsonRecord = Record<string, unknown>;

export type Check = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
};

export type Config = {
	readonly adapterBaseUrl: string;
	readonly adapterToken: string;
	readonly openWebUIBaseUrl: string;
	readonly openWebUIToken: string;
	readonly ownerUserId: string;
	readonly realProjectDir: string;
	readonly artifactDir: string;
	readonly runId: string;
};

export type HttpJson = {
	readonly status: number;
	readonly body: unknown;
};

type HeaderMap = Record<string, string>;

export class E2EContext {
	readonly config: Config;
	readonly checks: Check[] = [];

	private constructor(config: Config) {
		this.config = config;
	}

	static async create(): Promise<E2EContext> {
		const context = new E2EContext(readConfig());
		await mkdir(context.config.artifactDir, { recursive: true });
		return context;
	}

	async getJson(url: string, headers: HeaderMap): Promise<HttpJson> {
		return await this.requestJson(url, { method: "GET", headers });
	}

	async postJson(url: string, headers: HeaderMap, body: unknown, timeoutMs = 60_000): Promise<HttpJson> {
		return await this.requestJson(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			timeoutMs,
		});
	}

	async uploadFile(filename: string, contentType: string, content: string | Uint8Array): Promise<JsonRecord> {
		const form = new FormData();
		const fileContent = typeof content === "string" ? content : arrayBufferFrom(content);
		form.append("file", new File([fileContent], filename, { type: contentType }));
		const response = await fetchWithTimeout(`${this.config.openWebUIBaseUrl}/api/v1/files/`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.config.openWebUIToken}` },
			body: form,
		});
		const body: unknown = await response.json();
		await this.writeJson(`upload-${filename}.json`, body);
		if (response.status !== 200 || !isRecord(body)) {
			throw new Error(`Upload failed (${response.status}): ${JSON.stringify(body)}`);
		}
		return body;
	}

	record(name: string, ok: boolean, detail?: string): void {
		this.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
		console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` - ${detail}`}`);
		if (!ok) throw new Error(`E2E check failed: ${name}`);
	}

	assertAllChecks(): void {
		const failed = this.checks.filter(check => !check.ok);
		if (failed.length > 0) throw new Error(`E2E failed: ${failed.map(check => check.name).join(", ")}`);
	}

	adapterHeaders(extra?: HeaderMap): HeaderMap {
		return { authorization: `Bearer ${this.config.adapterToken}`, ...extra };
	}

	openWebUIHeaders(): HeaderMap {
		return { authorization: `Bearer ${this.config.openWebUIToken}` };
	}

	openWebUIForwardHeaders(): HeaderMap {
		return {
			"x-openwebui-user-id": this.config.ownerUserId,
			"x-openwebui-user-email": "e2e@example.invalid",
			"x-openwebui-user-name": "E2E QA",
			"x-openwebui-user-role": "admin",
			"x-openwebui-chat-id": `e2e-${this.config.runId}`,
			"x-openwebui-message-id": `assistant-e2e-${this.config.runId}`,
			"x-openwebui-session-id": `e2e-${this.config.runId}`,
			"x-openwebui-user-message-id": `user-e2e-${this.config.runId}`,
			"x-openwebui-user-message-parent-id": "",
		};
	}

	async writeJson(filename: string, value: unknown): Promise<void> {
		await writeFile(path.join(this.config.artifactDir, filename), `${JSON.stringify(value, null, 2)}\n`);
	}

	private async requestJson(url: string, init: RequestInit & { readonly timeoutMs?: number }): Promise<HttpJson> {
		const response = await fetchWithTimeout(url, init, init.timeoutMs);
		const text = await response.text();
		const body: unknown = text.length === 0 ? null : JSON.parse(text);
		return { status: response.status, body };
	}
}

export function modelIdsFrom(value: unknown): readonly string[] {
	if (!isRecord(value) || !Array.isArray(value.data)) return [];
	return value.data.map(item => (isRecord(item) && typeof item.id === "string" ? item.id : "")).filter(Boolean);
}

export function importedCount(value: unknown): number {
	if (!isRecord(value) || !isRecord(value.sync) || !Array.isArray(value.sync.imported)) return 0;
	return value.sync.imported.length;
}

export function syncedSessionCount(value: unknown): number {
	if (!isRecord(value) || !isRecord(value.sync)) return 0;
	const imported = Array.isArray(value.sync.imported) ? value.sync.imported.length : 0;
	const skipped = Array.isArray(value.sync.skipped) ? value.sync.skipped.length : 0;
	return imported + skipped;
}

export function choiceText(value: unknown): string {
	if (!isRecord(value) || !Array.isArray(value.choices)) return "";
	const first = value.choices[0];
	if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") return "";
	return first.message.content;
}

export function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
	return value;
}

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function tinyPng(): Uint8Array {
	return Uint8Array.from([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12,
		2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 163, 245, 184, 0, 0, 0, 0, 73, 69,
		78, 68, 174, 66, 96, 130,
	]);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

function readConfig(): Config {
	const runId = process.env.E2E_RUN_ID ?? String(Date.now());
	const artifactDir = process.env.E2E_ARTIFACT_DIR ?? path.resolve(".omo", "runtime", `e2e-real-openwebui-${runId}`);
	return {
		adapterBaseUrl: process.env.E2E_ADAPTER_BASE_URL ?? "http://127.0.0.1:8765",
		adapterToken: requireEnv("E2E_ADAPTER_API_TOKEN"),
		openWebUIBaseUrl: process.env.E2E_OPENWEBUI_BASE_URL ?? "http://127.0.0.1:3000",
		openWebUIToken: requireEnv("E2E_OPENWEBUI_API_TOKEN"),
		ownerUserId: requireEnv("E2E_OPENWEBUI_OWNER_USER_ID"),
		realProjectDir: path.resolve(process.env.E2E_REAL_PROJECT_DIR ?? process.cwd()),
		artifactDir,
		runId,
	};
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
	return value;
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}
