import type { OpenWebUIChatRecord } from "./client";
import { OpenWebUIHttpConfigurationError, OpenWebUIHttpError, type OpenWebUIHttpRequest } from "./http-errors";
import { OPENWEBUI_METADATA_NAMESPACE } from "./persistence-contract";

export interface OpenWebUIFolderLookup {
	readonly id: string;
	readonly name: string;
	readonly ownerUserId?: string;
	readonly metadata: Record<string, unknown>;
}

export function openWebUIApiPath(segments: readonly string[]): string {
	return `/api/v1/${segments.map(segment => encodeURIComponent(segment)).join("/")}`;
}

export function parseOpenWebUIFolderLookup(value: unknown, request: OpenWebUIHttpRequest): OpenWebUIFolderLookup {
	if (!isRecord(value)) {
		throw new OpenWebUIHttpError({
			...request,
			status: 502,
			responseBody: "OpenWebUI folder response must be an object.",
		});
	}
	if (typeof value.id !== "string" || typeof value.name !== "string") {
		throw new OpenWebUIHttpError({
			...request,
			status: 502,
			responseBody: "OpenWebUI folder response is missing id or name.",
		});
	}
	const ownerUserId = typeof value.user_id === "string" ? value.user_id : undefined;
	return {
		id: value.id,
		name: value.name,
		metadata: recordValue(value.meta) ?? {},
		...(ownerUserId === undefined ? {} : { ownerUserId }),
	};
}

export function openWebUIChatBody(record: OpenWebUIChatRecord): Record<string, unknown> {
	return {
		title: record.title,
		metadata: record.metadata,
		meta: record.metadata,
		history: {
			currentId: record.history.currentId,
			messages: Object.fromEntries(
				Object.entries(record.history.messages).map(([id, message]) => [
					id,
					{
						...message,
						chat_id: record.id,
						owner_user_id: record.owner_user_id,
					},
				]),
			),
		},
	};
}

export function epochSeconds(value: string): number | undefined {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return undefined;
	return Math.floor(parsed / 1000);
}

export function adapterProjectId(metadata: Record<string, unknown>): string | undefined {
	const adapter = recordValue(metadata[OPENWEBUI_METADATA_NAMESPACE]);
	if (adapter === undefined) return undefined;
	if (typeof adapter.projectId === "string") return adapter.projectId;
	if (typeof adapter.project_id === "string") return adapter.project_id;
	return undefined;
}

export function ownerMatches(
	folder: OpenWebUIFolderLookup | undefined,
	ownerUserId: string,
): OpenWebUIFolderLookup | undefined {
	if (folder === undefined) return undefined;
	return folder.ownerUserId === ownerUserId ? folder : undefined;
}

export function normalizeBaseUrl(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "invalid URL";
		throw new OpenWebUIHttpConfigurationError(`GJC OpenWebUI base URL is invalid: ${detail}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new OpenWebUIHttpConfigurationError("GJC OpenWebUI base URL must use http or https.");
	}
	parsed.hash = "";
	parsed.search = "";
	return parsed.toString().replace(/\/+$/, "");
}

export function normalizeApiToken(apiToken: string): string {
	const trimmed = apiToken.trim();
	if (trimmed.length === 0) {
		throw new OpenWebUIHttpConfigurationError("GJC OpenWebUI API token must be configured.");
	}
	return trimmed;
}

export function normalizeTimeoutMs(timeoutMs: number): number {
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new OpenWebUIHttpConfigurationError("GJC OpenWebUI HTTP timeout must be a positive integer.");
	}
	return timeoutMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}
