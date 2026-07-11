import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"overrides",
] as const;

type SelectedField = (typeof fields)[number] | "trustedDependencies";

type Manifest = Record<string, unknown>;

function invalid(reason: string): never {
	throw new Error(`DEPENDENCY_POLICY_INPUT_INVALID:${reason}`);
}

function canonicalObject(value: unknown, field: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`invalid-${field}`);
	return sortObject(value as Record<string, unknown>);
}

function sortObject(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => {
				if (child !== null && typeof child === "object" && !Array.isArray(child))
					return [key, sortObject(child as Record<string, unknown>)];
				return [key, child];
			}),
	);
}

function canonicalTrustedDependencies(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0))
		invalid("invalid-trustedDependencies");
	const sorted = [...value].sort();
	if (new Set(sorted).size !== sorted.length) invalid("duplicate-trustedDependencies");
	return sorted;
}

function selected(manifest: Manifest): Record<SelectedField, unknown> {
	const result = {} as Record<SelectedField, unknown>;
	for (const field of fields) result[field] = canonicalObject(manifest[field], field);
	result.trustedDependencies = canonicalTrustedDependencies(manifest.trustedDependencies);
	return result;
}

export type DependencyPolicyResult =
	| {
			readonly changedFields: SelectedField[];
			readonly lockChanged: boolean;
			readonly ok: true;
	  }
	| {
			readonly changedFields: SelectedField[];
			readonly lockChanged: true;
			readonly ok: false;
			readonly diagnostic: "DEPENDENCY_LOCK_DRIFT";
	  };

export function compareDependencyInputs(
	baseManifestText: string,
	headManifestText: string,
	baseLock: Uint8Array,
	headLock: Uint8Array,
): DependencyPolicyResult {
	let baseManifest: Manifest;
	let headManifest: Manifest;
	try {
		baseManifest = JSON.parse(baseManifestText) as Manifest;
		headManifest = JSON.parse(headManifestText) as Manifest;
	} catch {
		invalid("invalid-package-json");
	}
	if (baseManifest === null || typeof baseManifest !== "object" || Array.isArray(baseManifest))
		invalid("invalid-package-json");
	if (headManifest === null || typeof headManifest !== "object" || Array.isArray(headManifest))
		invalid("invalid-package-json");
	const base = selected(baseManifest);
	const head = selected(headManifest);
	const changedFields = (Object.keys(base) as SelectedField[]).filter(
		field => JSON.stringify(base[field]) !== JSON.stringify(head[field]),
	);
	const lockChanged = !Buffer.from(baseLock).equals(Buffer.from(headLock));
	if (changedFields.length === 0 && lockChanged) {
		return {
			changedFields,
			lockChanged,
			ok: false,
			diagnostic: "DEPENDENCY_LOCK_DRIFT",
		};
	}
	return { changedFields, lockChanged, ok: true };
}

function validSha(value: string | undefined): value is string {
	return value !== undefined && /^[0-9a-f]{40}$/.test(value);
}

if (import.meta.main) {
	try {
		const { BASE_ROOT, HEAD_ROOT, BASE_SHA, HEAD_SHA } = process.env;
		if (!BASE_ROOT || !HEAD_ROOT || !validSha(BASE_SHA) || !validSha(HEAD_SHA)) invalid("invalid-input");
		const baseHead = Bun.spawnSync(["git", "-C", BASE_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
		const headHead = Bun.spawnSync(["git", "-C", HEAD_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
		if (baseHead !== BASE_SHA || headHead !== HEAD_SHA) invalid("sha-mismatch");

		const result = compareDependencyInputs(
			readFileSync(resolve(BASE_ROOT, "package.json"), "utf8"),
			readFileSync(resolve(HEAD_ROOT, "package.json"), "utf8"),
			readFileSync(resolve(BASE_ROOT, "bun.lock")),
			readFileSync(resolve(HEAD_ROOT, "bun.lock")),
		);
		console.log(
			JSON.stringify({
				baseSha: BASE_SHA,
				headSha: HEAD_SHA,
				changedFields: result.changedFields,
				lockChanged: result.lockChanged,
			}),
		);
		if (!result.ok) {
			console.error(result.diagnostic);
			process.exit(1);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("DEPENDENCY_POLICY_INPUT_INVALID:")) {
			console.error(error.message);
			process.exit(2);
		}
		console.error("DEPENDENCY_POLICY_INPUT_INVALID:missing-file");
		process.exit(2);
	}
}
