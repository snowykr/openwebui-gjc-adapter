import { GJC_OPENWEBUI_PROMPT_HINTS, type OpenWebUIPromptHint } from "./gjc-prompt-hints";
import { OpenWebUIHttpError, type OpenWebUIHttpRequest } from "./http-errors";
import { createOpenWebUITransport, type OpenWebUITransport } from "./http-transport";
import { normalizeApiToken, normalizeBaseUrl, normalizeTimeoutMs, openWebUIApiPath } from "./http-wire";
import { OPENWEBUI_METADATA_NAMESPACE } from "./persistence-contract";

export { GJC_OPENWEBUI_PROMPT_HINTS, type OpenWebUIPromptHint } from "./gjc-prompt-hints";

export interface OpenWebUIPromptHintClientConfig {
	readonly baseUrl: string;
	readonly apiToken: string;
	readonly timeoutMs?: number;
}

export interface SeedPromptHintsResult {
	readonly created: number;
	readonly updated: number;
	readonly unchanged: number;
	readonly skipped: number;
}

interface OpenWebUIPromptRecord {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
	readonly isActive: boolean;
}

interface OpenWebUIPromptPage {
	readonly items: readonly OpenWebUIPromptRecord[];
	readonly total?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const OPENWEBUI_PROMPT_PAGE_SIZE = 30;

export class OpenWebUIPromptHintClient {
	readonly #transport: OpenWebUITransport;

