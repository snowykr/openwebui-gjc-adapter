export function isSseChoice(value: unknown): boolean {
	if (!isRecord(value) || !Number.isSafeInteger(Reflect.get(value, "index"))) return false;
	const finish = Reflect.get(value, "finish_reason");
	return isSseDelta(Reflect.get(value, "delta")) && (finish === null || finish === "stop");
}

function isSseDelta(value: unknown): boolean {
	if (!isRecord(value) || !Object.keys(value).every(key => key === "role" || key === "content" || key === "name"))
		return false;
	const role = Reflect.get(value, "role");
	const content = Reflect.get(value, "content");
	const name = Reflect.get(value, "name");
	return (
		(role === undefined || role === "system" || role === "user" || role === "assistant" || role === "tool") &&
		(content === undefined || content === null || typeof content === "string" || isContentParts(content)) &&
		(name === undefined || typeof name === "string")
	);
}

function isContentParts(value: unknown): boolean {
	return Array.isArray(value) && value.every(isContentPart);
}

function isContentPart(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const type = Reflect.get(value, "type");
	if (type === "text") return typeof Reflect.get(value, "text") === "string";
	if (type === "image_url") return isImageUrl(Reflect.get(value, "image_url"));
	if (type !== "file") return false;
	const file = Reflect.get(value, "file");
	if (!isRecord(file)) return false;
	const optionalStrings = ["type", "id", "name", "url", "content"].every(field => {
		const fieldValue = Reflect.get(file, field);
		return fieldValue === undefined || typeof fieldValue === "string";
	});
	const documents = Reflect.get(file, "documents");
	return (
		optionalStrings &&
		Array.isArray(documents) &&
		documents.every(document => isRecord(document) && typeof Reflect.get(document, "content") === "string")
	);
}

function isImageUrl(value: unknown): boolean {
	if (typeof value === "string") return true;
	if (!isRecord(value) || typeof Reflect.get(value, "url") !== "string") return false;
	const detail = Reflect.get(value, "detail");
	return detail === undefined || typeof detail === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
