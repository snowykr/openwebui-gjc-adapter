import { buildLineageHash } from "./metadata";

type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

export function buildProjectionPayloadHash(value: CanonicalJsonValue): string {
	return buildLineageHash([canonicalJson(value)]);
}

function canonicalJson(value: CanonicalJsonValue): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Projection payload hash requires finite numbers");
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(entry => canonicalJson(entry)).join(",")}]`;
	}
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
