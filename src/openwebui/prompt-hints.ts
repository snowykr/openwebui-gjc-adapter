import {
	GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS,
	GJC_OPENWEBUI_PROMPT_HINT_INSTALLATION_ID_KEYS,
	GJC_OPENWEBUI_PROMPT_HINT_MARKER,
	GJC_OPENWEBUI_PROMPT_HINTS,
	isCanonicalGjcProjectAdminPromptHint,
	type OpenWebUIPromptHint,
} from "./gjc-prompt-hints";
import { OpenWebUIHttpError, type OpenWebUIHttpRequest } from "./http-errors";
import { createOpenWebUITransport, type OpenWebUITransport } from "./http-transport";
import { normalizeApiToken, normalizeBaseUrl, normalizeTimeoutMs, openWebUIApiPath } from "./http-wire";
import { OPENWEBUI_METADATA_NAMESPACE } from "./persistence-contract";

export {
	GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS,
	GJC_OPENWEBUI_PROMPT_HINT_INSTALLATION_ID_KEYS,
	GJC_OPENWEBUI_PROMPT_HINT_MARKER,
	GJC_OPENWEBUI_PROMPT_HINTS,
	isCanonicalGjcProjectAdminPromptHint,
	isGjcProjectAdminPromptCommand,
	type OpenWebUIPromptHint,
} from "./gjc-prompt-hints";

export interface OpenWebUIPromptHintClientConfig {
	readonly baseUrl: string;
	readonly apiToken: string;
	readonly timeoutMs?: number;
	/**
	 * The installation identity used for newly written prompt metadata. Existing
	 * rows that carry an identity are only considered adapter-owned when it
	 * matches this value.
	 */
	readonly installationId?: string;
}
export type OpenWebUIPromptHintMigrationFailureReason = "readback-unavailable" | "readback-mismatch";

export class OpenWebUIPromptHintMigrationError extends Error {
	readonly readbackVerified = false;
	readonly degraded = true;

	constructor(
		readonly reason: OpenWebUIPromptHintMigrationFailureReason,
		readonly mismatchCount: number,
	) {
		super(`OpenWebUI prompt hint readback verification failed (${reason}).`);
		this.name = "OpenWebUIPromptHintMigrationError";
	}
}

export interface SeedPromptHintsResult {
	readonly created: number;
	readonly updated: number;
	readonly unchanged: number;
	readonly skipped: number;
	readonly verified: true;
}

export interface OpenWebUIPromptRecord {
	readonly id: string;
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
	readonly isActive: boolean;
}

export type GjcPromptHintClassification =
	| "current-owned"
	| "legacy-owned"
	| "retained-foreign"
	| "retained-generic"
	| "ambiguous";

export interface GjcPromptHintClassificationResult {
	readonly prompt: OpenWebUIPromptRecord;
	readonly classification: GjcPromptHintClassification;
}

export interface RevokeGjcProjectAdminPromptHintsResult {
	readonly status: "ok" | "degraded";
	readonly degraded: boolean;
	readonly listed: number;
	readonly currentOwned: number;
	readonly legacyOwned: number;
	readonly revoked: number;
	readonly retained: number;
	readonly retainedForeign: number;
	readonly retainedGeneric: number;
	readonly ambiguous: number;
	readonly quarantined: number;
	readonly failed: number;
	readonly readbackVerified: boolean;
}

interface OpenWebUIPromptPage {
	readonly items: readonly OpenWebUIPromptRecord[];
	readonly total?: number;
}

interface AdapterPromptOwnership {
	readonly marker: boolean;
	readonly installationId?: string;
	readonly ambiguousInstallationId: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const OPENWEBUI_PROMPT_PAGE_SIZE = 30;
const PROMPT_INSTALLATION_ID_KEY = GJC_OPENWEBUI_PROMPT_HINT_INSTALLATION_ID_KEYS[0] ?? "installation_id";
const GJC_PROJECT_ADMIN_PROMPT_COMMANDS = new Set(GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS.map(hint => hint.command));

export class OpenWebUIPromptHintClient {
	readonly #transport: OpenWebUITransport;
	readonly #installationId: string | undefined;