	constructor(config: OpenWebUIPromptHintClientConfig) {
		this.#transport = createOpenWebUITransport({
			baseUrl: normalizeBaseUrl(config.baseUrl),
			apiToken: normalizeApiToken(config.apiToken),
			timeoutMs: normalizeTimeoutMs(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
	}

	async seedGjcPromptHints(): Promise<SeedPromptHintsResult> {
		return seedPromptHints(this.#transport, GJC_OPENWEBUI_PROMPT_HINTS);
	}
}

async function seedPromptHints(
	transport: OpenWebUITransport,
	hints: readonly OpenWebUIPromptHint[],
): Promise<SeedPromptHintsResult> {
	const prompts = await listPrompts(transport);
	const byCommand = new Map(prompts.map(prompt => [prompt.command, prompt]));
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	let skipped = 0;
	for (const hint of hints) {
		const existing = byCommand.get(hint.command);
		if (existing === undefined) {
			await createPrompt(transport, hint);
			created += 1;
		} else if (!isAdapterPromptHint(existing)) {
			skipped += 1;
		} else if (promptNeedsUpdate(existing, hint)) {
			await updatePrompt(transport, existing.id, hint);
			if (!existing.isActive) await togglePrompt(transport, existing.id);
			updated += 1;
		} else {
			unchanged += 1;
		}
	}
	return { created, updated, unchanged, skipped };
}

async function listPrompts(transport: OpenWebUITransport): Promise<readonly OpenWebUIPromptRecord[]> {
	const prompts: OpenWebUIPromptRecord[] = [];
	for (let pageNumber = 1; ; pageNumber += 1) {
		const request = { method: "GET", path: `${openWebUIApiPath(["prompts", "list"])}?page=${pageNumber}` } as const;
		const response = await transport.sendJson(request);
		const page = parsePromptPage(response, request);
		prompts.push(...page.items);
		if (
			page.items.length === 0 ||
			page.items.length < OPENWEBUI_PROMPT_PAGE_SIZE ||
			(page.total !== undefined && prompts.length >= page.total)
		) {
			break;
		}
	}
	return prompts;
}

async function createPrompt(transport: OpenWebUITransport, hint: OpenWebUIPromptHint): Promise<void> {
	await transport.sendJson({
		method: "POST",
		path: openWebUIApiPath(["prompts", "create"]),
		body: promptForm(hint),
	});
}

async function updatePrompt(transport: OpenWebUITransport, promptId: string, hint: OpenWebUIPromptHint): Promise<void> {
	await transport.sendJson({
		method: "POST",
		path: openWebUIApiPath(["prompts", "id", promptId, "update"]),
		body: promptForm(hint),
	});
}

async function togglePrompt(transport: OpenWebUITransport, promptId: string): Promise<void> {
	await transport.sendJson({ method: "POST", path: openWebUIApiPath(["prompts", "id", promptId, "toggle"]) });
}

function promptForm(hint: OpenWebUIPromptHint): Record<string, unknown> {
	return {
		command: hint.command,
		name: hint.name,
		content: hint.content,
		tags: [...hint.tags],
		meta: hint.meta,
		is_production: true,
	};
}

function promptNeedsUpdate(existing: OpenWebUIPromptRecord, hint: OpenWebUIPromptHint): boolean {
	return (
		existing.name !== hint.name ||
		existing.content !== hint.content ||
		!sameStringArray(existing.tags, hint.tags) ||
		canonicalJson(existing.meta) !== canonicalJson(hint.meta) ||
		!existing.isActive
	);
}

function isAdapterPromptHint(prompt: OpenWebUIPromptRecord): boolean {
	const adapter = prompt.meta[OPENWEBUI_METADATA_NAMESPACE];
	return isRecord(adapter) && adapter.prompt_hint === true;
}

function parsePromptPage(value: unknown, request: OpenWebUIHttpRequest): OpenWebUIPromptPage {
	let items: readonly unknown[];
	let total: number | undefined;
	if (Array.isArray(value)) {
		items = value;
		total = items.length;
	} else if (isRecord(value) && Array.isArray(value.items)) {
		items = value.items;
		if (typeof value.total === "number" && Number.isInteger(value.total) && value.total >= 0) total = value.total;
	} else {
		throwBadPromptResponse(request, "OpenWebUI prompt list response must be an array or paged object.");
	}
	return { items: items.map(item => parsePromptRecord(item, request)), ...(total === undefined ? {} : { total }) };
}

function parsePromptRecord(value: unknown, request: OpenWebUIHttpRequest): OpenWebUIPromptRecord {
	if (!isRecord(value)) throwBadPromptResponse(request, "OpenWebUI prompt response item must be an object.");
	if (typeof value.id !== "string" || typeof value.command !== "string") {
		throwBadPromptResponse(request, "OpenWebUI prompt response item is missing id or command.");
	}
	return {
		id: value.id,
		command: value.command,
		name: typeof value.name === "string" ? value.name : "",
		content: typeof value.content === "string" ? value.content : "",
		tags: arrayOfStrings(value.tags),
		meta: isRecord(value.meta) ? value.meta : {},
		isActive: value.is_active !== false,
	};
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((item, index) => item === right[index]);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function arrayOfStrings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwBadPromptResponse(request: OpenWebUIHttpRequest, responseBody: string): never {
	throw new OpenWebUIHttpError({ ...request, status: 502, responseBody });
}
/** Contract pinned to OpenWebUI v0.10's backend/open_webui/routers/configs.py. */
export const OPENWEBUI_PROMPT_HINTS_ENDPOINT = "/api/v1/configs/suggestions";
export const OPENWEBUI_CONFIG_ENDPOINT = "/api/config";
export const OPENWEBUI_PROMPT_HINTS_CONTRACT = "openwebui-v0.10-configs-suggestions" as const;

export interface OpenWebUIPromptSuggestion {
	readonly title: readonly string[];
	readonly content: string;
}

export interface OpenWebUIPromptHintsPayload {
	readonly suggestions: readonly OpenWebUIPromptSuggestion[];
}

/** Adapter-owned suggestions are deliberately version-scoped and contain no credentials. */
export const GJC_PROMPT_HINTS_PAYLOAD: OpenWebUIPromptHintsPayload = {
	suggestions: [
		{
			title: ["GJC"],
			content: "Use the GJC coding agent to work on this project.",
		},
	],
};

export function promptHintsPayloadMatches(value: unknown): boolean {
	return JSON.stringify(value) === JSON.stringify(GJC_PROMPT_HINTS_PAYLOAD);
}

export function promptHintsFromConfig(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return (value as { default_prompt_suggestions?: unknown }).default_prompt_suggestions;
}

export function mergePromptHints(existing: unknown): OpenWebUIPromptHintsPayload | undefined {
	if (!Array.isArray(existing)) return undefined;
	const suggestions = existing.filter(isPromptSuggestion);
	if (suggestions.length !== existing.length) return undefined;
	const ownedTitle = GJC_PROMPT_HINTS_PAYLOAD.suggestions[0]?.title;
	const replacement = GJC_PROMPT_HINTS_PAYLOAD.suggestions[0];
	const ownedIndex = suggestions.findIndex(
		suggestion => JSON.stringify(suggestion.title) === JSON.stringify(ownedTitle),
	);
	if (ownedIndex === -1) return { suggestions: [...suggestions, replacement] };
	return { suggestions: suggestions.map((suggestion, index) => (index === ownedIndex ? replacement : suggestion)) };
}

function isPromptSuggestion(value: unknown): value is OpenWebUIPromptSuggestion {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const suggestion = value as { title?: unknown; content?: unknown };
	return (
		Array.isArray(suggestion.title) &&
		suggestion.title.every(item => typeof item === "string") &&
		typeof suggestion.content === "string"
	);
}
