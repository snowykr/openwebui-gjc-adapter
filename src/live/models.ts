import { GJC_THINKING_LEVELS, type GjcThinkingLevel, type NormalizedModelSelection } from "../contracts";
import type { OpenAIModelEntry, OpenAIModelListResponse } from "./openai-types";

export type LiveGatewayModelEntry = OpenAIModelEntry;
export type GjcModelIdClassification =
	| { readonly kind: "alias" }
	| { readonly kind: "canonical"; readonly selection: NormalizedModelSelection }
	| { readonly kind: "malformed" }
	| { readonly kind: "foreign" };

const RFC3986_EXTRA = /[!'()*]/g;
const HEX_ESCAPE = /%[0-9a-fA-F]{2}/;
const CONTROL_OR_WHITESPACE = /[\p{Cc}\p{White_Space}]/u;
const textEncoder = new TextEncoder();

export function buildModelList(input: readonly unknown[] = []): OpenAIModelListResponse {
	const selections = input.flatMap(decodeNormalizedSelection);
	return {
		object: "list",
		data: selections.map(selection => ({
			id: formatCanonicalModelId(selection),
			object: "model",
			created: 1783468800,
			owned_by: "gjc",
		})),
	};
}

function decodeNormalizedSelection(input: unknown): readonly NormalizedModelSelection[] {
	if (!isRecord(input)) return [];
	const provider = Reflect.get(input, "provider");
	const modelId = Reflect.get(input, "modelId");
	const thinkingLevel = Reflect.get(input, "thinkingLevel");
	if (
		typeof provider !== "string" ||
		typeof modelId !== "string" ||
		!isSafeProvider(provider) ||
		!isSafeComponent(modelId) ||
		!isThinkingLevel(thinkingLevel)
	) {
		return [];
	}
	return [{ provider, modelId, thinkingLevel }];
}

export function formatCanonicalModelId(selection: NormalizedModelSelection): string {
	if (!isSafeProvider(selection.provider)) throw new TypeError("Invalid GJC model provider");
	const provider = encodeComponent(selection.provider);
	const modelId = encodeComponent(selection.modelId);
	return `gjc/${provider}/${modelId}:${selection.thinkingLevel}`;
}

export function parseCanonicalModelId(value: unknown): NormalizedModelSelection | null {
	if (typeof value !== "string" || !value.startsWith("gjc/")) return null;
	const body = value.slice(4);
	const slash = body.indexOf("/");
	if (slash <= 0 || slash !== body.lastIndexOf("/")) return null;
	const encodedProvider = body.slice(0, slash);
	const modelAndThinking = body.slice(slash + 1);
	const colon = modelAndThinking.lastIndexOf(":");
	if (colon <= 0 || colon !== modelAndThinking.indexOf(":")) return null;
	const encodedModel = modelAndThinking.slice(0, colon);
	const thinkingLevel = modelAndThinking.slice(colon + 1);
	if (!isThinkingLevel(thinkingLevel)) return null;
	const provider = decodeCanonicalComponent(encodedProvider);
	const modelId = decodeCanonicalComponent(encodedModel);
	if (provider === null || !isSafeProvider(provider) || modelId === null) return null;
	return { provider, modelId, thinkingLevel };
}

export function classifyGjcModelId(value: string): GjcModelIdClassification {
	if (value === "gjc") return { kind: "alias" };
	const selection = parseCanonicalModelId(value);
	if (selection !== null) return { kind: "canonical", selection };
	return value.startsWith("gjc") ? { kind: "malformed" } : { kind: "foreign" };
}

export function decodeModelCatalog(input: unknown): readonly NormalizedModelSelection[] {
	return decodeStrictModelCatalog(input) ?? [];
}

export function decodeStrictModelCatalog(input: unknown): readonly NormalizedModelSelection[] | null {
	if (!Array.isArray(input)) return null;
	const selections: NormalizedModelSelection[] = [];
	for (const descriptor of input) {
		const decoded = decodeDescriptor(descriptor);
		if (decoded === null) return null;
		selections.push(...decoded);
	}
	const unique = new Map<string, NormalizedModelSelection>();
	for (const selection of selections) unique.set(formatCanonicalModelId(selection), selection);
	return [...unique.values()].sort(compareSelections);
}

function decodeDescriptor(input: unknown): readonly NormalizedModelSelection[] | null {
	if (!isRecord(input)) return null;
	const provider = Reflect.get(input, "provider");
	const modelId = Reflect.get(input, "id");
	const reasoning = Reflect.get(input, "reasoning");
	if (typeof provider !== "string" || typeof modelId !== "string" || typeof reasoning !== "boolean") return null;
	if (!isSafeProvider(provider) || !isSafeComponent(modelId)) return null;
	const thinking = Reflect.get(input, "thinking");
	if (!isRecord(thinking)) return null;
	const levels = decodeThinkingDescriptor(thinking, reasoning);
	if (levels === null) return null;
	return levels.map(thinkingLevel => ({ provider, modelId, thinkingLevel }));
}

function decodeThinkingDescriptor(
	input: Readonly<Record<PropertyKey, unknown>>,
	reasoning: boolean,
): readonly GjcThinkingLevel[] | null {
	const levels = Reflect.get(input, "validLevels");
	if (!Array.isArray(levels) || levels.length === 0 || !levels.every(isThinkingLevel)) return null;
	const canonical = GJC_THINKING_LEVELS.filter(level => levels.includes(level));
	if (canonical.length !== levels.length || canonical.some((level, index) => level !== levels[index])) return null;
	if (reasoning) return levels.length > 1 && levels[0] === "off" ? levels : null;
	return levels.length === 1 && levels[0] === "off" ? levels : null;
}

function encodeComponent(value: string): string {
	if (!isSafeComponent(value)) throw new TypeError("Invalid GJC model component");
	return encodeURIComponent(value).replace(
		RFC3986_EXTRA,
		character => `%${character.codePointAt(0)?.toString(16).toUpperCase().padStart(2, "0")}`,
	);
}

function decodeCanonicalComponent(value: string): string | null {
	try {
		const decoded = decodeURIComponent(value);
		if (!isSafeComponent(decoded) || encodeComponent(decoded) !== value) return null;
		return decoded;
	} catch (error) {
		if (error instanceof URIError) return null;
		throw error;
	}
}

function isSafeComponent(value: string): boolean {
	return (
		value.length > 0 &&
		!CONTROL_OR_WHITESPACE.test(value) &&
		!HEX_ESCAPE.test(value) &&
		!value.split("/").some(segment => segment === "." || segment === "..")
	);
}

function isSafeProvider(value: string): boolean {
	return isSafeComponent(value) && !value.includes("/");
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is GjcThinkingLevel {
	return typeof value === "string" && GJC_THINKING_LEVELS.some(level => level === value);
}

function compareSelections(left: NormalizedModelSelection, right: NormalizedModelSelection): number {
	return (
		compareUtf8(left.provider, right.provider) ||
		compareUtf8(left.modelId, right.modelId) ||
		thinkingRank(left.thinkingLevel) - thinkingRank(right.thinkingLevel)
	);
}

function compareUtf8(left: string, right: string): number {
	const leftBytes = textEncoder.encode(left);
	const rightBytes = textEncoder.encode(right);
	for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftBytes.length - rightBytes.length;
}

function thinkingRank(level: GjcThinkingLevel): number {
	return GJC_THINKING_LEVELS.indexOf(level);
}