	constructor(config: OpenWebUIPromptHintClientConfig) {
		this.#transport = createOpenWebUITransport({
			baseUrl: normalizeBaseUrl(config.baseUrl),
			apiToken: normalizeApiToken(config.apiToken),
			timeoutMs: normalizeTimeoutMs(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		this.#installationId = normalizeInstallationId(config.installationId);
	}

	async seedGjcPromptHints(): Promise<SeedPromptHintsResult> {
		return seedPromptHints(this.#transport, GJC_OPENWEBUI_PROMPT_HINTS, this.#installationId);
	}

	/** List every OpenWebUI prompt, including foreign and inactive rows. */
	async listPromptHints(): Promise<readonly OpenWebUIPromptRecord[]> {
		return listPrompts(this.#transport);
	}

	/** Explicit alias for callers that need to distinguish GJC's list operation. */
	async listGjcPromptHints(): Promise<readonly OpenWebUIPromptRecord[]> {
		return this.listPromptHints();
	}

	/**
	 * Remove old globally visible project-admin prompts and quarantine ambiguous
	 * marker-owned rows. The second list is mandatory: a successful mutation
	 * without a matching readback is a degraded result.
	 */
	async revokeGjcProjectAdminPromptHints(): Promise<RevokeGjcProjectAdminPromptHintsResult> {
		return revokeGjcProjectAdminPromptHints(this.#transport, this.#installationId);
	}

	/** Migration-oriented name retained alongside the explicit revoke API. */
	async migrateGjcPromptHints(): Promise<RevokeGjcProjectAdminPromptHintsResult> {
		return this.revokeGjcProjectAdminPromptHints();
	}
}

async function seedPromptHints(
	transport: OpenWebUITransport,
	hints: readonly OpenWebUIPromptHint[],
	installationId: string | undefined,
): Promise<SeedPromptHintsResult> {
	const prompts = await listPrompts(transport);
	const byCommand = new Map(prompts.map(prompt => [prompt.command, prompt]));
	const managedHints: OpenWebUIPromptHint[] = [];
	let created = 0;
	let updated = 0;
	let unchanged = 0;
	let skipped = 0;
	let mutated = false;
	for (const hint of hints) {
		const existing = byCommand.get(hint.command);
		if (existing === undefined) {
			managedHints.push(hint);
			await createPrompt(transport, hint, installationId);
			created += 1;
			mutated = true;
		} else if (!isAdapterPromptHint(existing, installationId)) {
			skipped += 1;
		} else if (promptNeedsUpdate(existing, hint, installationId)) {
			managedHints.push(hint);
			await updatePrompt(transport, existing.id, hint, installationId);
			if (!existing.isActive) {
				await togglePrompt(transport, existing.id);
			}
			updated += 1;
			mutated = true;
		} else {
			managedHints.push(hint);
			unchanged += 1;
		}
	}
	if (mutated) {
		let readback: readonly OpenWebUIPromptRecord[];
		try {
			readback = await listPrompts(transport);
		} catch {
			throw new OpenWebUIPromptHintMigrationError("readback-unavailable", managedHints.length);
		}
		const mismatchCount = verifyManagedPromptHints(readback, managedHints, installationId);
		if (mismatchCount > 0) throw new OpenWebUIPromptHintMigrationError("readback-mismatch", mismatchCount);
	}
	return { created, updated, unchanged, skipped, verified: true };
}

async function revokeGjcProjectAdminPromptHints(
	transport: OpenWebUITransport,
	installationId: string | undefined,
): Promise<RevokeGjcProjectAdminPromptHintsResult> {
	const prompts = await listPrompts(transport);
	const classifications = prompts.map(prompt => classifyGjcPromptHint(prompt, installationId));
	let currentOwned = 0;
	let legacyOwned = 0;
	let revoked = 0;
	let retainedForeign = 0;
	let retainedGeneric = 0;
	let ambiguous = 0;
	let quarantined = 0;
	let failed = 0;
	const targets = new Map<string, GjcPromptHintClassificationResult>();
	for (const result of classifications) {
		switch (result.classification) {
			case "current-owned":
				currentOwned += 1;
				targets.set(result.prompt.id, result);
				break;
			case "legacy-owned":
				legacyOwned += 1;
				targets.set(result.prompt.id, result);
				break;
			case "retained-foreign":
				retainedForeign += 1;
				break;
			case "retained-generic":
				retainedGeneric += 1;
				break;
			case "ambiguous":
				ambiguous += 1;
				targets.set(result.prompt.id, result);
				break;
		}
	}
	for (const result of targets.values()) {
		try {
			if (result.classification === "ambiguous") {
				if (result.prompt.isActive) {
					await togglePrompt(transport, result.prompt.id);
					quarantined += 1;
				} else {
					quarantined += 1;
				}
			} else {
				await deletePrompt(transport, result.prompt.id);
				revoked += 1;
			}
		} catch {
			failed += 1;
		}
	}
	let readbackVerified = false;
	try {
		const readback = await listPrompts(transport);
		const byId = new Map(readback.map(prompt => [prompt.id, prompt]));
		const canonicalTargets = [...targets.values()].filter(result => result.classification !== "ambiguous");
		const ambiguousTargets = [...targets.values()].filter(result => result.classification === "ambiguous");
		readbackVerified =
			canonicalTargets.every(result => !byId.has(result.prompt.id)) &&
			ambiguousTargets.every(result => {
				const prompt = byId.get(result.prompt.id);
				return prompt === undefined || !prompt.isActive;
			});
	} catch {
		readbackVerified = false;
	}
	const degraded = ambiguous > 0 || failed > 0 || !readbackVerified;
	return {
		status: degraded ? "degraded" : "ok",
		degraded,
		listed: prompts.length,
		currentOwned,
		legacyOwned,
		revoked,
		retained: retainedForeign + retainedGeneric,
		retainedForeign,
		retainedGeneric,
		ambiguous,
		quarantined,
		failed,
		readbackVerified,
	};
}

export function classifyGjcPromptHint(
	prompt: OpenWebUIPromptRecord,
	installationId?: string,
): GjcPromptHintClassificationResult {
	const ownership = adapterPromptOwnership(prompt);
	if (!ownership.marker) return { prompt, classification: "retained-foreign" };
	if (ownership.ambiguousInstallationId) {
		return {
			prompt,
			classification: isProjectAdminPromptCommand(prompt.command) ? "ambiguous" : "retained-generic",
		};
	}
	if (ownership.installationId !== undefined) {
		if (installationId === undefined || ownership.installationId !== installationId) {
			return { prompt, classification: "retained-foreign" };
		}
		if (isCanonicalGjcProjectAdminPromptHint(prompt)) return { prompt, classification: "current-owned" };
		if (isProjectAdminPromptCommand(prompt.command)) return { prompt, classification: "ambiguous" };
		return { prompt, classification: "retained-generic" };
	}
	if (isCanonicalGjcProjectAdminPromptHint(prompt)) return { prompt, classification: "legacy-owned" };
	if (isProjectAdminPromptCommand(prompt.command)) return { prompt, classification: "ambiguous" };
	return { prompt, classification: "retained-generic" };
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

async function createPrompt(
	transport: OpenWebUITransport,
	hint: OpenWebUIPromptHint,
	installationId: string | undefined,
): Promise<void> {
	await transport.sendJson({
		method: "POST",
		path: openWebUIApiPath(["prompts", "create"]),
		body: promptForm(hint, installationId),
	});
}

async function updatePrompt(
	transport: OpenWebUITransport,
	promptId: string,
	hint: OpenWebUIPromptHint,
	installationId: string | undefined,
): Promise<void> {
	await transport.sendJson({
		method: "POST",
		path: openWebUIApiPath(["prompts", "id", promptId, "update"]),
		body: promptForm(hint, installationId),
	});
}

async function togglePrompt(transport: OpenWebUITransport, promptId: string): Promise<void> {
	await transport.sendJson({ method: "POST", path: openWebUIApiPath(["prompts", "id", promptId, "toggle"]) });
}

async function deletePrompt(transport: OpenWebUITransport, promptId: string): Promise<void> {
	await transport.sendJson(
		{ method: "DELETE", path: openWebUIApiPath(["prompts", "id", promptId, "delete"]) },
		{ missingStatuses: [404] },
	);
}

function promptForm(hint: OpenWebUIPromptHint, installationId: string | undefined): Record<string, unknown> {
	const meta = addInstallationId(hint.meta, installationId);
	return {
		command: hint.command,
		name: hint.name,
		content: hint.content,
		tags: [...hint.tags],
		meta,
		is_production: true,
	};
}

function addInstallationId(meta: Record<string, unknown>, installationId: string | undefined): Record<string, unknown> {
	if (installationId === undefined) return meta;
	const adapter = isRecord(meta[OPENWEBUI_METADATA_NAMESPACE]) ? meta[OPENWEBUI_METADATA_NAMESPACE] : {};
	return {
		...meta,
		[OPENWEBUI_METADATA_NAMESPACE]: {
			...adapter,
			[PROMPT_INSTALLATION_ID_KEY]: installationId,
		},
	};
}
function verifyManagedPromptHints(
	prompts: readonly OpenWebUIPromptRecord[],
	hints: readonly OpenWebUIPromptHint[],
	installationId: string | undefined,
): number {
	let mismatchCount = 0;
	for (const hint of hints) {
		const expectedMeta = addInstallationId(hint.meta, installationId);
		const verified = prompts.some(
			prompt =>
				prompt.command === hint.command &&
				isAdapterPromptHint(prompt, installationId) &&
				prompt.name === hint.name &&
				prompt.content === hint.content &&
				sameStringArray(prompt.tags, hint.tags) &&
				canonicalJson(prompt.meta) === canonicalJson(expectedMeta) &&
				prompt.isActive,
		);
		if (!verified) mismatchCount += 1;
	}
	return mismatchCount;
}

function promptNeedsUpdate(
	existing: OpenWebUIPromptRecord,
	hint: OpenWebUIPromptHint,
	installationId: string | undefined,
): boolean {
	return (
		existing.name !== hint.name ||
		existing.content !== hint.content ||
		!sameStringArray(existing.tags, hint.tags) ||
		canonicalJson(existing.meta) !== canonicalJson(addInstallationId(hint.meta, installationId)) ||
		!existing.isActive
	);
}

function isAdapterPromptHint(prompt: OpenWebUIPromptRecord, installationId: string | undefined): boolean {
	const ownership = adapterPromptOwnership(prompt);
	return (
		ownership.marker &&
		!ownership.ambiguousInstallationId &&
		(ownership.installationId === undefined ||
			(installationId !== undefined && ownership.installationId === installationId))
	);
}

function isProjectAdminPromptCommand(command: string): boolean {
	return GJC_PROJECT_ADMIN_PROMPT_COMMANDS.has(command);
}
function adapterPromptOwnership(prompt: OpenWebUIPromptRecord): AdapterPromptOwnership {
	const adapter = prompt.meta[OPENWEBUI_METADATA_NAMESPACE];
	if (!isRecord(adapter) || adapter[GJC_OPENWEBUI_PROMPT_HINT_MARKER] !== true) {
		return { marker: false, ambiguousInstallationId: false };
	}
	const ids = GJC_OPENWEBUI_PROMPT_HINT_INSTALLATION_ID_KEYS.filter(key => Object.hasOwn(adapter, key)).map(key => {
		const value = adapter[key];
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
	});
	const distinctIds = [...new Set(ids.filter((value): value is string => value !== null))];
	const hasInvalidId = ids.some(value => value === null);
	return {
		marker: true,
		...(distinctIds[0] === undefined ? {} : { installationId: distinctIds[0] }),
		ambiguousInstallationId: hasInvalidId || distinctIds.length > 1,
	};
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

function normalizeInstallationId(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized === undefined || normalized.length === 0 ? undefined : normalized;
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

/** Legacy adapter-owned suggestion to remove without changing foreign OpenWebUI suggestions. */
export const GJC_LEGACY_PROMPT_SUGGESTION: OpenWebUIPromptSuggestion = {
	title: ["GJC"],
	content: "Use the GJC coding agent to work on this project.",
};

export function promptHintsFromConfig(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const config = value as { default_prompt_suggestions?: unknown };
	return Object.hasOwn(config, "default_prompt_suggestions") ? config.default_prompt_suggestions : [];
}

export function removeLegacyPromptHint(existing: unknown): OpenWebUIPromptHintsPayload | undefined {
	if (!Array.isArray(existing)) return undefined;
	const suggestions = existing.filter(isPromptSuggestion);
	if (suggestions.length !== existing.length) return undefined;
	return {
		suggestions: suggestions.filter(
			suggestion => JSON.stringify(suggestion) !== JSON.stringify(GJC_LEGACY_PROMPT_SUGGESTION),
		),
	};
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
