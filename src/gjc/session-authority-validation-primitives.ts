export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).every(key => keys.includes(key));
}

export function isJsonValue(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) ? value.every(isJsonValue) : isRecord(value) && Object.values(value).every(isJsonValue))
	);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST"
	);
}
